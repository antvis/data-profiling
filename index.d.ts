export declare const dataProfilingSQL: string;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type MetricValue =
  | { type: 'integer' | 'decimal'; value: string }
  | { type: 'number'; value: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { type: 'boolean'; value: boolean }
  | { type: 'string' | 'date' | 'timestamp' | 'timestamptz'; value: string }
  | { type: 'duration'; value: { amount: string; unit: string } }
  | { type: 'list'; value: MetricValue[] }
  | { type: 'object'; value: { [key: string]: MetricValue } }
  | { type: 'null'; value: null; reason?: string };

export interface ProfileResult {
  protocol_version: 1;
  table_name: string;
  columns: string[];
  metric: string;
  parameters: { [key: string]: JsonValue };
  value: MetricValue;
}

/** Node DuckDB returns JSON columns as text. Parse these two fields to obtain ProfileResult. */
export type ProfileRow = Omit<ProfileResult, 'parameters' | 'value'> & {
  parameters: string;
  value: string;
};
