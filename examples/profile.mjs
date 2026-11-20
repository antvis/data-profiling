import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { profile } from 'data_profiling';

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
try {
  await connection.run(`CREATE TABLE events AS SELECT i AS idx,
    sin(i * 0.7) + i % 3 AS measurement, 'Hello 中文 😀' AS message,
    'https://example.com/path?q=1#part' AS link FROM range(128) t(i)`);
  const columns = (
    await connection.runAndReadAll("SELECT name,type FROM pragma_table_info('events')")
  ).getRowObjectsJson();
  const results = await profile(
    connection,
    'events',
    columns,
    process.argv[2]
      ? {
          python: process.argv[2],
          timeIndex: 'idx',
          types: { measurement: 'timeseries', message: 'text', link: 'url' },
        }
      : { metrics: ['row_count', 'present_count', 'missing_rate', 'singleton_count', 'variance_samp', 'pearson_r'] }
  );
  assert.deepEqual(results.find((row) => row.metric === 'row_count')?.value, { type: 'integer', value: '128' });
  console.log(JSON.stringify(results, null, 2));
} finally {
  connection.closeSync();
  instance.closeSync();
}
