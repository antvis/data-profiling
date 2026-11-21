import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { createProfilingPlan, type MetricValue, type ProfileResult } from 'data_profiling';
import { columns, openFixture, profile } from './fixture';

const integer = (value: string): MetricValue => ({ type: 'integer', value });
const number = (value: number): MetricValue => ({ type: 'number', value });
const missing: MetricValue = { type: 'null', value: null };
const frequencies = (entries: [string | boolean, string][], truncated = false): MetricValue => ({
  type: 'object',
  value: {
    entries: {
      type: 'list',
      value: entries.map(([value, count]) => ({
        type: 'object',
        value: {
          value: typeof value === 'boolean' ? { type: 'boolean', value } : { type: 'string', value },
          count: integer(count),
        },
      })),
    },
    truncated: { type: 'boolean', value: truncated },
  },
});

function columnMetrics(rows: ProfileResult[], name: string): Record<string, MetricValue> {
  return Object.fromEntries(rows.filter((row) => row.columns[0] === name).map((row) => [row.metric, row.value]));
}

test('native profiling computes exact table and column statistics', async (t) => {
  const connection = await openFixture(t);
  const rows = await profile(connection, 'sample');
  assert.deepEqual(
    Object.fromEntries(rows.filter((row) => !row.columns.length).map(({ metric, value }) => [metric, value])),
    {
      column_count: integer('5'),
      row_count: integer('5'),
    }
  );
  assert.ok(rows.every((row) => row.protocol_version === 1 && row.table_name === 'sample'));
  assert.deepEqual(columnMetrics(rows, 'amount'), {
    distinct_count: integer('3'),
    duplicate_count: integer('1'),
    max: number(120),
    mean: number(80),
    min: number(0),
    sum: number(320),
    median: number(100),
    stddev: number(Math.sqrt(3200)),
    missing_count: integer('1'),
    null_count: integer('1'),
  });
  assert.deepEqual(columnMetrics(rows, 'complete'), {
    distinct_count: integer('5'),
    duplicate_count: integer('0'),
    max: integer('5'),
    mean: number(3),
    min: integer('1'),
    sum: integer('15'),
    median: number(3),
    stddev: number(Math.sqrt(2.5)),
    missing_count: integer('0'),
    null_count: integer('0'),
  });
  assert.deepEqual(columnMetrics(rows, 'channel'), {
    distinct_count: integer('3'),
    duplicate_count: integer('1'),
    missing_count: integer('1'),
    null_count: integer('1'),
    min_length: integer('0'),
    max_length: integer('5'),
  });
  assert.deepEqual(columnMetrics(rows, 'approved'), {
    distinct_count: integer('2'),
    duplicate_count: integer('2'),
    missing_count: integer('1'),
    null_count: integer('1'),
    top_values: frequencies([
      [false, '2'],
      [true, '2'],
    ]),
  });
  assert.deepEqual(columnMetrics(rows, 'empty'), {
    distinct_count: integer('0'),
    duplicate_count: integer('0'),
    missing_count: integer('5'),
    null_count: integer('5'),
    top_values: frequencies([]),
    min_length: missing,
    max_length: missing,
  });
  assert.ok(
    rows.every(
      (row) =>
        JSON.stringify(row.parameters) ===
        JSON.stringify(row.metric === 'top_values' ? { limit: 3, maxDistinctRatio: 0.5 } : {})
    )
  );
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
    const counts = {
      distinct_count: integer('0'),
      duplicate_count: integer('0'),
      missing_count: integer(count),
      null_count: integer(count),
    };
    assert.deepEqual(columnMetrics(rows, 'n'), {
      ...counts,
      min: missing,
      max: missing,
      mean: missing,
      sum: missing,
      median: missing,
      stddev: missing,
    });
    assert.deepEqual(columnMetrics(rows, 'd'), { ...counts, min: missing, max: missing });
    assert.deepEqual(columnMetrics(rows, 's'), {
      ...counts,
      top_values: frequencies([]),
      min_length: missing,
      max_length: missing,
    });
    assert.deepEqual(columnMetrics(rows, 'b'), { ...counts, top_values: frequencies([]) });
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
    if (['i', 'd'].includes(name)) {
      assert.deepEqual(metrics.sum, value);
      assert.deepEqual(metrics.stddev, missing);
    }
    if (name === 'd') assert.deepEqual(metrics.median, value);
    if (['day', 'distant_day', 'ns', 'tz'].includes(name)) assert.ok(!('mean' in metrics));
  }
  const special = await profile(connection, 'special');
  assert.deepEqual(columnMetrics(special, 'n'), {
    distinct_count: integer('4'),
    duplicate_count: integer('0'),
    missing_count: integer('1'),
    null_count: integer('1'),
    min: number(2),
    max: number(2),
    mean: number(2),
    sum: number(2),
    median: number(2),
    stddev: missing,
  });
  assert.deepEqual(columnMetrics(special, 'd'), {
    distinct_count: integer('3'),
    duplicate_count: integer('0'),
    missing_count: integer('2'),
    null_count: integer('2'),
    min: { type: 'date', value: '2026-11-20' },
    max: { type: 'date', value: '2026-11-20' },
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
  assert.deepEqual(
    columnMetrics(rows, 's').top_values,
    frequencies(
      [
        ['a', '2'],
        ['b', '2'],
        ['c', '2'],
      ],
      true
    )
  );
  assert.deepEqual(
    columnMetrics(rows, 'e').top_values,
    frequencies([
      ['z', '1'],
      ['a', '1'],
    ])
  );
  const threshold = await profile(connection, 'threshold_input');
  assert.deepEqual(
    columnMetrics(threshold, 's').top_values,
    frequencies([
      ['a', '2'],
      ['b', '2'],
    ])
  );
  await connection.run("INSERT INTO categories VALUES ('unique', NULL)");
  assert.ok(!('top_values' in columnMetrics(await profile(connection, 'categories'), 's')));
});

test('unsupported types receive NULL and duplicate counts without breaking scalar metrics', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE TABLE complex AS SELECT
    [1, 2] AS list, [1]::INTEGER[1] AS array, {a: 1} AS struct,
    map(['a'], [1]) AS map, 'x'::BLOB AS blob, '1'::JSON AS json,
    INTERVAL '1 day' AS duration, TIME '12:00:00' AS time`);
  const rows = await profile(connection, 'complex');
  assert.equal(rows.length, 26);
  for (const row of rows.filter((row) => row.columns.length)) {
    assert.ok(['missing_count', 'null_count', 'duplicate_count'].includes(row.metric));
    assert.deepEqual(row.value, integer('0'));
  }
});

test('string lengths count Unicode characters, empty strings and trailing spaces', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE TABLE strings AS SELECT * FROM (VALUES ('😀'), ('中文 '), (''), (NULL)) t(v)`);
  const metrics = columnMetrics(await profile(connection, 'strings', { metrics: ['min_length', 'max_length'] }), 'v');
  assert.deepEqual(metrics.min_length, integer('0'));
  assert.deepEqual(metrics.max_length, integer('3'));
});

