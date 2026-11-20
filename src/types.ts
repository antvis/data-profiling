export type MetricValue =
  | { type: 'integer' | 'decimal'; value: string }
  | { type: 'number'; value: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { type: 'boolean'; value: boolean }
  | { type: 'string' | 'date' | 'timestamp' | 'timestamptz'; value: string }
  | { type: 'list'; value: MetricValue[] }
  | { type: 'object'; value: { [key: string]: MetricValue } }
  | { type: 'null'; value: null };

export interface ProfileResult {
  protocol_version: 1;
  table_name: string;
  columns: string[];
  metric: string;
  parameters: Record<string, number>;
  value: MetricValue;
}
