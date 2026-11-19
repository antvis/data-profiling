const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DuckDBInstance } = require('@duckdb/node-api');
const { dataProfilingSQL } = require('data_profiling');
const fixture = require('./fixtures/core.json');

test('matches fg-data-profiling for table and column metrics', async (t) => {
  const instance = await DuckDBInstance.create(':memory:');
  let connection;
  t.after(() => {
    connection?.closeSync();
    instance.closeSync();
  });
  connection = await instance.connect();
  await connection.run(dataProfilingSQL);
  const columns = Object.entries(fixture.columns).map(([name, type]) => `${name} ${type}`);
  await connection.run(`CREATE TABLE sample (${columns.join(', ')})`);
  const placeholders = Object.keys(fixture.columns).map(() => '?').join(', ');
  for (const row of fixture.rows) {
    await connection.run(`INSERT INTO sample VALUES (${placeholders})`, row);
  }
  const result = await connection.runAndReadAll("SELECT * FROM data_profiling('sample')");
  assert.deepEqual(result.getRowObjectsJson(), fixture.expected);
});
