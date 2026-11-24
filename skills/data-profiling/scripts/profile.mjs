#!/usr/bin/env node
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const table = 'data';
const readers = {
  csv: "read_csv_auto(getvariable('source_path'), header = true)",
  json: "read_json_auto(getvariable('source_path'))",
  parquet: "read_parquet(getvariable('source_path'))",
};
const defaultMetrics = [
  'column_count', 'profiling_type', 'missing_count', 'missing_rate', 'distinct_count', 'top_values', 'min', 'max', 'mean',
];
const usage = `Usage: profile.mjs <file> [options]

  --out-dir <directory>   Existing parent directory for the output (default: current directory)
  --column <name>        Profile only selected columns (repeatable)
  --metric <id>          Replace default metrics with native metric IDs (repeatable)
  --language <locale>    HTML language, en-US or zh-CN (default: en-US)
  -h, --help             Show usage
`;

async function computeProfile(sourcePath, format, selectedColumns, metrics) {
  let duckdb, profiler, renderer;
  try {
    [duckdb, profiler, renderer] = await Promise.all([
      import('@duckdb/node-api'), import('data_profiling'), import('data_profiling/report'),
    ]);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('Initialize the runtime with npm ci in the data-profiling skill directory.', { cause: error });
    }
    throw error;
  }

  const instance = await duckdb.DuckDBInstance.create(':memory:');
  let connection;
  try {
    connection = await instance.connect();
    // DuckDB file readers expand glob patterns. Quote each glob metacharacter to select only this file.
    const literalPath = sourcePath.replace(/[?*\[]/g, (character) => `[${character}]`);
    await connection.run('SET VARIABLE source_path = ?', [literalPath]);
    await connection.run(`CREATE TEMP VIEW data AS SELECT * FROM ${readers[format]}`);
    const schema = (await connection.runAndReadAll("SELECT name, type FROM pragma_table_info('data')")).getRowObjectsJson();
    const byName = new Map(schema.map((column) => [column.name, column]));
    const columns = selectedColumns ? selectedColumns.map((name) => {
      if (!byName.has(name)) throw new Error(`Unknown column: ${name}`);
      return byName.get(name);
    }) : schema;
    const semantics = 'extended';
    const plan = profiler.createProfilingPlan(table, columns, { metrics, semantics });
    const [row] = (await connection.runAndReadAll(plan.sql)).getRowObjectsJson();
    return { renderer, columns, semantics, ...plan.decodeWithDiagnostics(row) };
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

async function run(input, options) {
  const format = extname(input).slice(1).toLowerCase();
  if (!Object.hasOwn(readers, format)) throw new Error('Expected a CSV, JSON, or Parquet file.');
  const language = options.language ?? 'en-US';
  if (!['en-US', 'zh-CN'].includes(language)) throw new Error('Language must be en-US or zh-CN.');
  const sourcePath = await realpath(input);
  if (!(await stat(sourcePath)).isFile()) throw new Error('The input must be a regular file.');
  const parent = await realpath(options['out-dir'] ?? process.cwd());
  if (!(await stat(parent)).isDirectory()) throw new Error('The output parent must be a directory.');

  const metrics = [...new Set(['row_count', ...(options.metric ?? defaultMetrics)])];
  const { renderer, columns, semantics, results, skipped } = await computeProfile(sourcePath, format, options.column, metrics);
  const filename = basename(input);
  const profile = JSON.stringify({
    source: { filename, format },
    table,
    columns,
    configuration: { metrics, semantics },
    results,
    skipped,
  }, null, 2);
  const html = renderer.renderReport(results, { title: filename, language });

  // Give each invocation its own directory and remove partial artifacts on a write failure.
  const output = await mkdtemp(join(parent, 'data-profile-'));
  const files = { profile: join(output, 'profile.json'), report: join(output, 'report.html') };
  try {
    await writeFile(files.profile, profile + '\n', 'utf8');
    await writeFile(files.report, html, 'utf8');
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify(files));
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'out-dir': { type: 'string' },
      column: { type: 'string', multiple: true },
      metric: { type: 'string', multiple: true },
      language: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length !== 1) throw new Error('Provide one input file. Run with --help for usage.');
    await run(positionals[0], values);
  }
} catch (error) {
  console.error(`data-profiling: ${error.message}`);
  process.exitCode = 1;
}
