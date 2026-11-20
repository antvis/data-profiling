**English** | [简体中文](./README.zh-CN.md)

# Data Profiling

Compile schema-directed DuckDB profiling plans. Reuse the caller's connection, batch the requested aggregates and return only statistics to JavaScript.

The only runtime entry point is `createProfilingPlan`. No macro registration, SQL file loading or runtime npm dependencies are required.

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
npm pack
```

Source consists of native plan compilation, result types and public exports. Tests cover calculations, precision, empty inputs, validation, statement reuse and constrained memory. Benchmarks cover mixed data, unique strings, wider numeric tables and a five-million-row sum under a 16 MB limit. Timings are local in-memory measurements and exclude file/network I/O.

Version 0.2.0 exposes only the native plan API. Legacy SQL macros, SQL-side JSON transport and individual metric functions have been removed.
