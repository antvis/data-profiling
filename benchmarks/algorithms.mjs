import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DuckDBInstance } from '@duckdb/node-api';
import { profile } from '../dist/index.js';

const rows = Number(process.argv[2] ?? 200000);
assert.ok(Number.isSafeInteger(rows) && rows > 3);
const instance = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '512MB' });
const connection = await instance.connect();
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  await connection.run(
    `CREATE TABLE input AS SELECT i AS idx, sin(i*.7)+i%3 AS value, 'Hello 中文 word_' || (i%7)::VARCHAR AS text FROM range(${rows})t(i)`
  );
  const columns = (
    await connection.runAndReadAll("SELECT name,type FROM pragma_table_info('input')")
  ).getRowObjectsJson();
  const report = { rows, threads: 1, memory_limit: '512MB', cases: [] };
  const cases = [
    [
      'native',
      {
        metrics: [
          'row_count',
          'present_count',
          'missing_rate',
          'variance_samp',
          'stddev_samp',
          'singleton_count',
          'category_imbalance_score',
          'pearson_r',
        ],
      },
    ],
  ];
  if (process.env.PROFILING_PYTHON)
    cases.push([
      'algorithms',
      {
        python: process.env.PROFILING_PYTHON,
        timeIndex: 'idx',
        types: { value: 'timeseries', text: 'text' },
        metrics: [
          'row_count',
          'quantiles',
          'numeric_histogram',
          'character_counts',
          'word_counts',
          'kendall_tau',
          'adf_p_value',
          'acf',
          'gap_count',
        ],
        maxlag: 2,
        autolag: null,
        lags: 5,
      },
    ]);
  for (const [name, options] of cases) {
    const run = async () => {
      const start = performance.now();
      const results = await profile(connection, 'input', columns, options);
      const ms = performance.now() - start;
      assert.deepEqual(results.find((row) => row.metric === 'row_count')?.value, {
        type: 'integer',
        value: String(rows),
      });
      if (name === 'algorithms') {
        const histogram = results.find((row) => row.metric === 'numeric_histogram' && row.columns[0] === 'value').value;
        assert.equal(histogram.type, 'object');
        assert.equal(
          histogram.value.counts.value.reduce((sum, value) => sum + BigInt(value.value), 0n),
          BigInt(rows)
        );
      }
      return ms;
    };
    const cold_ms = await run(),
      times = [];
    for (let i = 0; i < 3; i++) times.push(await run());
    report.cases.push({ name, cold_ms, repetitions: 3, median_ms: median(times) });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  connection.closeSync();
  instance.closeSync();
}
