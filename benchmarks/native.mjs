import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DuckDBInstance } from '@duckdb/node-api';
import { createProfilingPlan, createProfilingSQL, dataProfilingSQL } from '../dist/index.js';

const rows = Number(process.argv[2] ?? 200000);
assert.ok(Number.isSafeInteger(rows) && rows > 0, 'row count must be a positive safe integer');
const defaults = ['row_count', 'null_count', 'distinct_count', 'top_values', 'min', 'max', 'mean'];
const all = [...defaults, 'duplicate_count', 'min_length', 'max_length', 'sum', 'stddev', 'median'];
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
];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const report = { rows, repetitions: 5, threads: 1, memory_limit: '512MB', cases: [] };

for (const [name, projection] of [
  ['mixed', `i, i % 101 AS n, (i % 37)::DECIMAL(20,2) AS d, 'category_' || (i % 7)::VARCHAR AS s`],
  ['unique_text', `i, i % 101 AS n, (i % 37)::DECIMAL(20,2) AS d, 'id_' || i::VARCHAR AS s`],
  ['wide_numeric', Array.from({ length: 8 }, (_, i) => `i + ${i} AS n${i}`).join(', ')],
]) {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '512MB' });
  const connection = await instance.connect();
  try {
    await connection.run(dataProfilingSQL);
    await connection.run(`CREATE TABLE input AS SELECT ${projection} FROM range(${rows}) t(i)`);
    const columns = (
      await connection.runAndReadAll("SELECT name, type FROM pragma_table_info('input')")
    ).getRowObjectsJson();
    for (const [mode, metrics] of [
      ['default', defaults],
      ['all', all],
      ['streaming', streaming],
      ['sum', ['sum']],
    ]) {
      const started = performance.now();
      const plan = createProfilingPlan('input', columns, { metrics });
      const compile_ms = performance.now() - started;
      const protocolSQL = createProfilingSQL('input', columns, { metrics });
      const macroSQL = `SELECT ${plan.metrics
        .map((metric, index) => {
          const args =
            metric.metric === 'column_count' ? [quote('input')] : metric.column ? [identifier(metric.column.name)] : [];
          if (metric.metric === 'top_values') args.push(`${quote(JSON.stringify(metric.parameters))}::JSON`);
          return `data_profiling_${metric.metric}(${args.join(', ')}) AS b${index}`;
        })
        .join(', ')} FROM input`;
      const prepareStarted = performance.now();
      const statement = await connection.prepare(plan.sql);
      const prepare_ms = performance.now() - prepareStarted;
      const methods = {
        macros: async () => {
          const row = (await connection.runAndReadAll(macroSQL)).getRowObjectsJson()[0];
          return plan.metrics.flatMap((metric, index) =>
            row[`b${index}`] == null
              ? []
              : [
                  {
                    protocol_version: 1,
                    table_name: 'input',
                    columns: metric.column ? [metric.column.name] : [],
                    metric: metric.metric,
                    parameters: metric.parameters,
                    value: JSON.parse(row[`b${index}`]),
                  },
                ]
          );
        },
        native: async () => plan.decode((await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0]),
        native_sql_json: async () =>
          (await connection.runAndReadAll(protocolSQL))
            .getRowObjectsJson()
            .map((row) => ({ ...row, parameters: JSON.parse(row.parameters), value: JSON.parse(row.value) })),
        native_prepared: async () => plan.decode((await statement.runAndReadAll()).getRowObjectsJson()[0]),
      };
      try {
        const expected = await methods.macros();
        for (const compute of Object.values(methods)) assert.deepEqual(await compute(), expected);
        const times = Object.fromEntries(Object.keys(methods).map((method) => [method, []]));
        const entries = Object.entries(methods);
        for (let run = 0; run < report.repetitions; run++) {
          for (let index = 0; index < entries.length; index++) {
            const [method, compute] = entries[(index + run) % entries.length];
            const start = performance.now();
            await compute();
            times[method].push(performance.now() - start);
          }
        }
        report.cases.push({
          name,
          columns: columns.length,
          mode,
          compile_ms,
          prepare_ms,
          median_ms: Object.fromEntries(Object.entries(times).map(([method, values]) => [method, median(values)])),
          times,
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
  await connection.run(dataProfilingSQL);
  await connection.run('CREATE VIEW large_input AS SELECT i AS n FROM range(5000000) t(i)');
  const plan = createProfilingPlan('large_input', [{ name: 'n', type: 'BIGINT' }], { metrics: ['sum'] });
  assert.doesNotMatch(plan.sql, /list\(|list_aggregate|data_profiling_/i);
  const start = performance.now();
  assert.deepEqual(plan.decode((await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0])[0].value, {
    type: 'integer',
    value: '12499997500000',
  });
  report.low_memory_sum = { rows: 5000000, memory_limit: '16MB', native_ms: performance.now() - start };
  try {
    await connection.runAndReadAll('SELECT data_profiling_sum(n) FROM large_input');
    report.low_memory_sum.macros = 'completed';
  } catch (error) {
    assert.match(error.message, /Out of Memory|out of memory/);
    report.low_memory_sum.macros = 'out_of_memory';
  }
} finally {
  connection.closeSync();
  instance.closeSync();
}
console.log(JSON.stringify(report, null, 2));
