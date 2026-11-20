**English** | [简体中文](./README.zh-CN.md)

# Data Profiling

Compile schema-directed DuckDB profiling plans. Reuse the caller's connection, batch the requested aggregates and return only statistics to JavaScript.

`createProfilingPlan` is the native SQL entry point. `profileFG` adds FG’s complete statistical families, including optional file, image and time-series analysis. Native execution requires no macro registration or runtime npm dependencies.

## Usage

```ts
import { createProfilingPlan } from 'data_profiling';
import type { ProfileColumn } from 'data_profiling';

const columns = (await connection.runAndReadAll(
  'SELECT name, type FROM pragma_table_info(?)', ['orders'],
)).getRowObjectsJson() as ProfileColumn[];

const plan = createProfilingPlan('orders', columns);
const reader = await connection.runAndReadAll(plan.sql);
const results = plan.decode(reader.getRowObjectsJson()[0]);
```

Pass an existing schema directly to avoid the metadata query. The column list can be a subset. Table references use DuckDB's qualified names, such as `sales.orders`; quote unusual components separately.

Select metrics through `options.metrics`. Omitting it computes all 15 built-ins; `[]` requests no statistics. The last configuration for an ID wins.

```ts
const plan = createProfilingPlan('orders', columns, {
  metrics: ['row_count', 'null_count', 'min', 'max', 'mean', 'sum',
    { id: 'top_values', limit: 3, maxDistinctRatio: 0.5 }],
});
```

`plan.sql` returns one native aggregate row. `plan.decode` converts a `getRowObjectsJson()` row into `ProfileResult[]`. Consumers with their own output format can use `plan.metrics` to read native values directly and avoid extra result construction.

## Metrics and precision

| Metric | Scope and definition |
| --- | --- |
| `row_count`, `column_count` | Total rows and the input table's actual column count. |
| `null_count`, `missing_count` | SQL NULL count per column; both names share an aggregate. |
| `distinct_count` | Exact non-NULL cardinality for numeric, string, Boolean and temporal columns. |
| `duplicate_count` | Non-NULL count minus distinct count per column. |
| `min`, `max` | Finite bounds for numeric and temporal columns. |
| `mean`, `sum`, `stddev`, `median` | Native numeric aggregates excluding non-finite floating values. Standard deviation is sample-based; decimal medians retain DuckDB's scale and rounding. |
| `min_length`, `max_length` | Unicode character lengths, including empty strings and trailing spaces. |
| `top_values` | Non-NULL string/Boolean frequencies, ordered by count descending then native value ascending. Defaults to 3 entries; omitted when distinct count / total rows exceeds 0.5. |

Integer and decimal results retain exact typed strings. Floating results use numbers or the `NaN`, `Infinity`, `-Infinity` string sentinels. Temporal precision is preserved, with time-zone-aware values normalized to UTC. Undefined results use typed `null`; unsupported or skipped metrics produce no record.

Each result contains `protocol_version`, `table_name`, `columns`, `metric`, `parameters` and `value`. Table targets use `columns: []`; column targets use `[name]`. Values carry `type` and `value` tags. `top_values` contains a typed `entries` list and `truncated` Boolean. See the exported `ProfileResult` and `MetricValue` types.

`top_values.limit` must be a non-negative JavaScript-safe integer; `maxDistinctRatio` must be between 0 and 1. Unknown metrics/options and duplicate column names are rejected before execution.

## FG metrics

`profileFG` supports 149 metric IDs, including the existing 15. It defaults to the complete catalog; choose `options.metrics` to run only what you need. See [the implemented catalog and execution requirements](./docs/fg-metrics.md).

```ts
import { profileFG } from 'data_profiling';

const results = await profileFG(connection, 'events', columns, {
  metrics: ['row_count', 'present_count', 'missing_rate',
    'variance_samp', 'singleton_count', 'pearson_r'],
});
```

These metrics run entirely in DuckDB. Ordinary numeric quantiles/histograms also run natively. Exact large-integer/decimal quantiles, p-values, Unicode, URL/path, image and time-series algorithms use an optional Python worker. Install its dependencies in an isolated environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r python-requirements.txt
```

```ts
const results = await profileFG(connection, 'events', columns, {
  python: '.venv/bin/python',
  types: { message: 'text', link: 'url', attachment: 'file',
    picture: 'image', measurement: 'timeseries' },
  timeIndex: 'observed_at',
});
```

File/image/URL/path roles are explicit. Ordered metrics require `orderBy` or `timeIndex`; time-series metrics require `timeIndex`. Unassigned optional roles are skipped. Types come from the supplied schema, without scanning to guess types. FG mode treats floating NaN as missing and retains infinities in numeric bounds; the AVA default remains unchanged.

Only grouped values and the columns needed by non-SQL algorithms are exported to temporary Parquet. Repeated paths are read once per request. Python workers retain imports for reuse and exit after 30 seconds idle; statistics and file metadata are recalculated on every request. Temporary exports are removed on success and failure. Use the caller’s transaction when a consistent snapshot across stages is needed.

## Execution and memory

Type selection and validation happen when compiling the plan. DuckDB executes native aggregates and reuses compatible states; frequencies use grouping and Top-N. Sums do not materialize full-column lists. For a lightweight profile, explicitly select streaming metrics such as counts, bounds, means, sums, standard deviations and lengths.

Plans do not cache statistics. Reuse a plan while its schema is unchanged, and use `connection.prepare(plan.sql)` to reuse a prepared statement. Release statements with `destroySync()`. Every execution reads current data; recompile after schema changes.

The caller's DuckDB connection controls parallelism and resource limits. Exact distinct counts, frequency grouping and medians still need data-dependent state.

## Development

Node.js 22.13 or later:

```sh
npm install
npm test
node examples/node.mjs
npm run bench -- 200000
FG_PYTHON=.venv/bin/python npm run bench:fg -- 200000
npm pack
```

Tests cover native calculations, precision, empty inputs, validation, statement reuse, constrained memory and every FG metric family. Set `FG_PYTHON=.venv/bin/python npm test` to include optional algorithm tests. Run `node examples/fg.mjs .venv/bin/python` for a complete FG example. Benchmarks cover mixed data, unique strings, wider numeric tables and a five-million-row sum under a 16 MB limit. Timings are local in-memory measurements and exclude file/network I/O.

Legacy SQL macros, SQL-side JSON transport and individual metric functions remain removed. Version 0.3 adds the FG executor while retaining the original native plan API and defaults.
