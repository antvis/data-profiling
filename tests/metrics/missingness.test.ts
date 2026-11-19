import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openFixture, parseValues } from '../fixture';

test('missingness.sql returns missing and present counts', async (t) => {
  const connection = await openFixture(t);
  const result = await connection.runAndReadAll(`
    SELECT data_profiling_missing_count(COLUMNS(*)) AS "\\0" FROM sample
  `);
  assert.deepEqual(parseValues(result.getRowObjectsJson()[0]), {
    amount: { type: 'integer', value: '1' },
    channel: { type: 'integer', value: '1' },
    approved: { type: 'integer', value: '1' },
    empty: { type: 'integer', value: '5' },
    complete: { type: 'integer', value: '0' },
  });
  const present = await connection.runAndReadAll(`
    SELECT data_profiling_present_count(COLUMNS(*)) AS "\\0" FROM sample
  `);
  assert.deepEqual(parseValues(present.getRowObjectsJson()[0]), {
    amount: { type: 'integer', value: '4' },
    channel: { type: 'integer', value: '4' },
    approved: { type: 'integer', value: '4' },
    empty: { type: 'integer', value: '0' },
    complete: { type: 'integer', value: '5' },
  });
});
