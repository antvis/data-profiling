import type { MetricValue, ProfileResult } from './types';

export type ProfileColumn = { name: string; type: string };
export type MetricConfig = string | { id: string; [option: string]: unknown };
export interface ProfilingOptions {
  metrics?: readonly MetricConfig[];
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
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function kind(type: string): 'numeric' | 'string' | 'boolean' | 'date' | 'unknown' {
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
  if (!value || !metricIds.includes(value.id)) throw new Error(`Unknown metric: ${value?.id}`);
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
  if (metric === 'median' && !/^BIGNUM$/i.test(type)) return 'number';
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

function scalar(type: MetricValue['type'], raw: unknown): MetricValue {
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
  if (type === 'integer') {
    if ((typeof raw === 'number' && !Number.isSafeInteger(raw)) || !/^-?\d+$/.test(String(raw))) {
      throw new Error('Invalid or lossy integer aggregate; use getRowObjectsJson()');
    }
    return { type, value: String(raw) };
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
    for (const field of columns) {
      const { name, type } = field;
      const col = identifier(name);
      const logicalType = kind(type);
      const distinct = `count(DISTINCT ${col})`;
      let expression: string;
      switch (id) {
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
          const fn = id === 'mean' ? 'avg' : id === 'stddev' ? 'stddev_samp' : id;
          const finite = logicalType === 'date' || /^(FLOAT|DOUBLE|REAL)$/i.test(type);
          expression = `${fn}(${col})${finite ? ` FILTER (WHERE isfinite(${col}))` : ''}`;
        }
      }
      result(id, field, aggregate(expression), valueType(type, id));
    }
  }
  const expressions = [...aggregates].map(([expression, alias]) => `${expression} AS ${alias}`);
  const query = `SELECT count(*) AS __rows${expressions.length ? ', ' + expressions.join(',\n') : ''} FROM ${source}`;
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
