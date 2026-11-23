import { writeFile } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { collectReportData, profile } from 'data_profiling';
import { renderReport } from 'data_profiling/report';
import packageMetadata from '../package.json' with { type: 'json' };

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
try {
  await connection.run(`CREATE TABLE "订单" AS SELECT
    i + 1001 AS "订单编号",
    CASE WHEN i % 11 = 0 THEN NULL ELSE round(20 + (i % 17) * 8.75, 2)::DOUBLE END AS "金额",
    1 + i % 5 AS "件数",
    CASE WHEN i % 13 = 0 THEN NULL ELSE ['线上', '门店', '合作伙伴'][1 + i % 3] END AS "渠道",
    ['华东', '华西', '华北', '华南'][1 + i % 4] AS "地区",
    DATE '2026-11-01' + (i % 21)::INTEGER AS "下单日期"
    FROM range(128) t(i)`);
  const columns = (
    await connection.runAndReadAll("SELECT name,type FROM pragma_table_info('订单')")
  ).getRowObjectsJson();
  const started = performance.now();
  const settings = {
    metrics: [
      'row_count', 'column_count', 'column_type_counts', 'missing_cell_count', 'missing_cell_rate',
      'duplicate_group_count', 'profiling_type', 'declared_type', 'observation_count', 'present_count',
      'missing_count', 'missing_rate', 'distinct_count', 'min', 'max', 'mean', 'median', 'stddev_samp',
      'quantiles', 'numeric_histogram', 'value_counts', 'pearson_r',
    ],
    bins: 12,
    timeIndex: '订单编号',
  };
  const results = await profile(connection, '订单', columns, settings);
  const tableData = await collectReportData(connection, '订单', columns, settings);
  const output = process.argv[2] ?? 'orders-report.html';
  await writeFile(output, renderReport(results, {
    title: '订单数据画像', language: 'zh-CN', tableData: [tableData],
    run: { generatedAt: new Date().toISOString(), libraryVersion: packageMetadata.version, durationMs: performance.now() - started, configuration: settings },
  }), 'utf8');
  console.log(output);
} finally {
  connection.closeSync();
  instance.closeSync();
}
