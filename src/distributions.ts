import { kind, scalar, type ProfileColumn } from './plan';
import type { ProfileOptions, ProfilingConnection } from './profile';
import type { MetricValue, ProfileResult } from './types';

export async function nativeDistributions(
  connection: ProfilingConnection,
  table: string,
  columns: readonly ProfileColumn[],
  requested: ReadonlyMap<string, unknown>,
  options: ProfileOptions
) {
  const results: ProfileResult[] = [];
  const completed = new Map<string, Set<string>>();
  const chiTests: { column: string; statistic: number; dof: number }[] = [];
  const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const source = `query_table('${table.replaceAll("'", "''")}')`;
  const numeric = columns.filter((column) => kind(column.type) === 'numeric');
  const points = options.quantiles ?? [0.05, 0.25, 0.5, 0.75, 0.95];
  const emit = (column: string, metric: string, value: MetricValue, parameters: Record<string, unknown> = {}) => {
    results.push({ protocol_version: 1, table_name: table, columns: [column], metric, parameters, value });
    if (!completed.has(column)) completed.set(column, new Set());
    completed.get(column)!.add(metric);
  };
  if (requested.has('quantiles')) {
    const eligible = numeric.filter((column) => !/^(DECIMAL|NUMERIC|U?HUGEINT|BIGNUM)/i.test(column.type));
    if (eligible.length) {
      const expressions = eligible.map(
        (column, index) =>
          `quantile_cont(${q(column.name)},[${points
            .map((point) => `${point}::DOUBLE`)
            .join(',')}]) FILTER (WHERE NOT isnan(${q(column.name)}::DOUBLE)) AS q${index}`
      );
      const row = (
        await connection.runAndReadAll(`SELECT ${expressions.join(', ')} FROM ${source}`)
      ).getRowObjectsJson()[0];
      eligible.forEach((column, index) => {
        const values = row[`q${index}`] as (number | string)[] | null;
        emit(
          column.name,
          'quantiles',
          {
            type: 'object',
            value: Object.fromEntries(points.map((point, i) => [String(point), scalar('number', values?.[i])])),
          } as MetricValue,
          { quantiles: points }
        );
      });
    }
  }
  const histogram = requested.has('numeric_histogram');
  const chi = requested.has('chi_squared_statistic') || requested.has('chi_squared_p_value');
  if (!numeric.length || (!histogram && !chi)) return { results, completed, chiTests };
  const metadata = numeric.flatMap((column, index) => {
    const col = q(column.name),
      filter = `FILTER (WHERE isfinite(${col}::DOUBLE))`;
    return [
      `min(${col}::DOUBLE) ${filter} AS lo${index}`,
      `max(${col}::DOUBLE) ${filter} AS hi${index}`,
      `count(*) ${filter} AS n${index}`,
      `count(DISTINCT ${col}) ${filter} AS d${index}`,
      ...(chi || options.bins === 0 ? [`quantile_cont(${col}::DOUBLE,[.25,.75]) ${filter} AS q${index}`] : []),
    ];
  });
  const meta = (await connection.runAndReadAll(`SELECT ${metadata.join(', ')} FROM ${source}`)).getRowObjectsJson()[0];
  const jobs: { column: ProfileColumn; edges: number[]; chi: boolean; alias: string }[] = [];
  for (const [index, column] of numeric.entries()) {
    const low = Number(meta[`lo${index}`]),
      high = Number(meta[`hi${index}`]),
      n = Number(meta[`n${index}`]),
      distinct = Number(meta[`d${index}`]);
    for (const test of [...(histogram ? [false] : []), ...(chi ? [true] : [])]) {
      let edges: number[] = [];
      if (n) {
        if (low === high) {
          const epsilon = low === 0 ? 0.5 : Math.abs(low) * 0.1;
          edges = [low - epsilon, high + epsilon];
        } else {
          let bins = Math.min(options.bins ?? 50, options.maxBins ?? 250, distinct);
          if (test || options.bins === 0) {
            const quartiles = meta[`q${index}`] as number[];
            const fd = (2 * (quartiles[1] - quartiles[0])) / Math.cbrt(n),
              sturges = (high - low) / (Math.log2(n) + 1);
            bins = Math.max(1, Math.ceil((high - low) / (fd > 0 ? Math.min(fd, sturges) : sturges)));
            if (!test) bins = Math.min(bins, options.maxBins ?? 250);
          }
          if (!Number.isSafeInteger(bins) || bins > 100000) throw new Error('Automatic histogram exceeds 100000 bins');
          const step = (high - low) / bins;
          edges = Array.from({ length: bins + 1 }, (_, i) => (i === bins ? high : low + i * step));
          // Floating-point rounding can collapse adjacent bin edges.
          edges = [...new Set(edges)];
        }
      }
      jobs.push({ column, edges, chi: test, alias: `h${jobs.length}` });
    }
  }
  const active = jobs.filter((job) => job.edges.length);
  const histograms = active.length
    ? (
        await connection.runAndReadAll(
          `SELECT ${active
            .map((job) => {
              const col = q(job.column.name),
                upper = job.edges
                  .slice(1)
                  .map((value, index) =>
                    index === job.edges.length - 2
                      ? `${value}::DOUBLE`
                      : `nextafter(${value}::DOUBLE,'-Infinity'::DOUBLE)`
                  );
              return `map_values(histogram(${col}::DOUBLE,[${upper.join(
                ','
              )}]) FILTER (WHERE isfinite(${col}::DOUBLE))) AS ${job.alias}`;
            })
            .join(', ')} FROM ${source}`
        )
      ).getRowObjectsJson()[0]
    : {};
  for (const job of jobs) {
    const counts = (histograms[job.alias] ?? []) as string[];
    if (counts.length !== Math.max(0, job.edges.length - 1)) throw new Error('Invalid native histogram boundaries');
    if (job.chi) {
      const total = counts.reduce((sum, count) => sum + Number(count), 0),
        expected = total / counts.length;
      const statistic = total ? counts.reduce((sum, count) => sum + (Number(count) - expected) ** 2 / expected, 0) : 0;
      if (requested.has('chi_squared_statistic'))
        emit(job.column.name, 'chi_squared_statistic', { type: 'number', value: statistic });
      if (requested.has('chi_squared_p_value')) {
        if (total) chiTests.push({ column: job.column.name, statistic, dof: counts.length - 1 });
        else emit(job.column.name, 'chi_squared_p_value', { type: 'number', value: 0 });
      }
      if (!completed.has(job.column.name)) completed.set(job.column.name, new Set());
      for (const metric of ['chi_squared_statistic', 'chi_squared_p_value'])
        completed.get(job.column.name)!.add(metric);
    } else {
      const total = counts.reduce((sum, count) => sum + Number(count), 0);
      emit(
        job.column.name,
        'numeric_histogram',
        {
          type: 'object',
          value: {
            counts: {
              type: 'list',
              value: counts.map((count, i) =>
                options.density
                  ? scalar('number', Number(count) / (total * (job.edges[i + 1] - job.edges[i])))
                  : scalar('integer', count)
              ),
            },
            edges: { type: 'list', value: job.edges.map((value) => ({ type: 'number', value })) },
          },
        },
        { bins: options.bins ?? 50, maxBins: options.maxBins ?? 250, density: options.density ?? false }
      );
    }
  }
  return { results, completed, chiTests };
}