test('numeric aggregates retain native decimal median rounding and exact sums', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE TABLE decimal_input AS SELECT * FROM (VALUES
    (0.00::DECIMAL(38,2)), (0.01::DECIMAL(38,2)), (NULL)) t(v)`);
  const metrics = columnMetrics(await profile(connection, 'decimal_input'), 'v');
  assert.deepEqual(metrics.sum, { type: 'decimal', value: '0.01' });
  assert.deepEqual(metrics.median, { type: 'decimal', value: '0.00' });
  assert.equal(metrics.stddev.type, 'number');
  if (metrics.stddev.type === 'number') assert.ok(Math.abs(Number(metrics.stddev.value) - Math.sqrt(0.00005)) < 1e-15);
  await connection.run(`CREATE TABLE no_finite AS SELECT * FROM (VALUES
    ('NaN'::DOUBLE), ('Infinity'::DOUBLE), ('-Infinity'::DOUBLE)) t(v)`);
  const invalid = columnMetrics(await profile(connection, 'no_finite'), 'v');
  for (const metric of ['min', 'max', 'mean', 'sum', 'stddev', 'median']) assert.deepEqual(invalid[metric], missing);
});

test('top values support configured options and reject invalid parameters', async (t) => {
  const connection = await openFixture(t);
  for (const [parameters, expected] of [
    [
      { limit: 2, maxDistinctRatio: 1 },
      frequencies(
        [
          ['web', '2'],
          ['', '1'],
        ],
        true
      ),
    ],
    [{ limit: 0, maxDistinctRatio: 1 }, frequencies([], true)],
    [
      { limit: Number.MAX_SAFE_INTEGER, maxDistinctRatio: 1 },
      frequencies([
        ['web', '2'],
        ['', '1'],
        ['store', '1'],
      ]),
    ],
    [{ maxDistinctRatio: 0 }, null],
  ] as const) {
    const rows = await profile(connection, 'sample', { metrics: [{ id: 'top_values', ...parameters }] });
    assert.deepEqual(columnMetrics(rows, 'channel').top_values ?? null, expected);
  }
  for (const parameters of [
    { limit: -1 },
    { limit: 1.5 },
    { limit: '2' },
    { limit: null },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { maxDistinctRatio: -0.1 },
    { maxDistinctRatio: 1.1 },
    { maxDistinctRatio: null },
    { unknown: 1 },
  ]) {
    await assert.rejects(
      profile(connection, 'sample', { metrics: [{ id: 'top_values', ...parameters }] }),
      /top_values/
    );
  }
});

test('selection retains column subsets, empty requests and last-configuration semantics', async (t) => {
  const connection = await openFixture(t);
  const selected = [{ name: 'channel', type: 'VARCHAR' }];
  const empty = createProfilingPlan('sample', selected, { metrics: [] });
  assert.deepEqual(empty.decode({}), []);
  const plan = createProfilingPlan('sample', selected, {
    metrics: [{ id: 'top_values', maxDistinctRatio: 1 }, { id: 'top_values', maxDistinctRatio: 0 }, 'null_count'],
  });
  const results = plan.decode((await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0]);
  assert.deepEqual(
    results.map(({ columns, metric, value }) => ({ columns, metric, value })),
    [{ columns: ['channel'], metric: 'null_count', value: integer('1') }]
  );
});

test('native diagnostics separate unsupported types, cardinality skips and computed nulls', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE VIEW diagnostics AS SELECT NULL::DOUBLE AS n, i::VARCHAR AS id FROM range(3) t(i)`);
  const plan = createProfilingPlan('diagnostics', [
    { name: 'n', type: 'DOUBLE' }, { name: 'id', type: 'VARCHAR' },
  ], { metrics: ['mean', 'top_values'] });
  const row = (await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0];
  const details = plan.decodeWithDiagnostics(row);
  assert.deepEqual(details.results, plan.decode(row));
  assert.deepEqual(details.results.map(({ metric, columns, value }) => ({ metric, columns, value })), [
    { metric: 'mean', columns: ['n'], value: { type: 'null', value: null } },
  ]);
  assert.deepEqual(details.skipped, [
    { table_name: 'diagnostics', metric: 'mean', columns: ['id'], reason: 'unsupported_type' },
    { table_name: 'diagnostics', metric: 'top_values', columns: ['n'], reason: 'unsupported_type' },
    { table_name: 'diagnostics', metric: 'top_values', columns: ['id'], reason: 'cardinality_limit' },
  ]);
  details.skipped[0].columns[0] = 'changed';
  assert.equal(plan.decodeWithDiagnostics(row).skipped[0].columns[0], 'id');
  assert.throws(() => plan.decodeWithDiagnostics({}), /Missing aggregate/);
});

