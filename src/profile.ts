import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifier, kind, literal, nanAsNull, tableSource, validateProfilingTarget, type ProfileColumn, type ProfilingConnection } from './duckdb.js';
import { createProfilingPlan, type MetricConfig, type ProfilingOptions } from './plan.js';
import { ALL_METRICS, metricFamilies, nativeMetricIds } from './metrics.js';
import { nativeDistributions } from './distributions.js';
import { runPythonWorker } from './python-worker.js';
import { scalar, type MetricValue, type ProfileResult } from './types.js';

export interface ProfileOptions extends Omit<ProfilingOptions, 'semantics'> {
  types?: Readonly<
    Record<
      string,
      'numeric' | 'categorical' | 'text' | 'boolean' | 'date' | 'url' | 'path' | 'file' | 'image' | 'timeseries'
    >
  >;
  timeIndex?: string;
  orderBy?: readonly string[];
  python?: string;
  fileRoot?: string;
  quantiles?: readonly number[];
  bins?: number;
  maxBins?: number;
  density?: boolean;
  stopWords?: readonly string[];
  lags?: number;
  significance?: number;
  maxlag?: number;
  autolag?: 'AIC' | 'BIC' | 't-stat' | null;
  memoryDeep?: boolean;
}
const id = (value: MetricConfig) => (typeof value === 'string' ? value : value.id);
const integer = (value: unknown): MetricValue => scalar('integer', value);
const number = (value: number): MetricValue => scalar('number', value);
const labels = {
  numeric: 'Numeric',
  categorical: 'Categorical',
  text: 'Text',
  boolean: 'Boolean',
  date: 'DateTime',
  url: 'URL',
  path: 'Path',
  file: 'File',
  image: 'Image',
  timeseries: 'TimeSeries',
};

/** Frequency entries keep the source column's type, while their counts are always exact integers. */
function fieldValue(raw: unknown, type: string): MetricValue {
  if (raw == null) return { type: 'null', value: null };
  if (/^BOOLEAN$/i.test(type)) return scalar('boolean', raw);
  if (/^(DECIMAL|NUMERIC)/i.test(type)) return scalar('decimal', raw);
  if (/^(FLOAT|DOUBLE|REAL)$/i.test(type)) return scalar('number', raw);
  if (/^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT[1248]?|BIGNUM)$/i.test(type)) return integer(raw);
  return scalar(
    /^DATE$/i.test(type)
      ? 'date'
      : /^TIMESTAMP(TZ| WITH TIME ZONE)$/i.test(type)
      ? 'timestamptz'
      : /^TIMESTAMP/i.test(type)
      ? 'timestamp'
      : 'string',
    raw
  );
}

function role(column: ProfileColumn, options: ProfileOptions): string {
  const type = kind(column.type);
  return assignedType(column.name, options) ?? (type === 'string' ? 'categorical' : type);
}

function assignedType(name: string, options: ProfileOptions) {
  // A column named after an Object prototype property needs an explicit role like any other column.
  return options.types && Object.hasOwn(options.types, name) ? options.types[name] : undefined;
}

