**English** | [简体中文](./README.zh-CN.md)

# Data Profiling

[Live playground](https://data-profiling.antv.vision/)

The ES module data profiling foundation for AVA. Supply the caller's DuckDB connection, table name and known schema; receive structured statistics through a consistent result protocol. AVA owns data access, sessions and result consumption; business rules and interpretation stay with the application or agent.

The catalog contains 149 metric IDs spanning table and column quality, numeric distributions, categories, text, correlations, dates, files, images and time series. Applicable metrics run in batches, native aggregates share computation, and only statistics return to JavaScript. See [metric support by type](#metric-support-by-type) and the [metric catalog and definitions](./docs/metrics.md).

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

`renderReport` is synchronous and accepts `readonly ProfileResult[]`. The report counts distinct metric IDs and result records separately. It shows column types, quality observations linked to column details, missing rates by column, and repeated group sizes when available. Column details prioritize charts by role, including text word clouds, image dimensions, and ACF/PACF for time series. The correlation overview ranks the strongest column pairs and lets readers expand each method's matrix.

Detail tables preserve all supplied values and metric parameters, including original integer, decimal and temporal strings. “Not supplied” marks an absent metric and “Undefined” marks a computed null. Chart previews show approximate geometry and may limit the number of displayed values.

The renderer supports multiple tables, validates protocol-v1 inputs and escapes table names, column names, values and options. It produces offline HTML with native expand/collapse controls using only the supplied results. Samples, row-level scatterplots and missingness matrices require row-level data beyond the current result protocol.

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

The static playground in `site/` builds to `build/`, separately from the library's `dist/`. It starts with 128 sample orders and shows paginated data on the left and the existing `renderReport` output on the right. Upload CSV (with headers), JSON or Parquet up to 20 MB and 200 columns. Choose overview, detailed, or local full profiling, adjust histogram bins, language and theme, and export an offline HTML report.

DuckDB-Wasm computes overview and detailed statistics in the browser. Their correlations cover the first 20 numeric columns. The pinned Wasm engine loads from a CDN on first use. Each preview page shows 25 rows, and statistics use the full dataset. Failed imports roll back and retain the current dataset.

Pushes to `main` trigger [GitHub Actions](https://github.com/antvis/data-profiling/actions/workflows/deploy-pages.yml) to install dependencies, run tests, build and deploy to GitHub Pages. Manual runs are also supported. Assets use relative paths, including on the custom domain. Enable GitHub Actions as the publishing source in Settings → Pages; Pages requires a public repository on an organization Free plan.

### Local full profiling

Install the project dependencies, then set up Python and start the local engine from the repository.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r python-requirements.txt
PROFILING_PYTHON=.venv/bin/python npm run full:site
```

Open the [local playground](http://127.0.0.1:5174/) or allow the public playground to connect to the local engine when the browser prompts. Select 全量统计（本机）, assign column roles, a time index or a sort column as needed, and regenerate the report. The engine calls `profile()` with the full catalog. The report counts the metric IDs that apply to the data and configuration. Data stays on the device, and the engine listens on loopback.

The sample orders include preset roles, a time index, and bundled files. Select full profiling and regenerate to see 149/149.

File and image roles on uploaded data require a directory selected at startup. Append `-- "/absolute/path/to/files"` to the command above. Dataset paths can be relative to that directory or absolute paths inside it. The engine reads sizes, timestamps and image metadata from the original files.

### Tests and benchmarks

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

## Metric support by type

The 149 metric IDs in `profile()` include aliases and cover [126 single-column metrics](#single-column-metrics), [17 table metrics](#table-metrics) and [6 column-pair metrics](#column-pair-metrics). ✅ marks a supported target when its requirements are met. Blank cells mark inapplicable targets. A supported statistic can return a typed `null` when it is undefined.

### Single-column metrics

String columns default to categorical. Assign text, URL, path, file and image roles with `types`. Date/time covers DuckDB `DATE` and `TIMESTAMP` variants. Date string means a string column assigned `date`, and time series means a numeric column assigned `timeseries`. Unrecognized types include `LIST` and `STRUCT`. For these types, `is_orderable` returns `false`.

- `top_values` defaults to three entries and skips a column when its distinct non-missing values exceed 50% of the total row count. Set `maxDistinctRatio` to change the threshold. For date strings, top values and lengths use the original strings. Temporal bounds use successfully parsed dates.
- The four monotonicity metrics require `orderBy` or `timeIndex`. Stationarity, seasonality, gap metrics, `acf` and `pacf` require a numeric or temporal `timeIndex` with no missing values. These time-series metrics use explicitly assigned `timeseries` columns. When none are assigned, they use the numeric columns other than the index.
- File metadata and image content metrics require paths readable on the machine running the profile. Text metrics on file and image columns analyze their path strings.

| Metric ID | Numeric | Categorical | Boolean | Date/time | Text | Date string | URL | Path | File | Image | Time series | Unrecognized |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `observation_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `present_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `missing_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `null_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `missing_rate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `distinct_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `distinct_rate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `duplicate_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `is_unique` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `profiling_type` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `declared_type` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `is_groupable` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `is_orderable` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `column_memory_bytes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `top_values` |  | ✅ | ✅ |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `value_counts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `value_counts_by_value` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `singleton_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `singleton_rate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `boolean_mode` |  |  | ✅ |  |  |  |  |  |  |  |  |  |
| `boolean_mode_count` |  |  | ✅ |  |  |  |  |  |  |  |  |  |
| `category_imbalance_score` |  | ✅ | ✅ |  | ✅ |  |  |  |  |  |  |  |
| `min` | ✅ |  |  | ✅ |  | ✅ |  |  |  |  | ✅ |  |
| `max` | ✅ |  |  | ✅ |  | ✅ |  |  |  |  | ✅ |  |
| `mean` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `sum` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `median` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `range` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `stddev` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `stddev_samp` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `variance_samp` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `cv` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `iqr` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `mad` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `skewness` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `excess_kurtosis` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `negative_count` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `negative_rate` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `zero_count` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `zero_rate` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `infinity_count` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `infinity_rate` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `quantiles` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `numeric_histogram` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `chi_squared_statistic` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |  |  | ✅ |  |
| `chi_squared_p_value` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |  |  | ✅ |  |
| `min_timestamp` |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `max_timestamp` |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `time_span` |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `datetime_histogram` |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `invalid_date_distinct_count` |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `invalid_date_count` |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `invalid_date_rate` |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `min_length` |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `max_length` |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `mean_length` |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `median_length` |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `length_counts` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `length_histogram` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `character_count` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `distinct_character_count` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `character_counts` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_category_distinct_count` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_category_frequencies` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_category_character_counts` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_block_distinct_count` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_block_frequencies` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_block_character_counts` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_script_distinct_count` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_script_frequencies` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_script_character_counts` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `word_counts` |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `url_scheme_counts` |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_netloc_counts` |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_path_counts` |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_query_counts` |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_fragment_counts` |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `path_common_prefix` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_stem_counts` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_suffix_counts` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_basename_counts` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_parent_counts` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_drive_counts` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_stem_distinct_count` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_suffix_distinct_count` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_basename_distinct_count` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_parent_distinct_count` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_drive_distinct_count` |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `file_size_bytes` |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_size_histogram` |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_modified_time_counts` |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_access_time_counts` |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_metadata_change_time_counts` |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `truncated_image_count` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `image_dimension_counts` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `min_image_width` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `max_image_width` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `mean_image_width` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `median_image_width` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `min_image_height` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `max_image_height` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `mean_image_height` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `median_image_height` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `min_image_area` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `max_image_area` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `mean_image_area` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `median_image_area` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `exif_tag_counts` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `exif_value_counts` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `duplicate_image_hash_count` |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `is_nondecreasing` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_nonincreasing` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_strictly_increasing` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_strictly_decreasing` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `adf_p_value` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_stationary` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_seasonal` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `seasonal_periods` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `gap_count` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `gap_endpoints` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `min_gap` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `max_gap` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `mean_gap` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `stddev_gap_samp` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `acf` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `pacf` | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |

### Table metrics

Table results have an empty `columns` array. The two memory metrics require at least one selected column. The five time-series and index metrics require `timeIndex`.

| Metric ID | Whole table | Scope |
| --- | :---: | --- |
| `row_count` | ✅ | Rows in the source table. |
| `column_count` | ✅ | Columns in the source table, including columns outside the selected subset. |
| `column_type_counts` | ✅ | Selected columns grouped by inferred or assigned profiling type. |
| `missing_cell_count` | ✅ | Missing cells across the selected columns. |
| `missing_cell_rate` | ✅ | Missing cells divided by all cells in the selected columns. |
| `columns_with_missing_count` | ✅ | Selected columns with at least one missing value. |
| `all_missing_column_count` | ✅ | Selected columns in which every value is missing. An empty table gives zero. |
| `duplicate_group_count` | ✅ | Groups of two or more rows with the same values across the selected columns. |
| `duplicate_group_rate` | ✅ | Duplicate groups divided by the total row count. |
| `duplicate_group_row_count` | ✅ | Row counts for individual duplicate groups, largest first. |
| `table_memory_bytes` | ✅ | Pandas memory usage of the selected columns, including the index. |
| `mean_row_memory_bytes` | ✅ | Pandas memory usage divided by the row count. An empty table gives zero. |
| `time_series_count` | ✅ | With `timeIndex`, the number of series selected for time-series analysis. |
| `time_index_observation_count` | ✅ | Number of observations in `timeIndex`. |
| `time_index_start` | ✅ | Minimum value of `timeIndex`. |
| `time_index_end` | ✅ | Maximum value of `timeIndex`. |
| `mean_time_index_step` | ✅ | Mean absolute difference between adjacent `timeIndex` values in profiling order. |

### Column-pair metrics

Each unordered pair of columns is computed once. In this table, Numeric includes ordinary numeric and time-series columns. Category includes `categorical` and `boolean`. Other includes text, native date/time, date strings, URL, path, file and image. Pair metrics accept only recognized types.

| Metric ID | Numeric × Numeric | Numeric × Category | Category × Category | Numeric × Other | Category × Other | Other × Other | Calculation |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | --- |
| `pearson_r` | ✅ |  |  |  |  |  | Uses rows where both numeric values are finite. |
| `spearman_rho` | ✅ |  |  |  |  |  | Spearman rank correlation. |
| `kendall_tau` | ✅ |  |  |  |  |  | Kendall rank correlation. |
| `cramers_v` |  |  | ✅ |  |  |  | Each column needs 2–100 distinct non-missing values. Applies bias correction. |
| `phi_k` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Numeric columns need at least two distinct non-missing values. All other eligible columns need 2–100. |
| `auto_correlation` | ✅ | ✅ | ✅ |  |  |  | Each column needs at least two distinct non-missing values, and categorical columns allow up to 100. Numeric pairs use Spearman. Categorical and mixed pairs use Cramér’s V, with 10 equal-width bins for a mixed pair’s numeric column. |
