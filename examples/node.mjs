import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createProfilingPlan } from 'data_profiling';

const instance = await DuckDBInstance.create(':memory:');
let connection;
try {
  connection = await instance.connect();
  await connection.run(`
    CREATE TEMP TABLE orders AS
    SELECT * FROM (VALUES (120, 'web'), (80, 'store'), (NULL, NULL)) AS t(amount, channel);
  `);

  const columns = (
    await connection.runAndReadAll('SELECT name, type FROM pragma_table_info(?)', ['orders'])
  ).getRowObjectsJson();
  const plan = createProfilingPlan('orders', columns);
  const reader = await connection.runAndReadAll(plan.sql);
  const results = plan.decode(reader.getRowObjectsJson()[0]);

  assert.deepEqual(results.find((row) => row.metric === 'row_count')?.value, {
    type: 'integer',
    value: '3',
  });
  console.log(JSON.stringify(results, null, 2));
} finally {
  connection?.closeSync();
  instance.closeSync();
}
