import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { dataProfilingSQL } from 'data_profiling';

const instance = await DuckDBInstance.create(':memory:');
let connection;
try {
  connection = await instance.connect();
  await connection.run(dataProfilingSQL);
  await connection.run(`
    CREATE TEMP TABLE orders AS
    SELECT * FROM (VALUES (120, 'web'), (80, 'store'), (NULL, NULL)) AS t(amount, channel);
  `);

  const reader = await connection.runAndReadAll('SELECT * FROM data_profiling(?)', ['orders']);
  const results = reader.getRowObjectsJson().map((row) => ({
    ...row,
    parameters: JSON.parse(row.parameters),
    value: JSON.parse(row.value),
  }));

  assert.deepEqual(results.find((row) => row.metric === 'row_count')?.value, {
    type: 'integer', value: '3',
  });
  console.log(JSON.stringify(results, null, 2));
} finally {
  connection?.closeSync();
  instance.closeSync();
}
