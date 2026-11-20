import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DuckDBInstance } from '@duckdb/node-api';
import { createProfilingPlan } from '../dist/index.js';

const rows = Number(process.argv[2] ?? 200000);
assert.ok(Number.isSafeInteger(rows) && rows > 0, 'row count must be a positive safe integer');
const defaults = ['row_count', 'null_count', 'distinct_count', 'top_values', 'min', 'max', 'mean'];
const streaming = [
  'row_count',
  'column_count',
  'null_count',
  'missing_count',
  'min',
  'max',
  'mean',
  'stddev',
  'min_length',
  'max_length',
  'sum',
];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = { rows, repetitions: 5, threads: 1, memory_limit: '512MB', cases: [] };

for (const [name, projection, firstColumn] of [
  ['mixed', `i, i % 101 AS n, (i % 37)::DECIMAL(20,2) AS d, 'category_' || (i % 7)::VARCHAR AS s`, 'i'],
  ['unique_text', `i, i % 101 AS n, (i % 37)::DECIMAL(20,2) AS d, 'id_' || i::VARCHAR AS s`, 'i'],
  ['wide_numeric', Array.from({ length: 8 }, (_, i) => `i + ${i} AS n${i}`).join(', '), 'n0'],
]) {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '512MB' });
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE input AS SELECT ${projection} FROM range(${rows}) t(i)`);
    const columns = (
      await connection.runAndReadAll("SELECT name, type FROM pragma_table_info('input')")
    ).getRowObjectsJson();
    for (const [mode, metrics] of [
      ['default', defaults],
      ['all', undefined],
      ['streaming', streaming],
      ['sum', ['sum']],
    ]) {
      const start = performance.now();
      const plan = createProfilingPlan('input', columns, { metrics });
      const compile_ms = performance.now() - start;
      const preparedAt = performance.now();
      const statement = await connection.prepare(plan.sql);
      const prepare_ms = performance.now() - preparedAt;
      try {
        const run = async (prepared) =>
          plan.decode(
            (await (prepared ? statement.runAndReadAll() : connection.runAndReadAll(plan.sql))).getRowObjectsJson()[0]
          );
        const expected = await run(false);
        const count = expected.find((value) => value.metric === 'row_count');
        if (count) assert.deepEqual(count.value, { type: 'integer', value: String(rows) });
        const sum = expected.find((value) => value.metric === 'sum' && value.columns[0] === firstColumn);
        if (sum)
          assert.deepEqual(sum.value, { type: 'integer', value: String((BigInt(rows) * BigInt(rows - 1)) / 2n) });
        assert.deepEqual(await run(true), expected);
        const times = { native: [], prepared: [] };
        for (let repeat = 0; repeat < report.repetitions; repeat++) {
          for (const prepared of repeat % 2 ? [true, false] : [false, true]) {
            const started = performance.now();
            const actual = await run(prepared);
            times[prepared ? 'prepared' : 'native'].push(performance.now() - started);
            assert.deepEqual(actual, expected);
          }
        }
        report.cases.push({
          name,
          columns: columns.length,
          mode,
          compile_ms,
          prepare_ms,
          median_ms: Object.fromEntries(Object.entries(times).map(([key, values]) => [key, median(values)])),
        });
      } finally {
        statement.destroySync();
      }
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

const instance = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '16MB' });
const connection = await instance.connect();
try {
  await connection.run('CREATE VIEW large_input AS SELECT i AS n FROM range(5000000) t(i)');
  const plan = createProfilingPlan('large_input', [{ name: 'n', type: 'BIGINT' }], { metrics: ['sum'] });
  assert.doesNotMatch(plan.sql, /list\(|list_aggregate|data_profiling_/i);
  const started = performance.now();
  assert.deepEqual(plan.decode((await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0])[0].value, {
    type: 'integer',
    value: '12499997500000',
  });
  report.low_memory_sum = { rows: 5000000, memory_limit: '16MB', native_ms: performance.now() - started };
} finally {
  connection.closeSync();
  instance.closeSync();
}
console.log(JSON.stringify(report, null, 2));
