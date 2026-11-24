/** Tagged JSON values shared by the SQL decoder, Python worker, and offline renderer. */
export type MetricValue =
  | { type: 'integer' | 'decimal'; value: string }
  | { type: 'number'; value: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { type: 'boolean'; value: boolean }
  | { type: 'string' | 'date' | 'timestamp' | 'timestamptz'; value: string }
  | { type: 'duration'; value: { amount: string; unit: 'nanosecond' } }
  | { type: 'list'; value: MetricValue[] }
  | { type: 'object'; value: { [key: string]: MetricValue } }
  | { type: 'null'; value: null };

export interface ProfileResult {
  protocol_version: 1;
  table_name: string;
  /** Empty for a table metric, one name for a column metric, two for a column pair. */
  columns: string[];
  metric: string;
  parameters: Record<string, unknown>;
  value: MetricValue;
}

export interface ProfileSkip {
  table_name: string;
  columns: string[];
  metric: string;
  reason: 'unsupported_type' | 'cardinality_limit';
}

export interface ProfileDiagnostics {
  results: ProfileResult[];
  skipped: ProfileSkip[];
}

/** Decode DuckDB scalars without rounding exact values through JavaScript numbers. */
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
