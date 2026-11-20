import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type { JsonValue, MetricValue, ProfileResult, ProfileRow } from './types';
export { createProfilingSQL, createProfilingPlan } from './profile-query';
export type { ProfileColumn, MetricConfig, ProfilingOptions, ProfilingPlan, PlannedMetric } from './profile-query';

export const dataProfilingSQL = readFileSync(join(__dirname, 'data_profiling.sql'), 'utf8');
