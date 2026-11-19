import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { generateProfilingSQL, readDefinitionsSQL } from '../src/generate-sql';
import { openFixture } from './fixture';

test('new macros in existing and new category files join the profile automatically', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'data-profiling-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(resolve('sql'), directory, { recursive: true });
  appendFileSync(join(directory, 'metrics', 'table.sql'), `
    CREATE OR REPLACE MACRO data_profiling_twice_row_count() AS
      data_profiling_value('integer', (count(*) * 2)::VARCHAR);
  `);
  writeFileSync(join(directory, 'metrics', 'present.sql'), `
    CREATE OR REPLACE MACRO data_profiling_fixture_present_count(column_value) AS
      data_profiling_present_count(column_value);
  `);
  const definitions = readDefinitionsSQL(directory);
  const sql = await generateProfilingSQL(definitions);
  const connection = await openFixture(t);
  await connection.run(sql);
  await connection.run(`
    CREATE SCHEMA profiling_test;
    CREATE TABLE profiling_test.input (amount INTEGER, "quote'名" VARCHAR);
    INSERT INTO profiling_test.input VALUES (1, NULL), (NULL, 'x'), (NULL, '');
    CREATE VIEW profiling_test.empty AS SELECT * FROM profiling_test.input WHERE false;
  `);
  for (const empty of [false, true]) {
    const table = empty ? 'profiling_test.empty' : 'profiling_test.input';
    const result = await connection.runAndReadAll(
      'SELECT * FROM data_profiling(?) ORDER BY metric, columns', [table],
    );
    const rows = result.getRowObjectsJson();
    assert.ok(rows.every((row) => row.protocol_version === 1 && row.table_name === table && row.parameters === '{}'));
    assert.deepEqual(rows.map(({ columns, metric, value }) => [columns, metric, JSON.parse(value as string)]), [
      [[], 'column_count', { type: 'integer', value: '2' }],
      [['amount'], 'fixture_present_count', { type: 'integer', value: empty ? '0' : '1' }],
      [["quote'名"], 'fixture_present_count', { type: 'integer', value: empty ? '0' : '2' }],
      [['amount'], 'missing_count', { type: 'integer', value: empty ? '0' : '2' }],
      [["quote'名"], 'missing_count', { type: 'integer', value: empty ? '0' : '1' }],
      [['amount'], 'present_count', { type: 'integer', value: empty ? '0' : '1' }],
      [["quote'名"], 'present_count', { type: 'integer', value: empty ? '0' : '2' }],
      [[], 'row_count', { type: 'integer', value: empty ? '0' : '3' }],
      [[], 'twice_row_count', { type: 'integer', value: empty ? '0' : '6' }],
    ]);
  }
});

test('metadata-only profiles keep their result on empty inputs', async (t) => {
  const definitions = `
    CREATE MACRO data_profiling_width(table_name) AS (
      SELECT json_object('type', 'integer', 'value', count(*)::VARCHAR)
      FROM pragma_table_info(table_name)
    );
  `;
  const sql = await generateProfilingSQL(definitions);
  const connection = await openFixture(t);
  await connection.run(sql);
  await connection.run('CREATE TABLE empty_input (x INTEGER)');
  const rows = (await connection.runAndReadAll("SELECT * FROM data_profiling('empty_input')")).getRowObjectsJson();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metric, 'width');
  assert.deepEqual(JSON.parse(rows[0].value as string), { type: 'integer', value: '1' });
});

test('unsupported macro signatures fail generation instead of silently omitting a metric', async () => {
  await assert.rejects(generateProfilingSQL('CREATE MACRO data_profiling_bad(value, extra) AS value;'),
    /Unsupported parameters for data_profiling_bad/);
  await assert.rejects(generateProfilingSQL('CREATE MACRO data_profiling_bad() AS TABLE SELECT 1;'),
    /Unsupported metric macro: data_profiling_bad/);
});
