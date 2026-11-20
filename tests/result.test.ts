import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileResult, ProfileRow } from 'data_profiling';
import { openFixture } from './fixture';

test('result.sql preserves pair targets, parameters and nested typed values', async (t) => {
  const connection = await openFixture(t);
  const expected: ProfileResult = {
    protocol_version: 1,
    table_name: 'sample',
    columns: ['amount', 'complete'],
    metric: 'protocol_test',
    parameters: { probabilities: [0.5] },
    value: {
      type: 'object',
      value: {
        exact: { type: 'decimal', value: '12345678901234567890.123456789' },
        counts: { type: 'list', value: [{ type: 'integer', value: '9007199254740993' }] },
        coefficient: { type: 'number', value: 0.75 },
        timestamp: { type: 'timestamptz', value: '2026-11-19T09:00:00.123456789Z' },
      },
    },
  };
  const result = await connection.runAndReadAll(`
    SELECT unnest(data_profiling_result(?, ?::JSON::VARCHAR[], ?, ?::JSON, ?::JSON))
  `, [expected.table_name, JSON.stringify(expected.columns), expected.metric,
    JSON.stringify(expected.value), JSON.stringify(expected.parameters)]);
  const row = result.getRowObjectsJson()[0] as ProfileRow;
  assert.deepEqual({ ...row, parameters: JSON.parse(row.parameters), value: JSON.parse(row.value) }, expected);
});
