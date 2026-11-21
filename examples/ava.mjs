import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASIC_METRICS, createProfilingPlan } from 'data_profiling';

const logicalTypes = {
  Numeric: 'numeric', Categorical: 'string', Boolean: 'boolean', DateTime: 'date', Unsupported: 'unknown',
};

/** Consumer-side mapping: AVA owns its connection, schema and profile storage. */
export async function profileForAva(connection, schema, metrics = BASIC_METRICS) {
  const models = [];
  const skipped = [];
  for (const model of schema.models) {
    const reference = model.tableReference;
    const table = [reference.schema, reference.table].filter((part) => part !== undefined)
      .map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
    const columns = model.columns ?? [];
    const plan = createProfilingPlan(table, columns, {
      metrics: [...metrics, 'profiling_type'], semantics: 'finite',
    });
    const row = plan.metrics.length ? (await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0] : {};
    const details = plan.decodeWithDiagnostics(row);
    skipped.push(...details.skipped);
    const forTarget = (name) => details.results.filter((result) =>
      name === undefined ? result.columns.length === 0 : result.columns.length === 1 && result.columns[0] === name
    );
    const values = (rows) => Object.fromEntries(rows.filter((result) => result.metric !== 'profiling_type')
      .map((result) => [result.metric, result.value]));
    models.push({
      name: model.name,
      metrics: values(forTarget()),
      columns: columns.map((column) => {
        const rows = forTarget(column.name);
        const type = rows.find((result) => result.metric === 'profiling_type').value.value;
        return { name: column.name, properties: { logicalType: logicalTypes[type] }, metrics: values(rows) };
      }),
    });
  }
  return { profile: { models }, skipped };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE orders AS SELECT * FROM (VALUES
      ('9007199254740993'::BIGINT, 12.34::DECIMAL(20,2), 'web'),
      ('9007199254740994', 99.99, 'store'),
      ('9007199254740995', NULL, 'web'),
      ('9007199254740996', 0, 'web')) t(order_id, amount, channel)`);
    const columns = (await connection.runAndReadAll("SELECT name,type FROM pragma_table_info('orders')"))
      .getRowObjectsJson();
    const { profile } = await profileForAva(connection, {
      models: [{ name: 'data', tableReference: { table: 'orders' }, columns }],
    });
    assert.deepEqual(profile.models[0].metrics.row_count, { type: 'integer', value: '4' });
    assert.deepEqual(profile.models[0].columns[0].metrics.min, { type: 'integer', value: '9007199254740993' });
    console.log(JSON.stringify(profile, null, 2));
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
