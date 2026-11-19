const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openFixture } = require('./fixture.cjs');
const input = require('./fixtures/input.json');

test('data_profiling.sql routes table and column results through protocol v1', async (t) => {
  const connection = await openFixture(t);
  const result = await connection.runAndReadAll("SELECT * FROM data_profiling('sample') ORDER BY columns, metric");
  assert.deepEqual(result.columnNames(), ['protocol_version', 'table_name', 'columns', 'metric', 'parameters', 'value']);
  const rows = result.getRowObjectsJson();
  assert.deepEqual(rows.map(({ columns, metric }) => [columns, metric]), [
    [[], 'column_count'], [[], 'row_count'],
    ...Object.keys(input.columns).sort().map((name) => [[name], 'missing_count']),
  ]);
  assert.ok(rows.every((row) => row.protocol_version === 1 && row.table_name === 'sample'));
});
