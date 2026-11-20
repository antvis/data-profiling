import { readFileSync } from 'node:fs';

export type { JsonValue, MetricValue, ProfileResult, ProfileRow } from './types.js';

export const dataProfilingSQL = readFileSync(new URL('./data_profiling.sql', import.meta.url), 'utf8');
