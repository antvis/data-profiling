import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openFixture, parseValues } from '../fixture';

test('missingness.sql counts partial, complete and entirely missing columns', async (t) => {
  const connection = await openFixture(t);
  for (const metric of ['missing_count', 'null_count']) {
    const result = await connection.runAndReadAll(`
      SELECT data_profiling_${metric}(COLUMNS(*)) AS "\\0" FROM sample
    `);
    assert.deepEqual(parseValues(result.getRowObjectsJson()[0]), {
      amount: { type: 'integer', value: '1' },
      channel: { type: 'integer', value: '1' },
      approved: { type: 'integer', value: '1' },
      empty: { type: 'integer', value: '5' },
      complete: { type: 'integer', value: '0' },
    });
  }
});
