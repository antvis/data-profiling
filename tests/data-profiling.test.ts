import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetricValue, ProfileResult, ProfileRow } from 'data_profiling';
import { openFixture } from './fixture';

const integer = (value: string): MetricValue => ({ type: 'integer', value });
const number = (value: number): MetricValue => ({ type: 'number', value });
const missing: MetricValue = { type: 'null', value: null };
const frequencies = (entries: [string | boolean, string][], truncated = false): MetricValue => ({
  type: 'object', value: {
    entries: { type: 'list', value: entries.map(([value, count]) => ({
      type: 'object', value: {
        value: typeof value === 'boolean' ? { type: 'boolean', value } : { type: 'string', value },
        count: integer(count),
      },
    })) },
    truncated: { type: 'boolean', value: truncated },
  },
});

async function profile(connection: Awaited<ReturnType<typeof openFixture>>, table: string): Promise<ProfileResult[]> {
  const reader = await connection.runAndReadAll('SELECT * FROM data_profiling(?) ORDER BY columns, metric', [table]);
  assert.deepEqual(reader.columnNames(), ['protocol_version', 'table_name', 'columns', 'metric', 'parameters', 'value']);
  return (reader.getRowObjectsJson() as ProfileRow[]).map((row) => ({
    ...row, parameters: JSON.parse(row.parameters), value: JSON.parse(row.value),
  }));
}

function columnMetrics(rows: ProfileResult[], name: string): Record<string, MetricValue> {
  return Object.fromEntries(rows.filter((row) => row.columns[0] === name).map((row) => [row.metric, row.value]));
}

test('data_profiling.sql routes table and column results through protocol v1', async (t) => {
  const connection = await openFixture(t);
  const rows = await profile(connection, 'sample');
  assert.deepEqual(rows.filter((row) => !row.columns.length).map(({ metric, value }) => [metric, value]), [
    ['column_count', integer('5')], ['row_count', integer('5')],
  ]);
  assert.ok(rows.every((row) => row.protocol_version === 1 && row.table_name === 'sample'));
  assert.deepEqual(columnMetrics(rows, 'amount'), {
    distinct_count: integer('3'), max: number(120), mean: number(80), min: number(0),
    missing_count: integer('1'), null_count: integer('1'),
  });
  assert.deepEqual(columnMetrics(rows, 'complete'), {
    distinct_count: integer('5'), max: integer('5'), mean: number(3), min: integer('1'),
    missing_count: integer('0'), null_count: integer('0'),
  });
  assert.deepEqual(columnMetrics(rows, 'channel'), {
    distinct_count: integer('3'), missing_count: integer('1'), null_count: integer('1'),
  });
  assert.deepEqual(columnMetrics(rows, 'approved'), {
    distinct_count: integer('2'), missing_count: integer('1'), null_count: integer('1'),
    top_values: frequencies([[false, '2'], [true, '2']]),
  });
  assert.deepEqual(columnMetrics(rows, 'empty'), {
    distinct_count: integer('0'), missing_count: integer('5'), null_count: integer('5'), top_values: frequencies([]),
  });
  assert.ok(rows.every((row) => JSON.stringify(row.parameters) === JSON.stringify(
    row.metric === 'top_values' ? { limit: 3, maxDistinctRatio: 0.5 } : {},
  )));
  assert.equal(new Set(rows.map((row) => JSON.stringify([row.columns, row.metric, row.parameters]))).size, rows.length);
});

test('default metrics retain supported targets and undefined values on empty or all-null inputs', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`
    CREATE TABLE boundaries (n DOUBLE, s VARCHAR, b BOOLEAN, d DATE);
    CREATE VIEW empty_input AS SELECT * FROM boundaries WHERE false;
    INSERT INTO boundaries VALUES (NULL, NULL, NULL, NULL);
  `);
  for (const table of ['empty_input', 'boundaries']) {
    const rows = await profile(connection, table);
    const count = table === 'empty_input' ? '0' : '1';
    assert.deepEqual(rows.find((row) => row.metric === 'row_count')?.value, integer(count));
    const counts = { distinct_count: integer('0'), missing_count: integer(count), null_count: integer(count) };
    assert.deepEqual(columnMetrics(rows, 'n'), { ...counts, min: missing, max: missing, mean: missing });
    assert.deepEqual(columnMetrics(rows, 'd'), { ...counts, min: missing, max: missing });
    for (const name of ['s', 'b']) assert.deepEqual(columnMetrics(rows, name), { ...counts, top_values: frequencies([]) });
  }
});

