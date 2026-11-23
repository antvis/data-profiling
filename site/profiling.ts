import { additionalMetricIds, createProfilingPlan, kind, nanAsNull, scalar, type ProfileColumn, type MetricConfig } from '../src/plan.js';
import { nativeDistributions } from '../src/distributions.js';
import type { ProfileOptions, ProfilingConnection } from '../src/profile.js';
import type { ReportTableData } from '../src/report-data.js';
import type { ProfileResult } from '../src/types.js';

export interface PlaygroundOptions {
  mode: 'overview' | 'detailed';
  bins: number;
  correlations: boolean;
}

export type FullProfileOptions = Pick<ProfileOptions, 'types' | 'timeIndex' | 'orderBy' | 'bins'>;

export async function profileFullDataset(file: File | undefined, options: FullProfileOptions): Promise<{
  results: ProfileResult[];
  tableData?: ReportTableData;
}> {
  const form = new FormData();
  form.set('options', JSON.stringify(options));
  if (file) form.set('dataset', file);
  const request: RequestInit & { targetAddressSpace: 'loopback' } = {
    method: 'POST',
    headers: { 'X-Data-Profiling': '1' },
    body: form,
    credentials: 'omit',
    redirect: 'error',
    targetAddressSpace: 'loopback',
  };
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:5174/api/full-profile', request);
  } catch {
    throw new Error('无法连接本机引擎。请运行 npm run full:site，允许浏览器访问本机，或打开本机体验页。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.results)) {
    throw new Error(typeof data?.error === 'string' ? data.error : '本机引擎返回了无法读取的结果。');
  }
  return { results: data.results, tableData: data.tableData };
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function fileFormat(file: { name: string; size: number }): 'csv' | 'json' | 'parquet' {
  if (!file.size) throw new Error('文件为空，请选择包含数据的文件。');
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 20 MB，请选择更小的文件。');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (extension !== 'csv' && extension !== 'json' && extension !== 'parquet') {
    throw new Error('支持 CSV、JSON 和 Parquet 文件。');
  }
  return extension;
}

export function plainValue(value: unknown): unknown {
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(plainValue);
  if (value !== null && typeof value === 'object') {
    const object = value as { toArray?: () => Iterable<unknown>; toJSON?: () => unknown };
    if (typeof object.toJSON === 'function') return plainValue(object.toJSON());
    if (typeof object.toArray === 'function') return Array.from(object.toArray(), plainValue);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item)]));
  }
  return value;
}

const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function profileDataset(
  connection: ProfilingConnection,
  table: string,
  columns: readonly ProfileColumn[],
  options: PlaygroundOptions,
): Promise<ProfileResult[]> {
  if (!columns.length) throw new Error('没有可分析的列。');
  if (!['overview', 'detailed'].includes(options.mode) || ![0, 10, 20, 30, 50].includes(options.bins) ||
      typeof options.correlations !== 'boolean') throw new Error('无效的统计配置。');
  const metrics: MetricConfig[] = [
    'row_count', 'column_count', 'missing_cell_count', 'missing_cell_rate', 'profiling_type', 'declared_type',
    'observation_count', 'present_count', 'missing_count', 'missing_rate', 'distinct_count',
    'min', 'max', 'mean', 'median', 'stddev_samp',
    { id: 'top_values', limit: 12, maxDistinctRatio: 1 },
  ];
  if (options.mode === 'detailed') {
    const existing = new Set(metrics.filter((metric) => typeof metric === 'string'));
    metrics.push('sum', 'duplicate_count', 'min_length', 'max_length', ...additionalMetricIds.filter((id) => !existing.has(id)));
  }
  const plan = createProfilingPlan(table, columns, { metrics, semantics: 'extended' });
  const exact = [...new Set(plan.metrics.filter((metric) => ['integer', 'decimal', 'duration'].includes(metric.type)).map((metric) => metric.alias))];
  // Arrow exposes decimal limbs; cast exact aggregates before crossing the browser boundary.
  const sql = exact.length
    ? `SELECT * REPLACE (${exact.map((alias) => `${q(alias)}::VARCHAR AS ${q(alias)}`).join(', ')}) FROM (${plan.sql})`
    : plan.sql;
  const rows = plan.decode((await connection.runAndReadAll(sql)).getRowObjectsJson()[0]);
  const distributions = await nativeDistributions(connection, table, columns,
    new Map(['numeric_histogram', ...(options.mode === 'detailed' ? ['quantiles'] : [])].map((id) => [id, true])),
    { bins: options.bins, maxBins: 50 });
  rows.push(...distributions.results);
  const source = `query_table(${literal(table)})`;
  const duplicates = (await connection.runAndReadAll(
    `SELECT count(*)::VARCHAR AS n FROM (SELECT 1 FROM ${source} GROUP BY ${columns.map(nanAsNull).join(', ')} HAVING count(*) > 1)`
  )).getRowObjectsJson()[0];
  rows.push({ protocol_version: 1, table_name: table, columns: [], metric: 'duplicate_group_count', parameters: {}, value: scalar('integer', duplicates.n) });
  if (options.correlations) {
    // shortcut: browser correlations cover 20 numeric columns; add column selection for wider inputs.
    const numeric = columns.filter((column) => kind(column.type) === 'numeric').slice(0, 20);
    const pairs = numeric.flatMap((a, i) => numeric.slice(i + 1).map((b) => [a.name, b.name]));
    if (pairs.length) {
      const row = (await connection.runAndReadAll(`SELECT ${pairs.map(([a, b], i) =>
        `corr(${q(a)}, ${q(b)}) FILTER (WHERE isfinite(${q(a)}) AND isfinite(${q(b)})) AS p${i}`
      ).join(', ')} FROM ${source}`)).getRowObjectsJson()[0];
      pairs.forEach((pair, i) => rows.push({ protocol_version: 1, table_name: table, columns: pair,
        metric: 'pearson_r', parameters: {}, value: scalar('number', row[`p${i}`]) }));
    }
  }
  return rows;
}
