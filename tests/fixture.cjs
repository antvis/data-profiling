const { DuckDBInstance } = require('@duckdb/node-api');
const { dataProfilingSQL } = require('data_profiling');
const input = require('./fixtures/input.json');

exports.openFixture = async (t) => {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  let connection;
  t.after(() => {
    connection?.closeSync();
    instance.closeSync();
  });
  connection = await instance.connect();
  await connection.run(dataProfilingSQL);
  const columns = Object.entries(input.columns).map(([name, type]) => `${name} ${type}`);
  await connection.run(`CREATE TABLE sample (${columns.join(', ')})`);
  const placeholders = Object.keys(input.columns).map(() => '?').join(', ');
  for (const row of input.rows) {
    await connection.run(`INSERT INTO sample VALUES (${placeholders})`, row);
  }
  return connection;
};

exports.parseValues = (row) =>
  Object.fromEntries(Object.entries(row).map(([name, value]) => [name, JSON.parse(value)]));
