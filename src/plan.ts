import type { MetricValue, ProfileResult } from './types';

export type ProfileColumn = { name: string; type: string };
export type MetricConfig = string | { id: string; [option: string]: unknown };
export interface ProfilingOptions {
  metrics?: readonly MetricConfig[];
  semantics?: 'finite' | 'extended';
}

const metricIds = [
  'row_count',
  'column_count',
  'missing_count',
  'null_count',
  'distinct_count',
  'duplicate_count',
  'top_values',
  'min',
  'max',
  'min_length',
  'max_length',
  'mean',
  'sum',
  'stddev',
  'median',
];
export const additionalMetricIds = [
  'observation_count',
  'present_count',
  'missing_rate',
  'distinct_rate',
  'is_unique',
  'missing_cell_count',
  'missing_cell_rate',
  'columns_with_missing_count',
  'all_missing_column_count',
  'profiling_type',
  'declared_type',
  'is_groupable',
  'is_orderable',
  'variance_samp',
  'stddev_samp',
  'cv',
  'skewness',
  'excess_kurtosis',
  'range',
  'iqr',
  'mad',
  'negative_count',
  'negative_rate',
  'zero_count',
  'zero_rate',
  'infinity_count',
  'infinity_rate',
  'mean_length',
  'median_length',
  'min_timestamp',
  'max_timestamp',
  'time_span',
];
const supportedMetricIds = new Set([...metricIds, ...additionalMetricIds]);
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export function kind(type: string): 'numeric' | 'string' | 'boolean' | 'date' | 'unknown' {
  if (
    /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT[1248]?|FLOAT|DOUBLE|REAL|DECIMAL(?:\(\d+,\s*\d+\))?|NUMERIC(?:\(\d+,\s*\d+\))?|BIGNUM)$/i.test(
      type
    )
  )
    return 'numeric';
  if (/^(VARCHAR|CHAR|BPCHAR|TEXT|STRING|UUID|ENUM\(.*\))$/i.test(type)) return 'string';
  if (/^BOOLEAN$/i.test(type)) return 'boolean';
  if (/^(DATE|TIMESTAMP(_S|_MS|_NS|TZ| WITH TIME ZONE)?)$/i.test(type)) return 'date';
  return 'unknown';
}

function parameters(config: MetricConfig): { id: string; limit?: number; maxDistinctRatio?: number } {
  const value = typeof config === 'string' ? { id: config } : config;
  if (!value || !supportedMetricIds.has(value.id)) throw new Error(`Unknown metric: ${value?.id}`);
  for (const name of Object.keys(value)) {
    if (name !== 'id' && (value.id !== 'top_values' || !['limit', 'maxDistinctRatio'].includes(name))) {
      throw new Error(`Unknown option for ${value.id}: ${name}`);
    }
  }
  if (value.id !== 'top_values') return { id: value.id };
  const limit = value.limit === undefined ? 3 : value.limit;
  const ratio = value.maxDistinctRatio === undefined ? 0.5 : value.maxDistinctRatio;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0)
    throw new Error('top_values.limit must be a non-negative safe integer');
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('top_values.maxDistinctRatio must be between 0 and 1');
  }
  return { id: value.id, limit, maxDistinctRatio: ratio };
}

function valueType(type: string, metric: string): MetricValue['type'] {
  if (['profiling_type', 'declared_type'].includes(metric)) return 'string';
  if (['is_unique', 'is_groupable', 'is_orderable'].includes(metric)) return 'boolean';
  if (metric === 'time_span') return 'duration';
  if (
    metric.endsWith('_rate') ||
    ['variance_samp', 'stddev_samp', 'cv', 'skewness', 'excess_kurtosis', 'mean_length', 'median_length'].includes(
      metric
    )
  )
    return 'number';
  if (['observation_count', 'present_count', 'negative_count', 'zero_count', 'infinity_count'].includes(metric))
    return 'integer';
  if (
    [
      'row_count',
      'column_count',
      'missing_count',
      'null_count',
      'distinct_count',
      'duplicate_count',
      'min_length',
      'max_length',
    ].includes(metric)
  )
    return 'integer';
  if (metric === 'mean' || metric === 'stddev') return 'number';
  if (/^(DECIMAL|NUMERIC)/i.test(type)) return 'decimal';
  if (/^(FLOAT|DOUBLE|REAL)$/i.test(type) || (metric === 'sum' && /^UHUGEINT$/i.test(type))) return 'number';
  if (['median', 'iqr', 'mad'].includes(metric) && !/^BIGNUM$/i.test(type)) return 'number';
  if (/^DATE$/i.test(type)) return 'date';
  if (/^TIMESTAMP(TZ| WITH TIME ZONE)$/i.test(type)) return 'timestamptz';
  if (/^TIMESTAMP/i.test(type)) return 'timestamp';
  return 'integer';
}

