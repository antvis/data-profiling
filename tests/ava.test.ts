import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openFixture } from './fixture';

test('AVA example reuses a connection and maps named models without losing types or precision', async (t) => {
  const { profileForAva } = await import(pathToFileURL(resolve('examples/ava.mjs')).href);
  const connection = await openFixture(t);
  await connection.run(`CREATE SCHEMA "sales""data";
    CREATE TABLE "sales""data"."order""s" AS SELECT '9007199254740993'::BIGINT AS "__proto__",
    'web' AS "constructor", DATE '2026-11-21' AS happened_at FROM range(2)`);
  const schema = { models: [{
    name: 'business_orders', tableReference: { schema: 'sales"data', table: 'order"s' },
    columns: [
      { name: '__proto__', type: 'BIGINT' }, { name: 'constructor', type: 'VARCHAR' },
      { name: 'happened_at', type: 'DATE' },
    ],
  }] };
  let reads = 0;
  const result = await profileForAva({
    runAndReadAll: (sql: string) => { reads++; return connection.runAndReadAll(sql); },
  }, schema, ['row_count', 'min', 'top_values']);
  assert.equal(reads, 1);
  const model = result.profile.models[0];
  assert.equal(model.name, 'business_orders');
  assert.deepEqual(model.metrics.row_count, { type: 'integer', value: '2' });
  assert.deepEqual(model.columns[0], {
    name: '__proto__', properties: { logicalType: 'numeric' },
    metrics: { min: { type: 'integer', value: '9007199254740993' } },
  });
  assert.deepEqual(model.columns[2].metrics.min, { type: 'date', value: '2026-11-21' });
  assert.equal(model.columns[1].properties.logicalType, 'string');
  assert.ok(!Object.hasOwn(model.columns[1].metrics, 'min'));
  assert.ok(result.skipped.some((item: { metric: string; reason: string }) =>
    item.metric === 'min' && item.reason === 'unsupported_type'));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  const empty = await profileForAva(connection, schema, []);
  assert.deepEqual(empty.profile.models[0].metrics, {});
  assert.deepEqual(empty.profile.models[0].columns[0].metrics, {});
  assert.deepEqual(empty.skipped, []);
});