test('fully inapplicable and empty selections have diagnostics without executing SQL', () => {
  const columns = [{ name: 's', type: 'VARCHAR' }];
  const plan = createProfilingPlan('sample', columns, { metrics: ['mean', 'mean'] });
  assert.equal(plan.metrics.length, 0);
  assert.deepEqual(plan.decodeWithDiagnostics({}), {
    results: [], skipped: [{ table_name: 'sample', metric: 'mean', columns: ['s'], reason: 'unsupported_type' }],
  });
  assert.deepEqual(createProfilingPlan('sample', columns, { metrics: [] }).decodeWithDiagnostics({}), {
    results: [], skipped: [],
  });
});

test('streaming selection excludes expensive states and native sum fits a small memory budget', async (t) => {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '16MB' });
  const connection = await instance.connect();
  t.after(() => {
    connection.closeSync();
    instance.closeSync();
  });
  await connection.run('CREATE VIEW numbers AS SELECT i AS n FROM range(5000000) t(i)');
  const plan = createProfilingPlan('numbers', [{ name: 'n', type: 'BIGINT' }], { metrics: ['row_count', 'sum'] });
  assert.doesNotMatch(plan.sql, /DISTINCT|list\(|histogram\(|median\(|data_profiling_/i);
  assert.deepEqual(
    plan.decode((await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0]).map(({ value }) => value),
    [integer('5000000'), integer('12499997500000')]
  );
});

test('a reused native statement observes data changes and rejects lossy transport', async (t) => {
  const connection = await openFixture(t);
  const plan = createProfilingPlan('sample', [{ name: 'complete', type: 'INTEGER' }], {
    metrics: ['row_count', 'sum'],
  });
  const statement = await connection.prepare(plan.sql);
  try {
    assert.deepEqual(
      plan.decode((await statement.runAndReadAll()).getRowObjectsJson()[0]).map(({ value }) => value),
      [integer('5'), integer('15')]
    );
    await connection.run('INSERT INTO sample (complete) VALUES (6)');
    assert.deepEqual(
      plan.decode((await statement.runAndReadAll()).getRowObjectsJson()[0]).map(({ value }) => value),
      [integer('6'), integer('21')]
    );
  } finally {
    statement.destroySync();
  }
  assert.throws(() => plan.decode({}), /Missing aggregate/);
  const count = createProfilingPlan('sample', [], { metrics: ['row_count'] });
  assert.throws(() => count.decode({ [count.metrics[0].alias]: Number.MAX_SAFE_INTEGER + 1 }), /lossy integer/);
  assert.deepEqual(
    count.decode({ [count.metrics[0].alias]: '9007199254740993' })[0].value,
    integer('9007199254740993')
  );
});

test('schema references are safely quoted and invalid requests fail before execution', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE SCHEMA "quote'名";
    CREATE TABLE "quote'名"."odd.table" ("a'""名" INTEGER);
    INSERT INTO "quote'名"."odd.table" VALUES (2),(3)`);
  const table = '"quote\'名"."odd.table"';
  const plan = createProfilingPlan(table, [{ name: 'a\'"名', type: 'INTEGER' }], { metrics: ['sum'] });
  const result = plan.decode((await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0])[0];
  assert.deepEqual(result.value, integer('5'));
  assert.deepEqual(result.columns, ['a\'"名']);
  assert.equal(result.table_name, table);
  assert.throws(() => createProfilingPlan('', []));
  assert.throws(() =>
    createProfilingPlan('sample', [
      { name: 'a', type: 'INT' },
      { name: 'A', type: 'INT' },
    ])
  );
  for (const metrics of [['not_a_metric'], [{ id: 'sum', limit: 1 }]]) {
    assert.throws(() =>
      createProfilingPlan(
        'sample',
        Object.entries(columns).map(([name, type]) => ({ name, type })),
        { metrics }
      )
    );
  }
});