test('numeric and temporal bounds preserve precision and ignore non-finite observations', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`
    SET TimeZone = 'Asia/Shanghai';
    CREATE TABLE precise AS SELECT
      '9007199254740993'::BIGINT AS i,
      '12345678901234567890.123456789'::DECIMAL(38,9) AS d,
      DATE '2026-11-20' AS day,
      DATE '1000000-01-01' AS distant_day,
      TIMESTAMP_NS '2026-11-20 12:00:00.123456789' AS ns,
      TIMESTAMPTZ '2026-11-20 12:00:00.123456+08' AS tz;
    CREATE TABLE special AS SELECT * FROM (VALUES
      (2::DOUBLE, DATE '2026-11-20'), ('Infinity', 'infinity'),
      ('-Infinity', '-infinity'), ('NaN', NULL), (NULL, NULL)) t(n, d);
  `);
  const rows = await profile(connection, 'precise');
  for (const [name, value] of Object.entries({
    i: integer('9007199254740993'),
    d: { type: 'decimal', value: '12345678901234567890.123456789' },
    day: { type: 'date', value: '2026-11-20' },
    distant_day: { type: 'date', value: '1000000-01-01' },
    ns: { type: 'timestamp', value: '2026-11-20T12:00:00.123456789' },
    tz: { type: 'timestamptz', value: '2026-11-20T04:00:00.123456Z' },
  })) {
    const metrics = columnMetrics(rows, name);
    assert.deepEqual(metrics.min, value);
    assert.deepEqual(metrics.max, value);
    if (['day', 'distant_day', 'ns', 'tz'].includes(name)) assert.ok(!('mean' in metrics));
  }
  const special = await profile(connection, 'special');
  assert.deepEqual(columnMetrics(special, 'n'), {
    distinct_count: integer('4'), missing_count: integer('1'), null_count: integer('1'),
    min: number(2), max: number(2), mean: number(2),
  });
  assert.deepEqual(columnMetrics(special, 'd'), {
    distinct_count: integer('3'), missing_count: integer('2'), null_count: integer('2'),
    min: { type: 'date', value: '2026-11-20' }, max: { type: 'date', value: '2026-11-20' },
  });
});

test('top values handle ties, truncation, the cardinality threshold and native category order', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`
    CREATE TYPE category AS ENUM ('z', 'a');
    CREATE TABLE categories AS SELECT * FROM (VALUES
      ('b', 'z'::category), ('a', 'a'::category), ('b', NULL), ('a', NULL),
      ('d', NULL), ('c', NULL), ('d', NULL), ('c', NULL)) t(s, e);
    CREATE VIEW threshold_input AS SELECT * FROM categories LIMIT 4;
  `);
  const rows = await profile(connection, 'categories');
  assert.deepEqual(columnMetrics(rows, 's').top_values, frequencies([['a', '2'], ['b', '2'], ['c', '2']], true));
  assert.deepEqual(columnMetrics(rows, 'e').top_values, frequencies([['z', '1'], ['a', '1']]));
  const threshold = await profile(connection, 'threshold_input');
  assert.deepEqual(columnMetrics(threshold, 's').top_values, frequencies([['a', '2'], ['b', '2']]));
  await connection.run("INSERT INTO categories VALUES ('unique', NULL)");
  assert.ok(!('top_values' in columnMetrics(await profile(connection, 'categories'), 's')));
});

test('unsupported types only receive NULL counts and cannot break scalar metrics', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE TABLE complex AS SELECT
    [1, 2] AS list, [1]::INTEGER[1] AS array, {a: 1} AS struct,
    map(['a'], [1]) AS map, 'x'::BLOB AS blob, '1'::JSON AS json,
    INTERVAL '1 day' AS duration, TIME '12:00:00' AS time`);
  const rows = await profile(connection, 'complex');
  assert.equal(rows.length, 18);
  for (const row of rows.filter((row) => row.columns.length)) {
    assert.ok(['missing_count', 'null_count'].includes(row.metric));
    assert.deepEqual(row.value, integer('0'));
  }
});
