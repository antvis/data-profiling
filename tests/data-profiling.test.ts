import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columns, openFixture } from './fixture';

test('data_profiling.sql routes table and column results through protocol v1', async (t) => {
  const connection = await openFixture(t);
  const result = await connection.runAndReadAll("SELECT * FROM data_profiling('sample') ORDER BY columns, metric");
  assert.deepEqual(result.columnNames(), ['protocol_version', 'table_name', 'columns', 'metric', 'parameters', 'value']);
  const rows = result.getRowObjectsJson();
  assert.deepEqual(rows.map(({ columns, metric }) => [columns, metric]), [
    [[], 'column_count'], [[], 'row_count'],
    ...Object.keys(columns).sort().flatMap((name) => [
      [[name], 'missing_count'], [[name], 'present_count'],
    ]),
  ]);
  assert.ok(rows.every((row) => row.protocol_version === 1 && row.table_name === 'sample'));
});
