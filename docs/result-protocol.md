# Result protocol v1

`data_profiling(table_name)` returns one row per metric, target and parameter set.
The SQL entry point and these six columns stay fixed as new metrics are added.
The exported `ProfileResult`, `ProfileRow` and `MetricValue` TypeScript types describe this contract.

## Envelope

| Field | SQL representation | Meaning |
| --- | --- | --- |
| `protocol_version` | `INTEGER` | Always `1` for this protocol. |
| `table_name` | `VARCHAR` | The input table reference, exactly as supplied to the call. |
| `columns` | `VARCHAR[]` | Ordered, unquoted column names. `[]` targets the table, `["amount"]` one column, `["amount", "quantity"]` a pair. |
| `metric` | `VARCHAR` | Stable metric ID from the README. |
| `parameters` | `JSON` object | Effective metric-specific options, including defaults that affect the result. `{}` when there are none. |
| `value` | `JSON` object | A typed value as defined below; never a raw SQL NULL. |

The row identity is `(protocol_version, table_name, columns, metric, parameters)`.
Each identity occurs at most once in a result. Compare parameters as objects, not JSON text.
Options requiring exact integers, decimals or temporal precision use strings according to the metric's
parameter definition, rather than lossy JSON numbers. Parameter arrays retain their documented order.
Table references are connection-local, not global dataset IDs; AVA associates them with its own data sources.
Column names retain their original spelling and are data, not SQL fragments.

Pair order is meaningful. Symmetric metrics emit each pair once in source-schema order;
directional metrics preserve their documented left/right order. Matrices target the table (`columns: []`)
and carry their ordered axis labels inside the value. A metric involving an explicit group may use more than two columns.
SQL result row order is unspecified; callers may apply `ORDER BY`.

## Typed values

Every value has a `type` discriminator and a `value` member. Lists and objects recurse into the same type.

| `type` | `value` | Rules |
| --- | --- | --- |
| `integer` | decimal integer string | Exact counts and integer results, including values beyond JavaScript's safe integer range. No exponent or separators. |
| `decimal` | decimal string | Exact decimal results. Preserve scale; no exponent or separators. |
| `number` | JSON number or `"NaN"`, `"Infinity"`, `"-Infinity"` | Floating-point results. Only finite values use JSON numbers. These strings are numeric sentinels, not missing values. |
| `boolean` | JSON boolean | Boolean flags. |
| `string` | JSON string | Text and categorical labels. |
| `date` | ISO 8601 date string | Calendar date, without a timezone. Extended years are permitted. |
| `timestamp` | ISO 8601 datetime string without an offset | Local/naive timestamp; preserve fractional-second precision. |
| `timestamptz` | ISO 8601 datetime string ending in `Z` | UTC instant; preserve fractional-second precision. Do not convert through JavaScript `Date`. |
| `duration` | `{ "amount": "1.000000001", "unit": "second" }` | Exact amount and explicit unit. Calendar months/years must not be silently converted to fixed-length seconds. Mixed calendar intervals use an `object` with months, days and subsecond components. |
| `list` | typed value array | Ordered entries, including empty lists. |
| `object` | object mapping names to typed values | Structured results. Data values used as categories belong in entries, not object keys. |
| `null` | JSON `null` | A computed but undefined result. An optional `reason` explains e.g. `empty_input`, `insufficient_data`, `constant_input` or `zero_denominator`. |

Zero counts are `{"type":"integer","value":"0"}`; empty distributions contain an empty `list`.
Neither is an undefined result. A skipped or unrequested metric has no row. Execution failures raise errors;
they must not be silently converted to null values. Metric definitions specify when non-finite temporal values
are excluded; if retained, the temporal value uses the explicit `"Infinity"` / `"-Infinity"` sentinel.

The envelope remains the same for every README metric family:

