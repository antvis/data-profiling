import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { BASIC_METRICS, profile } from 'data_profiling';
import { renderReport } from 'data_profiling/report';

const output = resolve(process.argv[2] ?? 'artifacts/anomaly-experiment');
const python = process.env.PROFILING_PYTHON ?? 'python3';
await mkdir(output, { recursive: true });
let seed = 20261121;
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
const round = (number) => Math.round(number * 100) / 100;
const channels = ['web', 'store', 'app', 'partner'];
const regions = ['East', 'West', 'North', 'South'];
const clean = Array.from({ length: 2400 }, (_, i) => {
  const event = new Date(Date.UTC(2026, 10, 1 + Math.floor(i / 80), 8, (i % 80) * 10));
  const units = 1 + Math.floor(random() * 5);
  const unitPrice = round(10 + random() * 100);
  const amount = round(units * unitPrice);
  const channel = channels[i % 4];
  const customer = Math.floor(random() * 400);
  const status = random();
  return {
    order_id: `O${String(i + 1).padStart(6, '0')}`,
    customer_id: `C${String(customer).padStart(4, '0')}`,
    event_time: event.toISOString(),
    ingest_time: new Date(+event + (1 + Math.floor(random() * 60)) * 60000).toISOString(),
    settlement_date: new Date(+event + 2 * 86400000).toISOString().slice(0, 10),
    channel, region: regions[Math.floor(i / 4) % 4],
    status: status < 0.8 ? 'paid' : status < 0.95 ? 'pending' : 'cancelled',
    units, unit_price: unitPrice, amount, settled_amount: amount,
    freight: channel === 'store' ? 0 : 8 + 2 * Math.floor(random() * 5),
    contact: `customer_${customer}@example.test`, currency: 'CNY',
  };
});
const changed = structuredClone(clean);
for (let i = 100; i < 196; i++) changed[i].customer_id = null;
for (let i = 300; i < 312; i++) changed[i].amount = round(changed[i].amount * 100);
for (let i = 400; i < 408; i++) changed[i].amount *= -1;
for (let i = 500; i < 540; i++) changed[i].amount = 0;
for (let i = 600; i < 624; i++) changed[i].status = ['PAID', 'paid ', ' paid'][i % 3];
for (let i = 700; i < 720; i++) changed[i].contact = '';
for (let i = 720; i < 740; i++) changed[i].contact = '   ';
for (let i = 740; i < 760; i++) changed[i].contact = null;
for (let i = 800; i < 816; i++) changed[i].settlement_date = i % 2 ? 'unknown' : '2026-02-30';
for (let i = 900; i < 925; i++) changed[i].ingest_time = new Date(+new Date(changed[i].event_time) - 3600000).toISOString();
for (const row of changed) {
  if (row.event_time >= '2026-11-24' && row.channel === 'partner' && row.region === 'South') row.freight = 0;
}
const observed = changed.filter((row) => !(row.channel === 'partner' &&
  ['2026-11-13', '2026-11-14'].includes(row.event_time.slice(0, 10))));
observed.push(...changed.slice(0, 40).map((row) => ({ ...row })));
assert.equal(observed.length, clean.length);

const manifest = {
  seed: 20261121, rows: 2400, days: 30, rows_per_day: 80,
  note: 'Fully synthetic. No anomaly labels are included in the input datasets. This manifest is not supplied to profile().',
  injections: {
    customer_null: 96, amount_times_100: 12, negative_amount: 8, zero_amount: 40,
    status_variants: 24, contact_empty: 20, contact_whitespace: 20, contact_null: 20,
    invalid_date: 16, reversed_timestamps: 25, partner_south_recent_zero_freight: 35,
    removed_rows: 40, duplicated_rows: 40,
  },
  controls: ['Currency is always CNY.', 'Store freight is always zero in both datasets.'],
};
for (const [name, data] of Object.entries({ clean, observed, manifest })) {
  await writeFile(join(output, `${name}.json`), JSON.stringify(data, null, 2));
}

const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
const connection = await instance.connect();
const lit = (value) => `'${value.replaceAll("'", "''")}'`;
const schema = async (table) => (await connection.runAndReadAll(
  'SELECT name,type FROM pragma_table_info(?)', [table]
)).getRowObjectsJson();
const unpack = (value) => value.type === 'list' ? value.value.map(unpack)
  : value.type === 'object' ? Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, unpack(item)]))
  : value.value;
