const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openFixture, parseValues } = require('../fixture.cjs');
const { expected } = require('../fixtures/missingness.json');

test('missingness.sql matches fg-data-profiling', async (t) => {
  const connection = await openFixture(t);
  const result = await connection.runAndReadAll(`
    SELECT data_profiling_missing_count(COLUMNS(*)) AS "\\0" FROM sample
  `);
  assert.deepEqual(parseValues(result.getRowObjectsJson()[0]), expected);
});