interface PlannedMetric {
  metric: string;
  column?: ProfileColumn;
  alias: string;
  type: MetricValue['type'];
  parameters: Record<string, number>;
  distinctAlias?: string;
}

export interface ProfilingPlan {
  sql: string;
  metrics: readonly PlannedMetric[];
  decode(row: Record<string, unknown>): ProfileResult[];
}

export function scalar(type: MetricValue['type'], raw: unknown): MetricValue {
  if (raw == null) return { type: 'null', value: null };
  if (type === 'number') {
    if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('Invalid numeric aggregate');
    const value = Number(raw);
    if (Number.isFinite(value)) return { type, value };
    if (raw === 'NaN' || Number.isNaN(raw)) return { type, value: 'NaN' };
    if (value === Infinity) return { type, value: 'Infinity' };
    if (value === -Infinity) return { type, value: '-Infinity' };
    throw new Error('Invalid numeric aggregate');
  }
  if (type === 'boolean') {
    if (typeof raw !== 'boolean') throw new Error('Invalid boolean aggregate');
    return { type, value: raw };
  }
  if (type === 'integer' || type === 'duration') {
    if ((typeof raw === 'number' && !Number.isSafeInteger(raw)) || !/^-?\d+$/.test(String(raw))) {
      throw new Error('Invalid or lossy integer aggregate; use getRowObjectsJson()');
    }
    return type === 'duration'
      ? { type, value: { amount: String(raw), unit: 'nanosecond' } }
      : { type, value: String(raw) };
  }
  if (type === 'decimal' || type === 'string' || type === 'date' || type === 'timestamp' || type === 'timestamptz') {
    if (typeof raw !== 'string') throw new Error(`Invalid ${type} aggregate`);
    return { type, value: raw };
  }
  throw new Error(`Invalid scalar type: ${type}`);
}

