const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openFixture, parseValues } = require('../fixture.cjs');
const { expected } = require('../fixtures/table.json');

test('table.sql matches fg-data-profiling', async (t) => {
  const connection = await openFixture(t);
  const result = await connection.runAndReadAll(`
    SELECT data_profiling_row_count() AS row_count,
      data_profiling_column_count('sample') AS column_count FROM sample
  `);
  assert.deepEqual(parseValues(result.getRowObjectsJson()[0]), expected);
});
