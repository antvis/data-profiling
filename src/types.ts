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
