import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  createProfilingPlan,
  createProfilingSQL,
  type MetricConfig,
  type ProfileColumn,
  type ProfileRow,
} from 'data_profiling';
import { openFixture, columns } from './fixture';

const decode = (rows: ProfileRow[]) =>
  rows.map((row) => ({
    ...row,
    parameters: JSON.parse(row.parameters),
    value: JSON.parse(row.value),
  }));

test('schema-directed SQL matches the macro protocol across input types and empty tables', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE TYPE category AS ENUM ('z', 'a');
    CREATE TABLE precise AS SELECT
      '9007199254740993'::BIGINT i, '12345678901234567890.123456789'::DECIMAL(38,9) d,
      DATE '1000000-01-01' dt, TIMESTAMP_NS '1969-12-31 23:59:59.999999999' ns,
      TIMESTAMPTZ '2026-11-20 12:00:00.123456+08' tz,
      [1,2] a, {a: 1} s, map(['a'],[1]) m, 'x'::BLOB b, '1'::JSON j;
    CREATE TABLE special AS SELECT * FROM (VALUES
      ('NaN'::DOUBLE, 'infinity'::DATE, 'z'::category), ('Infinity', '-infinity', 'a'),
      ('-Infinity', NULL, NULL), (2, DATE '2026-11-20', NULL)) t(n,d,e);
    CREATE TABLE nulls (n DOUBLE, s VARCHAR, b BOOLEAN, d DATE);
    CREATE VIEW empty_input AS SELECT * FROM nulls WHERE false;
    INSERT INTO nulls VALUES (NULL,NULL,NULL,NULL);
  `);
  for (const table of ['sample', 'precise', 'special', 'nulls', 'empty_input']) {
    const schema = (
      await connection.runAndReadAll('SELECT name, type FROM pragma_table_info(?)', [table])
    ).getRowObjectsJson() as ProfileColumn[];
    const sql = createProfilingSQL(table, schema);
    assert.ok(!sql.includes('data_profiling_'));
    assert.ok(!/list_aggregate|list\("/.test(sql));
    const expected = (
      await connection.runAndReadAll('SELECT * FROM data_profiling(?) ORDER BY columns, metric', [table])
    ).getRowObjectsJson() as ProfileRow[];
    const actual = (
      await connection.runAndReadAll(`SELECT * FROM (${sql}) ORDER BY columns, metric`)
    ).getRowObjectsJson() as ProfileRow[];
    assert.deepEqual(decode(actual), decode(expected), table);
    const plan = createProfilingPlan(table, schema);
    const row = (await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0];
    const sort = (results: ReturnType<typeof plan.decode>) =>
      results.sort((a, b) =>
        JSON.stringify([a.columns, a.metric]).localeCompare(JSON.stringify([b.columns, b.metric]))
      );
    assert.deepEqual(sort(plan.decode(row)), sort(decode(expected)), `${table} native transport`);
  }
});

test('native SQL supports column/metric selection and last-configuration semantics', async (t) => {
  const connection = await openFixture(t);
  const schema = Object.entries(columns).map(([name, type]) => ({ name, type }));
  for (const [metrics, expected] of [
    [[], []],
    [
      ['min', 'sum'],
      ['min', 'sum'],
    ],
    [[{ id: 'top_values', limit: 0, maxDistinctRatio: 1 }], ['top_values']],
    [
      [
        { id: 'top_values', maxDistinctRatio: 1 },
        { id: 'top_values', maxDistinctRatio: 0 },
      ],
      [],
    ],
    [[{ id: 'top_values', limit: Number.MAX_SAFE_INTEGER, maxDistinctRatio: 1 }], ['top_values']],
  ] as [MetricConfig[], string[]][]) {
    const selected = schema.filter(({ name }) => name === (metrics[0] === 'min' ? 'amount' : 'channel'));
    const sql = createProfilingSQL('sample', selected, { metrics });
    const rows = decode((await connection.runAndReadAll(sql)).getRowObjectsJson() as ProfileRow[]);
    assert.deepEqual(
      rows.map(({ metric }) => metric),
      expected
    );
    const plan = createProfilingPlan('sample', selected, { metrics });
    if (plan.metrics.length) {
      const raw = (await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0];
      assert.deepEqual(plan.decode(raw), rows);
    } else assert.deepEqual(plan.decode({}), []);
    if (rows.length && rows[0].metric === 'top_values') {
      assert.equal(rows[0].parameters.maxDistinctRatio, 1);
      assert.equal(rows[0].parameters.limit, typeof metrics[0] === 'string' ? undefined : metrics[0].limit);
    }
  }
});

test('native plans reject missing or lossy transport values', () => {
  const plan = createProfilingPlan('sample', [], { metrics: ['row_count'] });
  assert.throws(() => plan.decode({}), /Missing aggregate/);
  assert.throws(() => plan.decode({ [plan.metrics[0].alias]: Number.MAX_SAFE_INTEGER + 1 }), /lossy integer/);
  assert.deepEqual(plan.decode({ [plan.metrics[0].alias]: '9007199254740993' })[0].value, {
    type: 'integer',
    value: '9007199254740993',
  });
});

test('native sum streams large inputs within a small memory budget without registering macros', async (t) => {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '16MB' });
  const connection = await instance.connect();
  t.after(() => {
    connection.closeSync();
    instance.closeSync();
  });
  await connection.run('CREATE VIEW numbers AS SELECT i AS n FROM range(5000000) t(i)');
  const plan = createProfilingPlan('numbers', [{ name: 'n', type: 'BIGINT' }], { metrics: ['sum'] });
  assert.doesNotMatch(plan.sql, /list\(|list_aggregate|data_profiling_/i);
  const row = (await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0];
  assert.deepEqual(plan.decode(row)[0].value, { type: 'integer', value: '12499997500000' });
});

test('a prepared native plan recomputes results after data changes', async (t) => {
  const connection = await openFixture(t);
  const plan = createProfilingPlan('sample', [{ name: 'complete', type: 'INTEGER' }], {
    metrics: ['row_count', 'sum'],
  });
  const statement = await connection.prepare(plan.sql);
  try {
    assert.deepEqual(
      plan.decode((await statement.runAndReadAll()).getRowObjectsJson()[0]).map(({ value }) => value),
      [
        { type: 'integer', value: '5' },
        { type: 'integer', value: '15' },
      ]
    );
    await connection.run('INSERT INTO sample (complete) VALUES (6)');
    assert.deepEqual(
      plan.decode((await statement.runAndReadAll()).getRowObjectsJson()[0]).map(({ value }) => value),
      [
        { type: 'integer', value: '6' },
        { type: 'integer', value: '21' },
      ]
    );
  } finally {
    statement.destroySync();
  }
});

test('native compiler quotes references and rejects invalid metrics and options', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE SCHEMA "quote'名";
    CREATE TABLE "quote'名"."odd.table" ("a'""名" INTEGER);
    INSERT INTO "quote'名"."odd.table" VALUES (2),(3)`);
  const table = '"quote\'名"."odd.table"';
  const rows = decode(
    (
      await connection.runAndReadAll(
        createProfilingSQL(table, [{ name: 'a\'"名', type: 'INTEGER' }], { metrics: ['sum'] })
      )
    ).getRowObjectsJson() as ProfileRow[]
  );
  assert.deepEqual(rows[0].value, { type: 'integer', value: '5' });
  assert.deepEqual(rows[0].columns, ['a\'"名']);
  assert.equal(rows[0].table_name, table);
  for (const metrics of [
    ['not_a_metric'],
    [{ id: 'sum', limit: 1 }],
    [{ id: 'top_values', limit: -1 }],
    [{ id: 'top_values', limit: 1.5 }],
    [{ id: 'top_values', limit: null }],
    [{ id: 'top_values', limit: Number.MAX_SAFE_INTEGER + 1 }],
    [{ id: 'top_values', maxDistinctRatio: -1 }],
    [{ id: 'top_values', maxDistinctRatio: NaN }],
    [{ id: 'top_values', other: 1 }],
  ])
    assert.throws(() => createProfilingSQL('sample', [], { metrics }));
  assert.throws(() => createProfilingSQL('', []));
  assert.throws(() =>
    createProfilingSQL('sample', [
      { name: 'a', type: 'INT' },
      { name: 'A', type: 'INT' },
    ])
  );
});
