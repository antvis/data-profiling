import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileFormat, plainValue, profileDataset, MAX_FILE_BYTES } from '../site/profiling.js';
import { openFixture } from './fixture.js';
import type { ProfileColumn } from 'data_profiling';

test('browser profiling reuses native plans and changes output with report configuration', async (t) => {
  const connection = await openFixture(t);
  const columns = (await connection.runAndReadAll("SELECT name,type FROM pragma_table_info('sample')")).getRowObjectsJson() as ProfileColumn[];
  const basic = await profileDataset(connection, 'sample', columns, { mode: 'overview', bins: 10, correlations: false });
  const detailed = await profileDataset(connection, 'sample', columns, { mode: 'detailed', bins: 20, correlations: true });
  assert.equal(basic.find((row) => row.metric === 'row_count')?.value.value, '5');
  assert.equal(basic.find((row) => row.metric === 'duplicate_group_count')?.value.value, '0');
  assert.ok(basic.some((row) => row.metric === 'numeric_histogram' && row.parameters.bins === 10));
  assert.ok(!basic.some((row) => row.metric === 'pearson_r' || row.metric === 'skewness'));
  assert.ok(detailed.some((row) => row.metric === 'pearson_r'));
  assert.ok(detailed.some((row) => row.metric === 'skewness'));
  assert.ok(detailed.some((row) => row.metric === 'quantiles'));
  assert.ok(detailed.some((row) => row.metric === 'numeric_histogram' && row.parameters.bins === 20));
});

test('browser transport retains exact integers and decimals and handles prototype-like fields', async (t) => {
  const connection = await openFixture(t);
  await connection.run(`CREATE TABLE precise AS SELECT 9007199254740993::BIGINT AS "__proto__",
    1234567890.123456789::DECIMAL(30,9) AS "toJSON"`);
  const rows = await profileDataset(connection, 'precise', [{ name: '__proto__', type: 'BIGINT' },
    { name: 'toJSON', type: 'DECIMAL(30,9)' }], { mode: 'overview', bins: 10, correlations: false });
  assert.equal(rows.find((row) => row.metric === 'min' && row.columns[0] === '__proto__')?.value.value, '9007199254740993');
  assert.equal(rows.find((row) => row.metric === 'min' && row.columns[0] === 'toJSON')?.value.value, '1234567890.123456789');
  assert.deepEqual(plainValue({ toJSON: () => ({ list: { toArray: () => [{ value: 9007199254740993n, count: 2n }] }, n: NaN }) }),
    { list: [{ value: '9007199254740993', count: '2' }], n: NaN });
  assert.deepEqual(plainValue({ toArray: () => ['金额', 'DOUBLE'], toJSON: () => ({ name: '金额', type: 'DOUBLE' }) }),
    { name: '金额', type: 'DOUBLE' });
});

test('upload validation rejects unsupported, empty and oversized files before reading them', () => {
  assert.equal(fileFormat({ name: 'orders.CSV', size: 100 }), 'csv');
  assert.equal(fileFormat({ name: 'data.json', size: 100 }), 'json');
  assert.equal(fileFormat({ name: 'data.parquet', size: 100 }), 'parquet');
  assert.throws(() => fileFormat({ name: 'data.csv', size: 0 }), /文件为空/);
  assert.throws(() => fileFormat({ name: 'data.csv', size: MAX_FILE_BYTES + 1 }), /20 MB/);
  assert.throws(() => fileFormat({ name: 'data.xlsx', size: 100 }), /支持 CSV/);
});
