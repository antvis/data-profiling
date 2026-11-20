import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openFixture, parseValues } from '../fixture.js';

test('table.sql returns row and column counts', async (t) => {
  const connection = await openFixture(t);
  const result = await connection.runAndReadAll(`
    SELECT data_profiling_row_count() AS row_count,
      data_profiling_column_count('sample') AS column_count FROM sample
  `);
  assert.deepEqual(parseValues(result.getRowObjectsJson()[0]), {
    row_count: { type: 'integer', value: '5' },
    column_count: { type: 'integer', value: '5' },
  });
});
