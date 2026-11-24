import { identifier, kind, nanAsNull, tableSource, type ProfileColumn, type ProfilingConnection } from './duckdb.js';
import { createProfilingPlan } from './plan.js';

export interface ReportRow {
  position: number;
  values: readonly (string | null)[];
}

export interface ReportTableData {
  tableName: string;
  columns: readonly string[];
  numericColumns: readonly string[];
  rowCount: number;
  head: readonly ReportRow[];
  tail: readonly ReportRow[];
  plotRows: readonly ReportRow[];
  duplicates: readonly { count: string; values: readonly (string | null)[] }[];
  missingCorrelation: {
    columnCount: number;
    columns: readonly string[];
    coefficients: readonly (readonly (number | null)[])[];
  };
  timeIndex?: { column: string; kind: 'numeric' | 'date' };
}

export interface ReportDataOptions {
  timeIndex?: string;
  orderBy?: readonly string[];
}

const sampleSize = 10;
const plotSize = 240;
const heatmapSize = 24;
const preview = (field: string) =>
  `CASE WHEN length(${field}::VARCHAR) > 240 THEN left(${field}::VARCHAR, 240) || '…' ELSE ${field}::VARCHAR END`;

/** Collect bounded row previews and whole-table missingness correlations for the offline report. */
export async function collectReportData(
  connection: ProfilingConnection,
  tableName: string,
  columns: readonly ProfileColumn[],
  options: ReportDataOptions = {},
): Promise<ReportTableData> {
  const plan = createProfilingPlan(tableName, columns, { metrics: ['row_count', 'missing_count'], semantics: 'extended' });
  const timeIndex = options.timeIndex === undefined ? undefined : columns.find((column) => column.name === options.timeIndex);
  if (options.timeIndex !== undefined && (!timeIndex || !['numeric', 'date', 'string'].includes(kind(timeIndex.type)))) {
    throw new Error('The report time index must be a numeric, temporal or date-string column');
  }
  const names = columns.map((column) => column.name);
  if (options.orderBy?.some((name) => !names.includes(name))) throw new Error('Unknown report ordering column');
  const order = options.orderBy?.length ? `ORDER BY ${options.orderBy.map(identifier).join(', ')}` : '';
  const read = async (sql: string) => (await connection.runAndReadAll(sql)).getRowObjectsJson();
  const counts = plan.decode((await read(plan.sql))[0]);
  const rowCount = Number(counts.find((row) => row.metric === 'row_count')!.value.value);
  const missing = new Map(counts.filter((row) => row.metric === 'missing_count').map((row) => [row.columns[0], Number(row.value.value)]));
  // Use the same NaN normalization for samples, duplicate groups, and missingness.
  const fields = columns.map(nanAsNull);
  const aliases = fields.map((_, i) => `c${i}`);
  const projection = fields.map((field, i) => `${field} AS ${aliases[i]}`).join(', ');
  const values = aliases.map((alias) => `${preview(alias)} AS ${alias}`).join(', ');
  const rowValues = (row: Record<string, unknown>) => aliases.map((alias) => row[alias] === null ? null : String(row[alias]));
  const source = tableSource(tableName);
  // Sample by row position in DuckDB so previews and plots only transfer a bounded number of rows.
  const step = Math.max(1, Math.ceil((rowCount - 1) / (plotSize - 1)));
  const include = `(p - 1) % ${step} = 0 OR p = ${rowCount}`;
  const rows = rowCount && columns.length ? (await read(
    `WITH numbered AS (SELECT row_number() OVER (${order}) AS p, ${projection} FROM ${source})
      SELECT p::VARCHAR AS position, ${values} FROM numbered
      WHERE p <= ${sampleSize} OR p > ${rowCount - sampleSize} OR ${include} ORDER BY p`,
  )).map((row) => ({ position: Number(row.position), values: rowValues(row) })) : [];
  // Group original values before truncating the display text so distinct rows stay distinct.
  const duplicates = rowCount > 1 && columns.length ? (await read(
    `WITH repeated AS (SELECT count(*) AS n, ${projection} FROM ${source}
      GROUP BY ${fields.join(', ')} HAVING count(*) > 1)
      SELECT n::VARCHAR AS occurrences, ${values} FROM repeated
      ORDER BY n DESC, ${aliases.map((alias) => `repeated.${alias}::VARCHAR`).join(', ')} LIMIT ${sampleSize}`,
  )).map((row) => ({ count: String(row.occurrences), values: rowValues(row) })) : [];
  // Correlate whole-table missingness flags only where they have nonzero variance.
  const varying = columns.flatMap((column, i) => {
    const count = missing.get(column.name) ?? 0;
    return count > 0 && count < rowCount ? [i] : [];
  });
  const heatmap = varying.slice(0, heatmapSize);
  const pairs = heatmap.flatMap((a, i) => heatmap.slice(i + 1).map((b, offset) => ({ a, b, i, j: i + offset + 1 })));
  const coefficients: (number | null)[][] = heatmap.map((_, i) => heatmap.map((_, j) => i === j ? 1 : null));
  if (pairs.length) {
    const sql = pairs.map(({ a, b }, i) => `corr((${fields[a]} IS NULL)::INTEGER, (${fields[b]} IS NULL)::INTEGER) AS p${i}`);
    const [row] = await read(`SELECT ${sql.join(', ')} FROM ${source}`);
    pairs.forEach(({ i, j }, index) => {
      const value = row[`p${index}`];
      if (typeof value === 'number' && Number.isFinite(value)) coefficients[i][j] = coefficients[j][i] = Math.max(-1, Math.min(1, value));
    });
  }
  return {
    tableName,
    columns: names,
    numericColumns: columns.filter((column) => kind(column.type) === 'numeric').map((column) => column.name),
    rowCount,
    head: rows.filter(({ position }) => position <= sampleSize),
    tail: rowCount > sampleSize ? rows.filter(({ position }) => position > rowCount - sampleSize) : [],
    plotRows: rows.filter(({ position }) => (position - 1) % step === 0 || position === rowCount),
    duplicates,
    missingCorrelation: { columnCount: varying.length, columns: heatmap.map((i) => names[i]), coefficients },
    timeIndex: timeIndex && { column: timeIndex.name, kind: kind(timeIndex.type) === 'numeric' ? 'numeric' : 'date' },
  };
}
