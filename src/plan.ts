import { identifier, kind, literal, nanAsNull, tableSource, validateProfilingTarget, type ProfileColumn } from './duckdb.js';
import { defaultNativeMetrics, nativeMetricIds } from './metrics.js';
import { scalar, type MetricValue, type ProfileResult, type ProfileSkip, type ProfileDiagnostics } from './types.js';

export type MetricConfig = string | { id: string; [option: string]: unknown };
export interface ProfilingOptions {
  metrics?: readonly MetricConfig[];
  /** Extended mode treats NaN as missing and retains infinity in supported aggregates. */
  semantics?: 'finite' | 'extended';
}

function parameters(config: MetricConfig): { id: string; limit?: number; maxDistinctRatio?: number } {
  const value = typeof config === 'string' ? { id: config } : config;
  if (!value || !nativeMetricIds.has(value.id)) throw new Error(`Unknown metric: ${value?.id}`);
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

/** Map aggregate outputs to protocol types, including metrics whose type differs from their input. */
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
  decodeWithDiagnostics(row: Record<string, unknown>): ProfileDiagnostics;
}

/** Compile one native aggregate query from the schema; decode only the resulting statistics. */
export function createProfilingPlan(
  tableName: string,
  columns: readonly ProfileColumn[],
  options: ProfilingOptions = {}
): ProfilingPlan {
  if (options.semantics !== undefined && !['finite', 'extended'].includes(options.semantics))
    throw new Error('Unknown profiling semantics');
  validateProfilingTarget(tableName, columns);
  // The last configuration wins, including configurations that skip a metric.
  const metrics = new Map(
    (options.metrics ?? defaultNativeMetrics).map((config) => {
      const metric = parameters(config);
      return [metric.id, metric];
    })
  );
  const source = tableSource(tableName);
  const input = (field: ProfileColumn) => options.semantics === 'extended' ? nanAsNull(field) : identifier(field.name);
  const aggregates = new Map<string, string>();
  const planned: PlannedMetric[] = [];
  const omitted: ProfileSkip[] = [];
  // Multiple metrics can decode the same SQL expression, such as null_count and missing_count.
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
      // Table-wide missingness uses the requested column subset and the selected NaN semantics.
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
      const skip = () => omitted.push({ table_name: tableName, columns: [name], metric: id, reason: 'unsupported_type' });
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
          if (logicalType === 'unknown') { skip(); continue; }
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
          if (logicalType !== 'numeric') { skip(); continue; }
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
          if (logicalType !== 'string') { skip(); continue; }
          expression = `${id === 'mean_length' ? 'avg' : 'median'}(length(${col}::VARCHAR))`;
          break;
        case 'min_timestamp':
        case 'max_timestamp':
          if (logicalType !== 'date') { skip(); continue; }
          expression = `${id === 'min_timestamp' ? 'min' : 'max'}(${col}) FILTER (WHERE isfinite(${col}))`;
          break;
        case 'time_span': {
          if (logicalType !== 'date') { skip(); continue; }
          // Convert differences to nanoseconds while retaining the source timestamp's resolution.
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
          if (logicalType === 'unknown') { skip(); continue; }
          expression = distinct;
          break;
        case 'min_length':
        case 'max_length':
          if (logicalType !== 'string') { skip(); continue; }
          expression = `${id === 'min_length' ? 'min' : 'max'}(length(${col}::VARCHAR))`;
          break;
        case 'top_values': {
          if (logicalType !== 'string' && logicalType !== 'boolean') { skip(); continue; }
          // NULL signals a cardinality skip. An empty list is a successful result.
          const count = aggregate(distinct);
          const top = aggregate(`CASE WHEN ${distinct} > count(*) * ${maxDistinctRatio} THEN NULL
            ELSE coalesce(first((SELECT list(struct_pack(value := v, count := n) ORDER BY n DESC, v ASC)
              FROM (SELECT ${col} AS v, count(*) AS n FROM ${source} WHERE ${col} IS NOT NULL
                GROUP BY ${col} ORDER BY n DESC, v ASC LIMIT ${limit}) AS ranked)), []) END`);
          result(id, field, top, 'object', { limit: limit!, maxDistinctRatio: maxDistinctRatio! }, count);
          continue;
        }
        default: {
          if (logicalType !== 'numeric' && !(['min', 'max'].includes(id) && logicalType === 'date')) {
            skip();
            continue;
          }
          const fn =
            (
              { mean: 'avg', stddev: 'stddev_samp', variance_samp: 'var_samp', excess_kurtosis: 'kurtosis' } as Record<
                string,
                string
              >
            )[id] ?? id;
          // DuckDB's dispersion and shape aggregates need finite inputs.
          // Extended mode handles infinities explicitly for those metrics below.
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
  // Schema-only requests can avoid the row scan.
  const metadataOnly = [...metrics.keys()].every((id) =>
    ['column_count', 'profiling_type', 'declared_type', 'is_groupable', 'is_orderable'].includes(id)
  );
  const query = metadataOnly
    ? `SELECT ${expressions.join(',\n')}`
    : `SELECT count(*) AS __rows${expressions.length ? ', ' + expressions.join(',\n') : ''} FROM ${source}`;
  // Normalize temporal values in DuckDB before the client can round timestamps or change their timezone.
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
  const decode = (row: Record<string, unknown>, skipped?: ProfileSkip[]): ProfileResult[] => {
    // Missing aliases indicate invalid transport. SQL NULL represents an undefined result or a documented skip.
    const results: ProfileResult[] = [];
    for (const metric of planned) {
      if (!Object.hasOwn(row, metric.alias)) throw new Error(`Missing aggregate: ${metric.alias}`);
      const raw = row[metric.alias];
      let value: MetricValue;
      if (metric.metric === 'top_values') {
        if (raw == null) {
          skipped?.push({ table_name: tableName, columns: [metric.column!.name], metric: metric.metric, reason: 'cardinality_limit' });
          continue;
        }
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
  };
  return {
    sql: projected.length ? `SELECT ${projected.join(', ')} FROM (${query})` : 'SELECT 1 WHERE false',
    metrics: planned,
    decode,
    decodeWithDiagnostics(row) {
      const skipped = omitted.map((item) => ({ ...item, columns: [...item.columns] }));
      return { results: decode(row, skipped), skipped };
    },
  };
}