const basic = {};
const results = {};
let cleanSchema;
const get = (table, metric, column) => {
  const row = results[table].find((item) => item.metric === metric &&
    (column === undefined ? item.columns.length === 0 : item.columns.length === 1 && item.columns[0] === column));
  assert.ok(row, `Missing profile metric: ${table}.${column ?? ''}.${metric}`);
  return unpack(row.value);
};
const extended = [
  'row_count', 'column_count', 'profiling_type', 'declared_type', 'observation_count',
  'missing_count', 'missing_rate', 'missing_cell_rate', 'distinct_count', 'duplicate_count',
  'duplicate_group_count', 'min', 'max', 'mean', 'median', 'stddev_samp', 'skewness',
  'zero_count', 'zero_rate', 'negative_count', 'negative_rate', 'min_length', 'max_length',
  'quantiles', 'numeric_histogram', 'invalid_date_count', 'invalid_date_rate',
  'min_timestamp', 'max_timestamp',
];
const sliceMetrics = [
  'row_count', 'observation_count', 'missing_count', 'distinct_count', 'min', 'max',
  'mean', 'median', 'stddev_samp', 'zero_count', 'zero_rate', 'negative_count', 'negative_rate',
];
try {
  await connection.run("SET TimeZone='UTC'");
  for (const name of ['clean', 'observed']) {
    const table = `orders_${name}`;
    await connection.run(`CREATE TABLE ${table} AS SELECT * REPLACE (
      event_time::TIMESTAMPTZ AS event_time, ingest_time::TIMESTAMPTZ AS ingest_time,
      settlement_date::VARCHAR AS settlement_date,
      units::INTEGER AS units, amount::DOUBLE AS amount, settled_amount::DOUBLE AS settled_amount,
      unit_price::DOUBLE AS unit_price, freight::DOUBLE AS freight
    ) FROM read_json_auto(${lit(join(output, `${name}.json`))})`);
    await connection.run(`COPY ${table} TO ${lit(join(output, `${name}.parquet`))} (FORMAT PARQUET)`);
    await connection.run(`COPY ${table} TO ${lit(join(output, `${name}.csv`))} (FORMAT CSV, HEADER)`);
    const columns = await schema(table);
    if (name === 'clean') cleanSchema = columns;
    else assert.deepEqual(columns, cleanSchema);
    basic[name] = await profile(connection, table, columns, { metrics: BASIC_METRICS });
    results[table] = await profile(connection, table, columns, {
      metrics: extended, types: { settlement_date: 'date' }, python,
      quantiles: [0.5, 0.95, 0.99, 0.999], bins: 20,
    });
    results[table].push(...await profile(connection, table, columns.filter((column) =>
      ['status', 'channel', 'region', 'contact'].includes(column.name)), { metrics: ['value_counts'] }));
    results[table].push(...await profile(connection, table, columns.filter((column) =>
      ['amount', 'settled_amount'].includes(column.name)), { metrics: ['pearson_r'] }));
    await connection.run(`CREATE VIEW daily_channels_${name} AS WITH counts AS (
      SELECT event_time::DATE AS day, channel, count(*) AS records FROM ${table} GROUP BY 1,2
    ) SELECT calendar.day, channel.channel, coalesce(counts.records, 0)::INTEGER AS records
      FROM (SELECT DATE '2026-11-01' + i::INTEGER AS day FROM range(30) t(i)) calendar
      CROSS JOIN (SELECT DISTINCT channel FROM orders_clean) channel
      LEFT JOIN counts USING (day,channel)`);
    await connection.run(`CREATE VIEW partner_south_recent_${name} AS SELECT freight FROM ${table}
      WHERE event_time >= TIMESTAMPTZ '2026-11-24 00:00:00+00' AND channel='partner' AND region='South'`);
    await connection.run(`CREATE VIEW store_${name} AS SELECT freight FROM ${table} WHERE channel='store'`);
    await connection.run(`CREATE VIEW ingest_lag_${name} AS SELECT
      epoch(ingest_time)-epoch(event_time) AS lag_seconds FROM ${table}`);
    for (const prefix of ['daily_channels', 'partner_south_recent', 'store', 'ingest_lag']) {
      const view = `${prefix}_${name}`;
      results[view] = await profile(connection, view, await schema(view), { metrics: sliceMetrics });
    }
  }
  const comparison = (metric, column, prefix = 'orders') => ({
    clean: get(`${prefix}_clean`, metric, column), observed: get(`${prefix}_observed`, metric, column),
  });
  const correlation = (name) => unpack(results[`orders_${name}`].find((row) => row.metric === 'pearson_r').value);
  const signals = {
    row_count: comparison('row_count'), unique_order_ids: comparison('distinct_count', 'order_id'),
    duplicate_groups: comparison('duplicate_group_count'), customer_missing_rate: comparison('missing_rate', 'customer_id'),
    table_missing_cell_rate: comparison('missing_cell_rate'),
    amount: Object.fromEntries(['min', 'max', 'mean', 'median', 'stddev_samp', 'quantiles', 'negative_count', 'zero_count']
      .map((metric) => [metric, comparison(metric, 'amount')])),
    status_distinct: comparison('distinct_count', 'status'), status_values: comparison('value_counts', 'status'),
    contact_nulls: comparison('missing_count', 'contact'), contact_min_length: comparison('min_length', 'contact'),
    contact_null_rate: comparison('missing_rate', 'contact'),
    contact_blank_values: get('orders_observed', 'value_counts', 'contact').filter((item) => item.value.trim() === ''),
    invalid_dates: comparison('invalid_date_count', 'settlement_date'),
    settlement_nulls: comparison('missing_count', 'settlement_date'),
    amount_correlation: { clean: correlation('clean'), observed: correlation('observed') },
    global_freight_zero_rate: comparison('zero_rate', 'freight'),
    recent_partner_south_zero_rate: comparison('zero_rate', 'freight', 'partner_south_recent'),
    recent_partner_south_distinct: comparison('distinct_count', 'freight', 'partner_south_recent'),
    recent_partner_south_rows: comparison('row_count', undefined, 'partner_south_recent'),
    store_zero_rate_control: comparison('zero_rate', 'freight', 'store'),
    currency_distinct_control: comparison('distinct_count', 'currency'),
    daily_channels: Object.fromEntries(['min', 'max', 'mean', 'zero_count'].map((metric) =>
      [metric, comparison(metric, 'records', 'daily_channels')])),
    negative_ingest_lags: comparison('negative_count', 'lag_seconds', 'ingest_lag'),
  };
  const verificationSql = `SELECT count(*) AS rows, count(DISTINCT order_id) AS order_ids,
    count(*) FILTER (WHERE customer_id IS NULL) AS customer_nulls,
    count(*) FILTER (WHERE amount < 0) AS negative_amounts,
    count(*) FILTER (WHERE amount = 0) AS zero_amounts,
    count(*) FILTER (WHERE contact IS NULL) AS contact_nulls,
    count(*) FILTER (WHERE contact IS NOT NULL AND trim(contact)='') AS blank_contacts,
    count(*) FILTER (WHERE try_cast(settlement_date AS DATE) IS NULL) AS invalid_dates,
    count(*) FILTER (WHERE ingest_time < event_time) AS reversed_timestamps
    FROM orders_observed`;
  const verification = (await connection.runAndReadAll(verificationSql)).getRowObjectsJson()[0];
  assert.deepEqual(Object.fromEntries(Object.entries(verification).map(([key, value]) => [key, Number(value)])), {
    rows: 2400, order_ids: 2360, customer_nulls: 96, negative_amounts: 8, zero_amounts: 40,
    contact_nulls: 20, blank_contacts: 40, invalid_dates: 16, reversed_timestamps: 25,
  });
  assert.equal(Number(signals.duplicate_groups.observed), 40);
  assert.equal(signals.customer_missing_rate.observed, 0.04);
  assert.equal(Number(signals.invalid_dates.observed), 16);
  assert.equal(Number(signals.amount.negative_count.observed), 8);
  assert.equal(Number(signals.amount.zero_count.observed), 40);
  assert.equal(Number(signals.status_distinct.observed), 6);
  assert.deepEqual(signals.contact_blank_values.map((item) => Number(item.count)), [20, 20]);
  assert.ok(signals.amount.max.observed > signals.amount.max.clean * 10);
  assert.ok(signals.amount.mean.observed > signals.amount.mean.clean * 1.2);
  assert.ok(Math.abs(signals.amount.median.observed / signals.amount.median.clean - 1) < 0.2);
  assert.ok(signals.amount_correlation.observed < signals.amount_correlation.clean);
  assert.deepEqual(signals.recent_partner_south_zero_rate, { clean: 0, observed: 1 });
  assert.deepEqual(signals.recent_partner_south_rows, { clean: '35', observed: '35' });
  assert.deepEqual(signals.store_zero_rate_control, { clean: 1, observed: 1 });
  assert.deepEqual(signals.currency_distinct_control, { clean: '1', observed: '1' });
  assert.deepEqual(signals.daily_channels.mean, { clean: 20, observed: 20 });
  assert.equal(Number(signals.daily_channels.zero_count.observed), 2);
  assert.equal(Number(signals.negative_ingest_lags.observed), 25);
  for (const [table, rows] of Object.entries(results)) {
    assert.equal(new Set(rows.map((row) => JSON.stringify([row.columns, row.metric]))).size, rows.length,
      `Duplicate metric targets in ${table}`);
  }
  for (const [name, data] of Object.entries({ basic, profiles: results, signals, verification })) {
    await writeFile(join(output, `${name}.json`), JSON.stringify(data, null, 2));
  }
  await writeFile(join(output, 'verification.sql'), verificationSql);
  await writeFile(join(output, 'ava-verification.sql'), verificationSql.replaceAll('orders_observed', '"data"'));
  await writeFile(join(output, 'report.html'), renderReport(Object.values(results).flat(), {
    title: '合成数据异常画像实验：对照、观测与分组', language: 'zh-CN',
  }));
  console.log(JSON.stringify({ output, signals }, null, 2));
} finally {
  connection.closeSync();
  instance.closeSync();
}