/** Compile one native aggregate query from the schema; decode only the resulting statistics. */
export function createProfilingPlan(
  tableName: string,
  columns: readonly ProfileColumn[],
  options: ProfilingOptions = {}
): ProfilingPlan {
  if (options.semantics !== undefined && !['finite', 'extended'].includes(options.semantics))
    throw new Error('Unknown profiling semantics');
  if (typeof tableName !== 'string' || !tableName) throw new Error('tableName must be a non-empty string');
  const names = new Set<string>();
  for (const column of columns) {
    if (typeof column.name !== 'string' || !column.name || typeof column.type !== 'string' || !column.type) {
      throw new Error('Columns require non-empty names and types');
    }
    const key = column.name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (names.has(key)) throw new Error(`Duplicate column: ${column.name}`);
    names.add(key);
  }
  // The last configuration wins, including configurations that skip a metric.
  const metrics = new Map(
    (options.metrics ?? metricIds).map((config) => {
      const metric = parameters(config);
      return [metric.id, metric];
    })
  );
  const source = `query_table(${literal(tableName)})`;
  const input = (field: ProfileColumn) =>
    options.semantics === 'extended' && /^(FLOAT|DOUBLE|REAL)$/i.test(field.type)
      ? `CASE WHEN isnan(${identifier(field.name)}) THEN NULL ELSE ${identifier(field.name)} END`
      : identifier(field.name);
  const aggregates = new Map<string, string>();
  const planned: PlannedMetric[] = [];
  const aggregate = (expression: string): string => {
    if (!aggregates.has(expression)) aggregates.set(expression, `m${aggregates.size}`);
    return aggregates.get(expression)!;
  };
  const result = (
    metric: string,
    column: ProfileColumn | undefined,
    alias: string,
    type: MetricValue['type'],
    params: Record<string, number> = {},
    distinctAlias?: string
  ) => {
    planned.push({ metric, column: column && { ...column }, alias, type, parameters: params, distinctAlias });
  };

  for (const { id, limit, maxDistinctRatio } of metrics.values()) {
    if (id === 'row_count') {
      result(id, undefined, aggregate('count(*)'), 'integer');
      continue;
    }
    if (id === 'column_count') {
      result(id, undefined, aggregate(`(SELECT count(*) FROM pragma_table_info(${literal(tableName)}))`), 'integer');
      continue;
    }
    if (
      ['missing_cell_count', 'missing_cell_rate', 'columns_with_missing_count', 'all_missing_column_count'].includes(id)
    ) {
      const missing = columns.map((field) => `(count(*) - count(${input(field)}))`);
      const expression = id.startsWith('missing_cell')
        ? missing.join(' + ') || '0'
        : columns
            .map(
              (_, i) =>
                `(${missing[i]} ${id === 'all_missing_column_count' ? '= count(*) AND count(*) > 0' : '> 0'})::BIGINT`
            )
            .join(' + ') || '0';
      result(
        id,
        undefined,
        aggregate(
          id === 'missing_cell_rate'
            ? `coalesce((${expression}) / nullif(count(*)::DOUBLE * ${columns.length}, 0), 0)`
            : expression
        ),
        id.endsWith('rate') ? 'number' : 'integer'
      );
      continue;
    }
    for (const field of columns) {
      const { name, type } = field;
      const col = input(field);
      const logicalType = kind(type);
      const distinct = `count(DISTINCT ${col})`;
      let expression: string;
      switch (id) {
        case 'observation_count':
          expression = 'count(*)';
          break;
        case 'present_count':
          expression = `count(${col})`;
          break;
        case 'missing_rate':
          expression = `coalesce((count(*) - count(${col})) / nullif(count(*), 0), 0)`;
          break;
        case 'distinct_rate':
          if (logicalType === 'unknown') continue;
          expression = `coalesce(${distinct} / nullif(count(${col}), 0), 0)`;
          break;
        case 'is_unique':
          expression = `count(${col}) > 0 AND count(${col}) = ${distinct}`;
          break;
        case 'profiling_type':
          expression = literal(
            { numeric: 'Numeric', string: 'Categorical', boolean: 'Boolean', date: 'DateTime', unknown: 'Unsupported' }[
              logicalType
            ]
          );
          break;
        case 'declared_type':
          expression = literal(type);
          break;
        case 'is_groupable':
          expression = 'true';
          break;
        case 'is_orderable':
          expression = logicalType === 'unknown' ? 'false' : 'true';
          break;
        case 'negative_count':
        case 'negative_rate':
        case 'zero_count':
        case 'zero_rate':
        case 'infinity_count':
        case 'infinity_rate': {
          if (logicalType !== 'numeric') continue;
          const predicate = id.startsWith('negative')
            ? `${col} < 0`
            : id.startsWith('zero')
            ? `${col} = 0`
            : /^(FLOAT|DOUBLE|REAL)$/i.test(type)
            ? `isinf(${col})`
            : 'false';
          const count = `count(*) FILTER (WHERE ${predicate})`;
          expression = id.endsWith('rate') ? `coalesce(${count} / nullif(count(*), 0), 0)` : count;
          break;
        }
        case 'mean_length':
        case 'median_length':
          if (logicalType !== 'string') continue;
          expression = `${id === 'mean_length' ? 'avg' : 'median'}(length(${col}::VARCHAR))`;
          break;
        case 'min_timestamp':
        case 'max_timestamp':
          if (logicalType !== 'date') continue;
          expression = `${id === 'min_timestamp' ? 'min' : 'max'}(${col}) FILTER (WHERE isfinite(${col}))`;
          break;
        case 'time_span': {
          if (logicalType !== 'date') continue;
          const value = /^(DATE)$/i.test(type)
            ? `${col}`
            : /^TIMESTAMP_NS$/i.test(type)
            ? `epoch_ns(${col})::HUGEINT`
            : `epoch_us(${col})::HUGEINT * 1000`;
          expression = `(max(${value}) FILTER (WHERE isfinite(${col})) - min(${value}) FILTER (WHERE isfinite(${col})))${
            /^DATE$/i.test(type) ? '::HUGEINT * 86400000000000' : ''
          }`;
          break;
        }
        case 'missing_count':
        case 'null_count':
          expression = `count(*) - count(${col})`;
          break;
        case 'duplicate_count':
          expression = `count(${col}) - ${distinct}`;
          break;
        case 'distinct_count':
          if (logicalType === 'unknown') continue;
          expression = distinct;
          break;
        case 'min_length':
        case 'max_length':
          if (logicalType !== 'string') continue;
          expression = `${id === 'min_length' ? 'min' : 'max'}(length(${col}::VARCHAR))`;
          break;
        case 'top_values': {
          if (logicalType !== 'string' && logicalType !== 'boolean') continue;
          const count = aggregate(distinct);
          const top = aggregate(`CASE WHEN ${distinct} > count(*) * ${maxDistinctRatio} THEN NULL
            ELSE coalesce(first((SELECT list(struct_pack(value := v, count := n) ORDER BY n DESC, v ASC)
              FROM (SELECT ${col} AS v, count(*) AS n FROM ${source} WHERE ${col} IS NOT NULL
                GROUP BY ${col} ORDER BY n DESC, v ASC LIMIT ${limit}) AS ranked)), []) END`);
          result(id, field, top, 'object', { limit: limit!, maxDistinctRatio: maxDistinctRatio! }, count);
          continue;
        }
        default: {
          if (logicalType !== 'numeric' && !(['min', 'max'].includes(id) && logicalType === 'date')) continue;
          const fn =
            (
              { mean: 'avg', stddev: 'stddev_samp', variance_samp: 'var_samp', excess_kurtosis: 'kurtosis' } as Record<
                string,
                string
              >
            )[id] ?? id;
          const finite =
            logicalType === 'date' ||
            (/^(FLOAT|DOUBLE|REAL)$/i.test(type) &&
              !(
                options.semantics === 'extended' &&
                ['min', 'max', 'mean', 'sum', 'range', 'iqr', 'median', 'mad'].includes(id)
              ));
          const filter = finite ? ` FILTER (WHERE isfinite(${col}))` : '';
          expression =
            id === 'cv'
              ? `stddev_samp(${col})${filter} / nullif(avg(${col})${filter}, 0)`
              : id === 'range'
              ? `max(${col})${filter} - min(${col})${filter}`
              : id === 'iqr'
              ? `quantile_cont(${col}, 0.75)${filter} - quantile_cont(${col}, 0.25)${filter}`
              : `${fn}(${col})${filter}`;
          if (options.semantics === 'extended' && ['skewness', 'excess_kurtosis'].includes(id)) {
            expression = `CASE WHEN count(${col})${filter} >= ${
              id === 'skewness' ? 3 : 4
            } AND min(${col})${filter} = max(${col})${filter} THEN 0 ELSE ${expression} END`;
          }
          if (
            options.semantics === 'extended' &&
            /^(FLOAT|DOUBLE|REAL)$/i.test(type) &&
            ['stddev', 'stddev_samp', 'variance_samp', 'skewness', 'excess_kurtosis', 'cv'].includes(id)
          ) {
            expression = `CASE WHEN count(*) FILTER (WHERE isinf(${col})) > 0 THEN 'NaN'::DOUBLE ELSE ${expression} END`;
          }
        }
      }
      result(id, field, aggregate(expression), valueType(type, id));
    }
  }
  const expressions = [...aggregates].map(([expression, alias]) => `${expression} AS ${alias}`);
  const metadataOnly = [...metrics.keys()].every((id) =>
    ['column_count', 'profiling_type', 'declared_type', 'is_groupable', 'is_orderable'].includes(id)
  );
  const query = metadataOnly
    ? `SELECT ${expressions.join(',\n')}`
    : `SELECT count(*) AS __rows${expressions.length ? ', ' + expressions.join(',\n') : ''} FROM ${source}`;
  const temporal = new Map(
    planned
      .filter(({ type }) => ['date', 'timestamp', 'timestamptz'].includes(type))
      .map(({ alias, type }) => [alias, type])
  );
  const aliases = new Set(
    planned.flatMap(({ alias, distinctAlias }) => (distinctAlias ? [alias, distinctAlias] : [alias]))
  );
  const projected = [...aliases].map((alias) => {
    const type = temporal.get(alias);
    if (type === 'date') return `${alias}::VARCHAR AS ${alias}`;
    if (type === 'timestamp') return `replace(${alias}::VARCHAR, ' ', 'T') AS ${alias}`;
    if (type === 'timestamptz') return `strftime(${alias} AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ') AS ${alias}`;
    return alias;
  });
  return {
    sql: projected.length ? `SELECT ${projected.join(', ')} FROM (${query})` : 'SELECT 1 WHERE false',
    metrics: planned,
    decode(row) {
      const results: ProfileResult[] = [];
      for (const metric of planned) {
        if (!Object.hasOwn(row, metric.alias)) throw new Error(`Missing aggregate: ${metric.alias}`);
        const raw = row[metric.alias];
        let value: MetricValue;
        if (metric.metric === 'top_values') {
          if (raw == null) continue;
          if (!Array.isArray(raw) || !Object.hasOwn(row, metric.distinctAlias!))
            throw new Error('Invalid top_values aggregate');
          value = {
            type: 'object',
            value: {
              entries: {
                type: 'list',
                value: raw.map((entry) => {
                  if (!entry || !Object.hasOwn(entry, 'value') || !Object.hasOwn(entry, 'count'))
                    throw new Error('Invalid top_values entry');
                  return {
                    type: 'object',
                    value: {
                      value: scalar(kind(metric.column!.type) === 'boolean' ? 'boolean' : 'string', entry.value),
                      count: scalar('integer', entry.count),
                    },
                  };
                }),
              },
              truncated: {
                type: 'boolean',
                value: Number(row[metric.distinctAlias!]) > Number(metric.parameters.limit),
              },
            },
          };
        } else value = scalar(metric.type, raw);
        results.push({
          protocol_version: 1,
          table_name: tableName,
          columns: metric.column ? [metric.column.name] : [],
          metric: metric.metric,
          parameters: { ...metric.parameters },
          value,
        });
      }
      return results;
    },
  };
}
