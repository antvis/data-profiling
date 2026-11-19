import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type { JsonValue, MetricValue, ProfileResult, ProfileRow } from './types';

export const dataProfilingSQL = readFileSync(join(__dirname, '..', 'sql', 'data_profiling.sql'), 'utf8');
