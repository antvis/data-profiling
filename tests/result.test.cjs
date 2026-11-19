const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openFixture } = require('./fixture.cjs');
const examples = require('../docs/result-examples.json');

test('result.sql preserves numeric, distribution, temporal and pair payloads', async (t) => {
  const connection = await openFixture(t);
  for (const example of examples) {
    const result = await connection.runAndReadAll(`
      SELECT unnest(data_profiling_result(?, ?::JSON::VARCHAR[], ?, ?::JSON, ?::JSON))
    `, [example.table_name, JSON.stringify(example.columns), example.metric,
      JSON.stringify(example.value), JSON.stringify(example.parameters)]);
    const row = result.getRowObjectsJson()[0];
    assert.deepEqual({ ...row, parameters: JSON.parse(row.parameters), value: JSON.parse(row.value) }, example);
  }
});