| Family | Value shape |
| --- | --- |
| Counts, sums, means, ranges, flags, labels | The corresponding scalar typed value. Exact decimal sums remain `decimal`, not `number`. |
| Quantiles | `object` with `entries: list` of `object` values containing `probability: number` and a typed `value`. Preserve probability order; an undefined quantile uses `null` within its entry. |
| Numeric, datetime and length histograms | `object` with typed `edges: list`, `counts: list` of integers, `closed: string` (`left` or `right`) and `last_bin_closed: boolean`. For nonempty bins, edges are ascending and `edges.length = counts.length + 1`. A constant column uses one bin with equal edges and both ends included. No observations gives empty edges/counts; a supplied fixed binning may retain zero-count bins. |
| Value, character, type and component frequencies | `object` with `entries: list` of `object` values containing a typed `value` and integer `count`, plus `truncated: boolean`. No silent truncation. Lists support numeric, Boolean and datetime categories without string-key coercion. |
| Pearson, Spearman, Kendall, Cramér's V, Phi-K | Scalar `number` or `null`, targeting the ordered pair in `columns`. No extra outer columns are needed. |
| Correlation matrices and missingness masks | `object` with ordered `row_labels: list`, `column_labels: list` and `values: list` of row lists. Dimensions match the labels. Observation-order-dependent results require their ordering options in `parameters`. |
| ACF/PACF, gaps, file/image metadata | `object`/`list` records with typed lags, intervals, bounds, counts and labels. Units and ordering are explicit in the value or parameters. |

Metric-specific fields can be added to structured values without changing the outer columns.
Their semantics and types must be documented with that metric. These are representation contracts,
not a claim that the corresponding computations have been implemented.

## Construction and execution

- Category files own calculations and typed value encoding. For example, `data_profiling_row_count()`
  returns `data_profiling_value('integer', count(*)::VARCHAR)`.
- `sql/data_profiling.sql` batches compatible aggregates and routes their results. It does not reimplement metric formulas.
- `data_profiling_value(type, payload)` builds the common JSON tag. Complex payloads can use
  DuckDB's [JSON construction functions](https://duckdb.org/docs/2.0/data/json/creating_json).
- `data_profiling_result(table_name, columns, metric, value, parameters := '{}'::JSON)` is the shared envelope constructor.
  Producers supply valid typed payloads; it casts the envelope fields and JSON rather than implementing metric-specific validation.
- Simple aggregations share a scan. Grouping, sorting, distributions, pairs and external-resource metrics can use separate
  execution stages, each emitting this same envelope. The result protocol imposes no single-scan requirement.

For example, future pair metrics can construct results using:

```sql
SELECT unnest(data_profiling_result(
    'orders', ['amount', 'quantity'], 'pearson_r',
    data_profiling_value('number', 0.75)
));
```

This example constructs a result; it does not compute a correlation.
Additional [numeric, distribution, temporal and pair examples](./result-examples.json) are checked for SQL/JSON round trips.

## Node transport

The [Node DuckDB driver](https://duckdb.org/docs/2.0/clients/node_neo/overview) returns JSON columns as strings.
`ProfileRow` is that wire shape; parsing `parameters` and `value` gives `ProfileResult`:

```ts
import type { ProfileResult, ProfileRow } from 'data_profiling';

const results: ProfileResult[] = (reader.getRowObjectsJson() as ProfileRow[]).map((row) => ({
  ...row,
  parameters: JSON.parse(row.parameters),
  value: JSON.parse(row.value),
}));
```

Integer and decimal values remain strings after this parse. Consumers choose numeric conversions according to their
precision requirements. AVA may map the envelope into its own `Profile` object without changing the library protocol.

## Compatibility

Adding metrics, parameter options or documented optional fields inside structured values is additive.
Readers ignore unknown metric IDs and optional object fields, and reject unknown protocol versions.
Changing outer columns, existing value meanings/types, column ordering or an existing metric's required payload shape
requires a new protocol version or a new metric ID; it is not a silent v1 change.

This draft replaces the earlier `column_name / metric / BIGINT value` prototype. Only `row_count`,
`column_count` and `missing_count` are computed today. The other shapes are contracts and examples for future implementations.

## Relationship to fg-data-profiling

This is not fg's report schema. fg organizes its report into table summaries, variables and correlations;
this library emits queryable metric rows and uses fg to check numerical results.

| Implemented metric | fg reference field |
| --- | --- |
| `row_count`, `columns: []` | `table.n` |
| `column_count`, `columns: []` | `table.n_var` |
| `missing_count`, `columns: [name]` | `variables[name].n_missing` |

The reference fixtures align Python missing values with SQL NULL. They do not assert equivalence between
pandas missingness and native DuckDB NaN, nor between the future libraries' binning or correlation defaults.
Compatibility with fg report JSON would be a separate adapter, not a different SQL result envelope.