function validateOptions(columns: readonly ProfileColumn[], options: ProfileOptions): void {
  const optionNames = [
    'metrics',
    'types',
    'timeIndex',
    'orderBy',
    'python',
    'fileRoot',
    'quantiles',
    'bins',
    'maxBins',
    'density',
    'stopWords',
    'lags',
    'significance',
    'maxlag',
    'autolag',
    'memoryDeep',
  ];
  for (const key of Object.keys(options))
    if (!optionNames.includes(key)) throw new Error(`Unknown profiling option: ${key}`);
  for (const key of ['metrics', 'quantiles', 'stopWords', 'orderBy'] as const)
    if (options[key] !== undefined && !Array.isArray(options[key])) throw new Error(`Invalid ${key}`);
  for (const key of ['timeIndex', 'python', 'fileRoot'] as const)
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key]))
      throw new Error(`Invalid ${key}`);
  const names = new Set(columns.map((column) => column.name));
  for (const name of [
    ...Object.keys(options.types ?? {}),
    ...(options.orderBy ?? []),
    ...(options.timeIndex ? [options.timeIndex] : []),
  ]) {
    if (!names.has(name)) throw new Error(`Unknown column: ${name}`);
  }
  for (const value of Object.values(options.types ?? {}))
    if (!Object.hasOwn(labels, value)) throw new Error(`Unknown profile type: ${value}`);
  for (const column of columns) {
    const type = assignedType(column.name, options);
    const inferred = role(column, {});
    if (
      type &&
      ((['numeric', 'timeseries'].includes(type) && inferred !== 'numeric') ||
        (type === 'boolean' && inferred !== 'boolean') ||
        (['categorical', 'text', 'url', 'path', 'file', 'image'].includes(type) && inferred !== 'categorical') ||
        (type === 'date' && !['date', 'categorical'].includes(inferred)))
    )
      throw new Error(`Incompatible profile type for ${column.name}: ${type}`);
  }
  if (
    options.timeIndex &&
    !['numeric', 'date'].includes(role(columns.find((column) => column.name === options.timeIndex)!, options))
  )
    throw new Error('timeIndex must be numeric or temporal');
  for (const key of ['density', 'memoryDeep'] as const)
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  for (const [key, value, min, max] of [
    ['bins', options.bins, 0, 100000],
    ['maxBins', options.maxBins, 1, 100000],
    ['lags', options.lags, 0, 100000],
    ['maxlag', options.maxlag, 0, 100000],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
      throw new Error(`Invalid ${key}`);
  }
  if (
    options.significance !== undefined &&
    (!Number.isFinite(options.significance) || options.significance <= 0 || options.significance >= 1)
  )
    throw new Error('Invalid significance');
  if (
    options.quantiles &&
    (!options.quantiles.length || options.quantiles.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
  )
    throw new Error('Invalid quantiles');
  if (options.stopWords && options.stopWords.some((value) => typeof value !== 'string'))
    throw new Error('Invalid stopWords');
  if (options.autolag !== undefined && options.autolag !== null && !['AIC', 'BIC', 't-stat'].includes(options.autolag))
    throw new Error('Invalid autolag');
}

/** Run DuckDB aggregates first and export only the inputs needed by Python algorithms. */
export async function profile(
  connection: ProfilingConnection,
  tableName: string,
  columns: readonly ProfileColumn[],
  options: ProfileOptions = {}
): Promise<ProfileResult[]> {
  validateProfilingTarget(tableName, columns);
  validateOptions(columns, options);
  // An omitted metric list selects the whole catalog. An empty list requests no work.
  const requested = new Map((options.metrics ?? ALL_METRICS).map((metric) => [id(metric), metric]));
  for (const [name, config] of requested) {
    if (!ALL_METRICS.includes(name)) throw new Error(`Unknown metric: ${name}`);
    if (typeof config !== 'string' && name !== 'top_values' && Object.keys(config).some((key) => key !== 'id'))
      throw new Error(`Unknown option for ${name}`);
  }
  if (!requested.size) return [];
  if (
    !options.timeIndex &&
    columns.some((column) => role(column, options) === 'timeseries') &&
    [
      ...metricFamilies.timeseries,
      ...metricFamilies.table.filter((metric) => metric.startsWith('time_') || metric === 'mean_time_index_step'),
    ].some((metric) => requested.has(metric))
  )
    throw new Error('TimeSeries columns require timeIndex');
  // Single-query aggregates share the planner used by prepared SQL and the browser.
  const native = [...requested.values()].filter((config) => nativeMetricIds.has(id(config)));
  const plan = createProfilingPlan(tableName, columns, { metrics: native, semantics: 'extended' });
  const results = plan.metrics.length
    ? plan.decode((await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0])
    : [];
  const append = (metric: string, value: MetricValue, targets: string[] = []) =>
    results.push({ protocol_version: 1, table_name: tableName, columns: targets, metric, parameters: {}, value });
  for (const result of results)
    if (result.metric === 'profiling_type' && assignedType(result.columns[0], options))
      result.value = { type: 'string', value: labels[assignedType(result.columns[0], options)!] };
  if (requested.has('column_type_counts')) {
    const counts: Record<string, MetricValue> = {};
    for (const column of columns) {
      const label = labels[role(column, options) as keyof typeof labels] ?? 'Unsupported';
      counts[label] = integer(Number(counts[label]?.value ?? 0) + 1);
    }
    append('column_type_counts', { type: 'object', value: counts });
  }
  const source = tableSource(tableName);
  const distributions = await nativeDistributions(connection, tableName, columns, requested, options);
  results.push(...distributions.results);
  // One frequency table per column feeds all requested frequency, mode, and imbalance metrics.
  for (const column of columns) {
    const kind = role(column, options);
    if (kind === 'unknown') continue;
    const frequency = metricFamilies.frequency.filter(
      (metric) =>
        requested.has(metric) &&
        (!metric.startsWith('boolean_') || kind === 'boolean') &&
        (metric !== 'category_imbalance_score' || ['boolean', 'categorical', 'text'].includes(kind))
    );
    if (!frequency.length) continue;
    const field = identifier(column.name);
    const valid = /^(FLOAT|DOUBLE|REAL)$/i.test(column.type) ? ` AND NOT isnan(${field})` : '';
    const value = /^DATE$/i.test(column.type)
      ? 'v::VARCHAR'
      : /^TIMESTAMP(TZ| WITH TIME ZONE)$/i.test(column.type)
      ? `strftime(v AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ')`
      : /^TIMESTAMP/i.test(column.type)
      ? `replace(v::VARCHAR, ' ', 'T')`
      : 'v';
    const expressions: Record<string, string> = {
      value_counts: `coalesce(list(struct_pack(value := ${value}, count := n) ORDER BY n DESC, v ASC), [])`,
      value_counts_by_value: `coalesce(list(struct_pack(value := ${value}, count := n) ORDER BY v ASC), [])`,
      singleton_count: 'count(*) FILTER (WHERE n = 1)',
      singleton_rate: 'coalesce(count(*) FILTER (WHERE n = 1) / nullif(sum(n), 0), 0)',
      boolean_mode: 'first(v ORDER BY n DESC, v ASC)',
      boolean_mode_count: 'coalesce(max(n), 0)',
      category_imbalance_score:
        'CASE WHEN count(*) <= 1 THEN 0 ELSE 1 + (sum(n * log2(n)) / sum(n) - log2(sum(n))) / log2(count(*)) END',
    };
    const sql = `WITH grouped AS (SELECT ${field} AS v, count(*) AS n FROM ${source} WHERE ${field} IS NOT NULL${valid} GROUP BY ${field}) SELECT ${frequency
      .map((metric) => `${expressions[metric]} AS ${metric}`)
      .join(', ')} FROM grouped`;
    const row = (await connection.runAndReadAll(sql)).getRowObjectsJson()[0];
    for (const metric of frequency) {
      const raw = row[metric];
      const output: MetricValue = metric.startsWith('value_counts')
        ? {
            type: 'list',
            value: (raw as { value: unknown; count: unknown }[]).map((entry) => ({
              type: 'object',
              value: { value: fieldValue(entry.value, column.type), count: integer(entry.count) },
            })),
          }
        : metric === 'boolean_mode'
        ? fieldValue(raw, 'BOOLEAN')
        : metric.endsWith('_count')
        ? integer(raw)
        : number(Number(raw));
      append(metric, output, [column.name]);
    }
  }
  // Duplicate groups compare the requested columns and normalize NaN to NULL before grouping.
  const duplicates = ['duplicate_group_count', 'duplicate_group_rate', 'duplicate_group_row_count'].filter((metric) =>
    requested.has(metric)
  );
  if (duplicates.length) {
    const fields = columns.map(nanAsNull);
    const group = fields.length
      ? `SELECT count(*) AS n FROM ${source} GROUP BY ${fields.join(', ')} HAVING count(*) > 1`
      : 'SELECT 0 AS n WHERE false';
    const row = (
      await connection.runAndReadAll(
        `SELECT count(*) AS n${
          requested.has('duplicate_group_row_count') ? ', coalesce(list(n ORDER BY n DESC), []) AS groups' : ''
        }, (SELECT count(*) FROM ${source}) AS total FROM (${group})`
      )
    ).getRowObjectsJson()[0];
    if (requested.has('duplicate_group_count')) append('duplicate_group_count', integer(row.n));
    if (requested.has('duplicate_group_rate'))
      append('duplicate_group_rate', number(Number(row.total) ? Number(row.n) / Number(row.total) : 0));
    if (requested.has('duplicate_group_row_count'))
      append('duplicate_group_row_count', { type: 'list', value: (row.groups as unknown[]).map(integer) });
  }
  // Schedule only applicable grouped algorithms whose results DuckDB has not already supplied.
  const tasks: { column: ProfileColumn; role: string; metrics: string[]; path?: string }[] = [];
  for (const column of columns) {
    const type = role(column, options);
    const families = [
      ...(type === 'numeric' || type === 'timeseries' ? ['numeric', 'distribution'] : []),
      ...(['categorical', 'text', 'boolean', 'date'].includes(type) ? ['distribution'] : []),
      ...(['categorical', 'text', 'url', 'path', 'file', 'image'].includes(type) ? ['text'] : []),
      ...(['path', 'file', 'image'].includes(type) ? ['path'] : []),
      ...(['file', 'image'].includes(type) ? ['file'] : []),
      ...(['date', 'url', 'image'].includes(type) ? [type] : []),
    ];
    const metrics: string[] = [
      ...new Set(families.flatMap((family) => [...metricFamilies[family as keyof typeof metricFamilies]])),
    ].filter((metric) => requested.has(metric) && !distributions.completed.get(column.name)?.has(metric));
    if (type === 'date' && !/^(DATE|TIMESTAMP)/i.test(column.type)) {
      // A string assigned the date role needs parsing before temporal bounds can be computed.
      metrics.push(
        ...['min', 'max', 'min_timestamp', 'max_timestamp', 'time_span'].filter((metric) => requested.has(metric))
      );
    }
    if (type !== 'unknown' && metrics.length) tasks.push({ column, role: type, metrics });
  }
  if (requested.has('pearson_r')) {
    // Each pair uses rows where both values are finite and stays inside DuckDB.
    const numeric = columns.filter((column) => ['numeric', 'timeseries'].includes(role(column, options)));
    const pairs = numeric.flatMap((a, index) => numeric.slice(index + 1).map((b) => [a, b] as const));
    if (pairs.length) {
      const sql = pairs.map(([a, b], index) => {
        const left = identifier(a.name);
        const right = identifier(b.name);
        return `corr(${left}, ${right}) FILTER (WHERE isfinite(${left}) AND isfinite(${right})) AS p${index}`;
      }).join(', ');
      const row = (await connection.runAndReadAll(`SELECT ${sql} FROM ${source}`)).getRowObjectsJson()[0];
      pairs.forEach(([a, b], index) =>
        append(
          'pearson_r',
          row[`p${index}`] == null ? { type: 'null', value: null } : number(Number(row[`p${index}`])),
          [a.name, b.name]
        )
      );
    }
  }
  // The same eligibility rules govern whether a pairwise metric runs and which columns it exports.
  const pairColumns = (metric: string) => columns.filter((column) => {
    const type = role(column, options);
    return metric === 'phi_k' ? type !== 'unknown'
      : ['spearman_rho', 'kendall_tau'].includes(metric) ? ['numeric', 'timeseries'].includes(type)
      : metric === 'cramers_v' ? ['categorical', 'boolean'].includes(type)
      : ['numeric', 'timeseries', 'categorical', 'boolean'].includes(type);
  });
  const pair = metricFamilies.pair.filter((metric) =>
    metric !== 'pearson_r' && requested.has(metric) && pairColumns(metric).length > 1
  );
  const memory = ['table_memory_bytes', 'mean_row_memory_bytes', 'column_memory_bytes'].filter((metric) =>
    requested.has(metric) && columns.length > 0
  );
  const time = [
    ...metricFamilies.timeseries,
    'time_series_count',
    'time_index_observation_count',
    'time_index_start',
    'time_index_end',
    'mean_time_index_step',
  ].filter((metric) => requested.has(metric));
  const ordered = metricFamilies.ordered.filter((metric) => requested.has(metric));
  const needsOrder =
    (time.length && options.timeIndex) || (ordered.length && (options.orderBy?.length || options.timeIndex) &&
      columns.some((column) => ['numeric', 'timeseries'].includes(role(column, options))));
  if (!tasks.length && !pair.length && !memory.length && !needsOrder && !distributions.chiTests.length) return results;
  const directory = await mkdtemp(join(tmpdir(), 'data-profiling-'));
  try {
    // Grouped algorithms use one row per distinct value. Text casts protect dates and wide integers in transit.
    for (const [index, task] of tasks.entries()) {
      task.path = join(directory, `group-${index}.parquet`);
      const name = identifier(task.column.name);
      const column = /^(U?HUGEINT|BIGNUM|DATE)$/i.test(task.column.type)
        ? `${name}::VARCHAR`
        : /^(FLOAT|DOUBLE|REAL)$/i.test(task.column.type)
        ? `CASE WHEN isnan(${name}) THEN NULL ELSE ${name} END`
        : name;
      await connection.run(
        `COPY (SELECT ${column} AS value, count(*) AS count FROM ${source} GROUP BY ${column}) TO ${literal(
          task.path
        )} (FORMAT PARQUET)`
      );
    }
    let raw: string | undefined;
    if (pair.length || memory.length || needsOrder) {
      // Pairwise and ordered metrics share a projected export. Memory profiling needs every requested column.
      raw = join(directory, 'columns.parquet');
      const pairNames = new Set(pair.flatMap((metric) => pairColumns(metric).map((column) => column.name)));
      const selected = memory.length
        ? columns
        : columns.filter(
            (column) =>
              pairNames.has(column.name) || (needsOrder && (column.name === options.timeIndex ||
                ['numeric', 'timeseries'].includes(role(column, options))))
          );
      if (selected.length) {
        const order = needsOrder ? (options.orderBy?.length ? options.orderBy : [options.timeIndex!]) : [];
        await connection.run(
          `COPY (SELECT ${selected
            .map((column) =>
              /^(U?HUGEINT|BIGNUM)$/i.test(column.type)
                ? `${identifier(column.name)}::VARCHAR AS ${identifier(column.name)}`
                : identifier(column.name)
            )
            .join(', ')} FROM ${source}${order.length ? ' ORDER BY ' + order.map(identifier).join(', ') : ''}) TO ${literal(
            raw
          )} (FORMAT PARQUET)`
        );
      } else raw = undefined;
    }
    results.push(
      ...(await runPythonWorker(options.python ?? 'python3', {
        table: tableName,
        tasks,
        raw,
        columns,
        roles: Object.fromEntries(columns.map((column) => [column.name, role(column, options)])),
        pair,
        chiTests: distributions.chiTests,
        memory,
        time: options.timeIndex ? time : [],
        ordered: needsOrder ? ordered : [],
        options,
      }))
    );
    return results;
  } finally {
    // Parquet inputs belong to this request, even when the Python process remains alive.
    await rm(directory, { recursive: true, force: true });
  }
}
