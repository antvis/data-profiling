**English** | [简体中文](./README.zh-CN.md)

# Data Profiling

[Live playground](https://antv.vision/data-profiling/)

The ES module data profiling foundation for AVA. Supply the caller's DuckDB connection, table name and known schema; receive structured statistics through a consistent result protocol. AVA owns data access, sessions and result consumption; business rules and interpretation stay with the application or agent.

The catalog contains 149 metric IDs spanning table and column quality, numeric distributions, categories, text, correlations, dates, files, images and time series. Applicable metrics run in batches, native aggregates share computation, and only statistics return to JavaScript. See the [metric catalog and definitions](./docs/metrics.md).

## Compute a profile

```ts
import { BASIC_METRICS, profile } from 'data_profiling';
import type { ProfileColumn } from 'data_profiling';

const columns = (await connection.runAndReadAll(
  'SELECT name, type FROM pragma_table_info(?)', ['orders'],
)).getRowObjectsJson() as ProfileColumn[];

const results = await profile(connection, 'orders', columns, {
  metrics: BASIC_METRICS,
});
```

Reuse the caller's connection and pass an existing schema directly. `metrics` selects the work to perform; omitting it uses the complete `ALL_METRICS` catalog, and `[]` returns no results. The last configuration for an ID wins. The column list can be a subset; types come from the schema or explicit roles.

`BASIC_METRICS` matches AVA's seven default metric IDs: `row_count`, `null_count`, `distinct_count`, `top_values`, `min`, `max`, `mean`. It uses native SQL without Python or raw-data export. Exact distinct counts and top values still require data-dependent state; select fewer metrics when needed. Neither existing entry point changes its defaults. See the [AVA integration guide](./docs/ava.md) and [consumer-side example](./examples/ava.mjs).

Counts, bounds, sums, variance, lengths, frequencies and ordinary numeric quantiles/histograms run directly in DuckDB. Character analysis, high-precision quantiles, some statistical tests, files and time-series algorithms use an optional Python environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r python-requirements.txt
```

Assign column roles to enable specialized analysis:

```ts
const results = await profile(connection, 'events', eventColumns, {
  python: '.venv/bin/python',
  types: { message: 'text', link: 'url', attachment: 'file',
    picture: 'image', measurement: 'timeseries' },
  timeIndex: 'observed_at',
});
```

File, image, URL and path roles are explicit. Ordered metrics require `orderBy` or `timeIndex`; time-series metrics require `timeIndex`. Unassigned optional roles are skipped.

## Compile a native plan

Use `createProfilingPlan` to execute SQL yourself, prepare statements or adapt native statistics to another output format:

```ts
import { createProfilingPlan } from 'data_profiling';

const plan = createProfilingPlan('orders', columns, {
  metrics: ['row_count', 'min', 'max', 'mean'],
});
const reader = await connection.runAndReadAll(plan.sql);
const results = plan.decode(reader.getRowObjectsJson()[0]);
```

This entry point accepts directly compilable metrics and defaults to 15 basic statistics. `plan.sql` returns one native statistics row; `plan.decode` converts it into `ProfileResult[]`. Consumers can also read native values using `plan.metrics`. Use `profile` for the complete catalog and statistics requiring additional stages.

For explicit native coverage, use `plan.decodeWithDiagnostics(row)` to receive `{ results, skipped }`. Each skipped target identifies its table, columns, metric and `unsupported_type` or `cardinality_limit` reason. A computed undefined value remains a typed `null` in `results`. Unrequested metrics are absent from both lists. Invalid requests, transport errors and execution failures still throw.

Reuse a plan while its schema is unchanged, and use `connection.prepare(plan.sql)` to reuse a prepared statement. Release statements with `destroySync()`. Each execution reads current data; recompile after schema changes. Table references use DuckDB's qualified names, such as `sales.orders`; quote unusual components separately.

## Render an offline report

The independent `data_profiling/report` entry renders existing results as a single HTML document, with inline styles and charts:

```ts
import { writeFile } from 'node:fs/promises';
import { renderReport } from 'data_profiling/report';

const html = renderReport(results, {
  title: 'Orders data profile',
  theme: 'light', // 'light' (default), 'dark', or 'auto'
  language: 'en-US', // 'zh-CN' (default) or 'en-US'
});
await writeFile('orders-report.html', html, 'utf8');
```

`renderReport` is synchronous and accepts `readonly ProfileResult[]`. It renders table overviews, factual quality observations, expandable column details, distributions and frequencies, pairwise matrices, missing-value coverage, and ACF/PACF when supplied. All exact values and metric parameters remain available in detail tables. Missing metrics are marked “Not supplied”; computed nulls are marked “Undefined”. Chart geometry uses approximate numbers while detail tables preserve the original integer, decimal and temporal strings. Frequency charts preview up to 12 supplied entries; the full supplied data remains in the tables.

The renderer does not query data, load files, or require Python or DuckDB. It supports multiple tables and validates protocol-v1 inputs. HTML escaping protects table names, column names, values and options. Reports work offline with native expand/collapse controls. Samples, scatter plots and missingness matrices require additional data not present in the current result protocol.

Reports default to Simplified Chinese. `language` controls headings, metric and parameter labels, type names, chart text and empty states; the HTML `lang` attribute follows it. Table names, column names, data values and custom titles stay unchanged. Machine metric IDs remain in tooltips; unknown metric IDs retain their readable names.

Run `npm run build && node examples/report.mjs` for an example using native profiling metrics.

## Results and precision

Each `ProfileResult` contains `protocol_version`, `table_name`, `columns`, `metric`, `parameters` and a `value` with `type` / `value` tags. Targets are `[]` for a table, `[name]` for a column and `[a, b]` for a pair.

Integers and decimals retain exact typed strings. Lossy integer transports and malformed scalar values are rejected, including frequencies and histogram counts. Floating results use numbers or `NaN`, `Infinity`, `-Infinity` string sentinels. Temporal precision is preserved, time-zone-aware values normalize to UTC, and durations use nanoseconds. Undefined results use typed `null`; unsupported or skipped metrics produce no record.

`profile` treats floating NaN as missing and retains infinities in numeric bounds. The compiler defaults to `semantics: 'finite'`: missingness counts only SQL NULL, and numeric aggregates exclude non-finite values. Select `'extended'` to count NaN as missing and retain infinities in supported numeric aggregates. Decimal medians and dispersion retain DuckDB's native precision.

The [catalog](./docs/metrics.md) documents structures and options for frequencies, quantiles, bins, correlations and time series. Unknown metrics/options and duplicate column names are rejected before execution.

## Execution and resources

The caller's connection controls native parallelism and memory. Exact distinct counts, complete frequencies and medians require data-dependent state. Select the required metrics to control computation and output costs.

Specialized algorithms export only grouped values or required raw columns through temporary Parquet. Pairwise requests without two eligible columns do not start Python; rank correlations export numeric columns only. Repeated paths share reads within a request. Python workers retain imports for reuse and exit after 30 seconds idle; statistics and file metadata are recalculated on every request. Temporary files are removed on success and failure. Use the caller's transaction for a consistent snapshot across stages.

## Development

### Website playground

```sh
npm install
npm run dev:site
npm run build:site
```

The static playground in `site/` builds to `build/`, separately from the library's `dist/`. It starts with 128 sample orders and shows paginated data on the left and the existing `renderReport` output on the right. Upload CSV (with headers), JSON or Parquet up to 20 MB and 200 columns. Change the metric scope, histogram bins, correlations, language and theme, or download an offline HTML report.

DuckDB-Wasm computes data in the browser; uploaded data is not sent to a server. The pinned engine loads from a CDN on first use and needs a network connection. The playground reuses native plans and distributions without Python algorithms. Correlations cover the first 20 numeric columns. Each preview page shows 25 rows; statistics use the full dataset. Failed imports roll back and retain the current dataset.

Pushes to `main` trigger [GitHub Actions](https://github.com/antvis/data-profiling/actions/workflows/deploy-pages.yml) to install dependencies, run tests, build and deploy to GitHub Pages. Manual runs are also supported. Assets use the repository name as their base path. Enable GitHub Actions as the publishing source in Settings → Pages; Pages requires a public repository on an organization Free plan.

Node.js 22.13 or later:

```sh
npm install
npm test
node examples/node.js
node examples/profile.mjs
node examples/ava.mjs
PROFILING_PYTHON=.venv/bin/python npm test
node examples/profile.mjs .venv/bin/python
npm run bench -- 200000
PROFILING_PYTHON=.venv/bin/python npm run bench:algorithms -- 200000
npm pack
```

Tests cover metric families, precision, empty inputs, validation, statement reuse and constrained memory. Benchmarks cover mixed data, unique strings, wider numeric tables, specialized analysis and a five-million-row sum under a 16 MB limit. Measurements use local in-memory tables.

Version 0.5.0 adds `BASIC_METRICS` and native skip diagnostics. The package now uses ES modules; `profile`, `createProfilingPlan`, result protocol v1 and their defaults are retained.
