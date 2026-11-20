import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { TestContext } from 'node:test';
import { dataProfilingSQL, type JsonValue, type MetricValue } from 'data_profiling';

export const columns = {
  amount: 'DOUBLE', channel: 'VARCHAR', approved: 'BOOLEAN', empty: 'VARCHAR', complete: 'INTEGER',
};
const rows = [
  [120, 'web', true, null, 1],
  [80, null, false, null, 2],
  [null, 'store', null, null, 3],
  [0, '', true, null, 4],
  [120, 'web', false, null, 5],
];

export async function openFixture(t: TestContext): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  let connection: DuckDBConnection | undefined;
  t.after(() => {
    connection?.closeSync();
    instance.closeSync();
  });
  connection = await instance.connect();
  await connection.run(dataProfilingSQL);
  const definitions = Object.entries(columns).map(([name, type]) => `${name} ${type}`);
  await connection.run(`CREATE TABLE sample (${definitions.join(', ')})`);
  const placeholders = Object.keys(columns).map(() => '?').join(', ');
  for (const row of rows) {
    await connection.run(`INSERT INTO sample VALUES (${placeholders})`, row);
  }
  return connection;
}

export const parseValues = (row: Record<string, JsonValue>): Record<string, MetricValue> =>
  Object.fromEntries(Object.entries(row).map(([name, value]) => [name, JSON.parse(value as string)]));
