**English** | [简体中文](./README.zh-CN.md)

# Data Profiling

Data Profiling is a TypeScript library for profiling tabular data with DuckDB SQL, inspired by [fg-data-profiling](https://github.com/Data-Centric-AI-Community/fg-data-profiling). Its focus is on statistics you can query and reuse.

## Quick start

The npm package generates native DuckDB SQL for AVA and other Node.js consumers. It reuses the caller's DuckDB connection and has no runtime npm dependencies. Running the library or its normal tests requires no Python environment.

For local integration, install this repository in the consuming project:

```sh
npm install /absolute/path/to/data_profiling
```

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

AVA already has the column schema and passes it directly to `createProfilingPlan`, avoiding the metadata query. The generated SQL is read-only; no macro registration or connection settings are needed. AVA adapts native aggregate values to its own `Profile` structure.

## Native execution

`createProfilingPlan(tableName, columns, options?)` is the preferred path for Node.js. It compiles type-specific `SUM`, `MEDIAN`, `AVG` and other native aggregates into one query, reuses compatible aggregates and returns one native result row. `plan.decode(reader.getRowObjectsJson()[0])` converts that row to `ProfileResult[]`, preserving exact integers, decimal scale and temporal precision. No source rows are copied into JavaScript.

Supply `options.metrics` to select IDs or configurations such as `{ id: 'top_values', limit: 10, maxDistinctRatio: 1 }`. The last configuration for an ID wins. Omitted metrics mean all 15 built-ins; `[]` means no statistics. The column list can be a subset of the known schema. Identifiers are quoted and metric options are validated before execution. Rebuild the plan if the schema changes.

For a lightweight profile, select `row_count`, `column_count`, `null_count`, `missing_count`, `min`, `max`, `mean`, `stddev`, `min_length` and `max_length` through `options.metrics`. These remain streaming native aggregates; `sum` can also be included without collecting a full-column list. This uses the same compiler as the full profile, rather than a separate fast macro.

The plan contains no cached statistics. For repeated computations on the same schema, reuse `plan.sql` or prepare it with `connection.prepare(plan.sql)` and release the statement with `destroySync()` when finished. Each execution reads the current data.

`createProfilingSQL(tableName, columns, options?)` generates the same native aggregates but formats the six-column protocol in SQL; parse its `parameters` and `value` JSON fields as described below. It is useful for SQL-oriented consumers. The original `dataProfilingSQL` bundle and `data_profiling(table_name)` remain compatible, including custom discovered macros; their generic type handling is slower. The native compiler supports the built-in metrics listed below.

Native sums stream without an extra full-column list. Exact distinct counts and native medians still require memory proportional to their data. No approximate counts, sampling or result caches are introduced. Run the equality-checked benchmark with:

```sh
npm run bench -- 200000
```

It compares the generic macros, native plans, SQL JSON transport and prepared native plans, including unique strings, wider numeric tables and a five-million-row sum under a 16 MB memory limit.

To run the [complete Node.js example](./examples/node.mjs) from this repository after `npm install`:

```sh
npm run build
node examples/node.mjs
```

The example creates an in-memory table, loads the SQL, profiles the table and prints the parsed results.

## Result protocol v1

| Field | Meaning |
| --- | --- |
| `protocol_version` | `1`; version of this result contract. |
| `table_name` | Input table reference as supplied. |
| `columns` | `[]` for table metrics; one name for column metrics; two ordered names for pairs. |
| `metric` | Metric ID from the catalog below. |
| `parameters` | JSON object containing effective metric options. |
| `value` | Typed JSON value, recursively supporting scalars, lists and objects. |

Exact integers and decimals are strings inside typed values. Floating-point numbers, special numeric values, timestamps, durations and undefined results have explicit encodings. Histogram edges/counts and quantile entries are structured values; pair metrics use the same six columns. See the [full contract, compatibility rules and metric-family shapes](./docs/result-protocol.md), exported `ProfileResult` / `ProfileRow` TypeScript types.

The Node driver returns JSON columns as text; parsing them produces `ProfileResult` as shown above. No conversion to JavaScript `number` is required.

## DuckDB CLI

Run `npm run build` first, then load the generated SQL bundle, which includes the protocol helpers, metric categories and public entry point:

```sql
.read dist/data_profiling.sql

CREATE TEMP TABLE orders AS
SELECT * FROM (VALUES (120, 'web'), (80, 'store'), (NULL, NULL)) AS t(amount, channel);

SELECT * FROM data_profiling('orders');
```

`.read` is a CLI command. Other clients execute `dataProfilingSQL`, which includes every required SQL file.

## Organization and execution

```text
sql/
  result.sql               # Shared value and envelope constructors
  metrics/
    table.sql              # Table metrics; comment blocks separate definitions
    missingness.sql        # Column missingness metrics
    cardinality.sql        # Exact distinct counts
    frequency.sql          # Top category frequencies
    numeric.sql            # Numeric/temporal aggregates
    string.sql             # String length bounds
src/
  index.ts                 # Public exports
  profile-query.ts         # Schema-directed native plans and result encoding
  generate-sql.ts          # Discover metrics and generate the batch entry point
  types.ts                 # Protocol types
dist/                      # Generated JavaScript, declarations and SQL bundle; ignored by Git
docs/
  result-protocol.md
examples/
  node.mjs                 # Runnable Node.js example
tests/
  result.test.ts
  metrics/table.test.ts
  metrics/missingness.test.ts
  data-profiling.test.ts
  generate-sql.test.ts      # Automatic discovery and empty-input regressions
  fixture.ts               # Shared test input and connection setup
```

Category functions own each metric's calculation and typed value. The build loads `sql/metrics/*.sql` in filename order, discovers metrics from DuckDB's macro catalog and generates `dist/data_profiling.sql` with all definitions and the batch entry point. That entry batches compatible aggregates, expands them into rows and calls `data_profiling_result`. Compatible aggregates share one input scan. Column names are recovered after aggregation so empty inputs retain their names. The npm module reads the generated bundle once when loaded and needs no build dependencies at runtime.

To add a metric, append a macro to an existing category or add a new `.sql` category file, then run `npm run build`. Name it `data_profiling_<metric ID>`, with an ID starting with a lowercase letter and containing only lowercase letters, digits and underscores. `data_profiling_value` and `data_profiling_result` are reserved protocol helpers. Parameter names determine execution:

| Macro parameters | Execution | Result target |
| --- | --- | --- |
| `()` | Aggregate with the other metrics over the input | Table `[]` |
| `(table_name)` | Read metadata using the table reference | Table `[]` |
| `(column_value)` | Aggregate each column | Single column `[name]` |
| `(column_value, metric_parameters := '{}'::JSON)` | Aggregate each column with default options | Single column `[name]` |

Metrics return protocol-compliant typed values, or SQL NULL to skip an unsupported target. An undefined result on a supported target returns the typed `null` value instead. Column macros must bind on every input type; the built-in metrics check types internally. Optional `_data_profiling_parameters_<metric ID>()` helpers supply the effective parameter object; otherwise it is `{}`. Internal `_data_profiling_*` helpers are not discovered as metrics. Unsupported signatures or table macros fail the build. Discovery happens at build time: reload the complete SQL bundle to activate new metrics. Registering a macro in an existing connection alone does not update the batch entry point.

The protocol can represent every metric family listed below without changing its outer columns. Execution support is separate: distributions and pairs can require grouping/sorting or additional stages, while file/image metadata and ADF may need extensions or execution adapters. Adding them does not require every metric to share one scan. Use EXPLAIN ANALYZE and representative data to verify performance.

## Development

Use Node.js 22.13 or later:

```sh
npm install
npm run build
npm test
npm pack
```

`package-lock.json` is local-only and ignored by Git. Both `src/` and the tests use TypeScript. Tests are type-checked before running with Node's built-in test runner; `@duckdb/node-api` 2.0.0-r.1 is a development dependency only.

`npm run build` compiles the library into `dist/` and generates declarations and the SQL bundle. `npm install`, `npm test` and `npm pack` also trigger the build. Only `sql/result.sql` and `sql/metrics/*.sql` are maintained as SQL source. Generated files stay in `dist/` and are ignored by Git. The package contains compiled runtime output, the single SQL bundle and protocol documentation, excluding source SQL, tests, the generator and build dependencies. It has not been published to npm.

Tests cover all implemented metrics, type eligibility, empty/all-NULL inputs, non-finite numbers, exact numeric and temporal bounds, category ordering/truncation, the result protocol and automatic metric discovery. Essential test data and expectations live directly in the test sources.

## Implemented metrics

`data_profiling(table_name)` computes all 13 AVA metrics, plus the existing `column_count` and `missing_count` metrics:

| ID | Target | Calculation |
| --- | --- | --- |
| `row_count` | Table | All rows, including rows containing NULL. |
| `column_count` | Table | Number of columns, including on empty inputs. |
| `null_count`, `missing_count` | Every column | SQL NULL count; empty strings, zero and NaN are not NULL. Both IDs remain available. |
| `distinct_count` | Numeric, string, Boolean, date/timestamp | Exact number of distinct non-NULL values. Includes non-finite values. |
| `top_values` | String, Boolean | Up to 3 non-NULL values by count descending, then native value ascending. Omitted when distinct count / total row count exceeds 0.5. |
| `min`, `max` | Numeric, date/timestamp | Bounds over finite values. Integers/decimals retain exact strings; dates/timestamps retain native precision. |
| `mean` | Numeric | Arithmetic mean of finite values, returned as a floating-point `number`. |
| `duplicate_count` | Every column | Non-NULL count minus distinct non-NULL count; this counts repeated values, not duplicate rows. |
| `min_length`, `max_length` | String | Shortest/longest Unicode character length, including empty strings and trailing spaces. |
| `sum` | Numeric | Native sum over finite values; exact integer/decimal results retain their typed strings. |
| `stddev` | Numeric | Sample standard deviation over finite values (n−1); typed `null` for fewer than two values. |
| `median` | Numeric | Native median over finite values, retaining DuckDB's decimal scale and rounding. |

String columns include DuckDB UUID and ENUM types. Unsupported types receive only the NULL and duplicate counts. Empty or all-NULL eligible columns return zero counts, empty frequency entries and typed `null` bounds/means.

`top_values` records the fixed AVA defaults `{ "limit": 3, "maxDistinctRatio": 0.5 }` in `parameters`. Its typed `object` contains an `entries` list of `{ value, count }` objects and a `truncated` Boolean; every nested field uses the result protocol's typed values. `truncated` is true when eligible categories exceed the limit. The denominator includes NULL rows. The batch entry point uses these defaults. Individual calls can supply a validated JSON options object:

```sql
SELECT data_profiling_top_values(channel, '{"limit": 10, "maxDistinctRatio": 1}'::JSON)
FROM orders;
```

`limit` must be a non-negative JavaScript-safe integer; `maxDistinctRatio` must be between 0 and 1. Unknown options are rejected. The compatibility macros for `sum` and `median` materialize a list; prefer native plans to avoid this additional allocation.

Results use this library's protocol: temporal bounds are ISO strings rather than AVA's Unix milliseconds, and exact counts are integer strings rather than JavaScript numbers. Consumers adapt these representations when integrating with AVA.

## Macro column selection

Native plans already accept a schema subset. The following macro API is a design example and is not implemented:

```sql
SELECT * FROM data_profiling('orders', columns := ['amount', 'quantity']);
```

## Planned core metrics

The **Importance** rating reflects each group's value for general-purpose profiling. Five stars mark the core metrics. Four stars are for common follow-up analyses, three for context-specific statistics, two for specialized analysis, and one for narrow domain needs.

The tags describe the library's planned behavior for applicable input types.

- `default` includes the metric in the standard profile.
- `minimal` includes the metric in the lighter profile. `minimal (text)` applies to text columns in that profile.
- `config` identifies a setting that controls the metric. A metric with only a `config` tag requires that setting to be supplied or enabled.

Names, IDs and tags correspond line by line in each group.

| Scope | Name | ID | Calculation tags | Importance | Calculation |
| --- | --- | --- | --- | :---: | --- |
| Table size | Row count<br>Column count | `row_count`<br>`column_count` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | Count the rows and columns in the input table or view. |
| Column types | Column counts by type | `column_type_counts` | `default` · `minimal` | ⭐⭐⭐⭐⭐ | Group columns by their profiling type and count each group. |
| Duplicate groups | Duplicate group count<br>Duplicate group ratio | `duplicate_group_count`<br>`duplicate_group_rate` | `default` · `config` (duplicate detection)<br>`default` · `config` (duplicate detection) | ⭐⭐⭐⭐⭐ | Group rows by their profiled values and count the groups containing more than one row. Divide the group count by the total row count for the ratio. |
| Column missingness | Observation count<br>Missing count<br>Missing rate<br>Present count | `observation_count`<br>`missing_count`<br>`missing_rate`<br>`present_count` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | Count all observations and the missing observations for each column. The difference gives the present count. The rate uses all observations as the denominator. |
| Value frequencies | Value frequencies<br>Frequencies ordered by value | `value_counts`<br>`value_counts_by_value` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | Count occurrences of each present value. Sort by value to inspect the ends of an ordered column. |
| Distinct values | Distinct value count<br>Distinct value ratio | `distinct_count`<br>`distinct_rate` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | Count distinct present values. Divide by the count of present observations for the ratio. |
| Numeric location and range | Minimum<br>Maximum<br>Mean<br>Sum<br>Range | `min`<br>`max`<br>`mean`<br>`sum`<br>`range` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | Summarize numeric values with basic aggregates. Subtract the minimum from the maximum for the range. |
| Quantiles | Quantiles<br>Median | `quantiles`<br>`median` | `default` · `minimal` · `config` (numeric distributions)<br>`default` · `minimal` · `config` (numeric distributions) | ⭐⭐⭐⭐⭐ | Find values at selected cumulative probabilities, such as P5, P25, P50, P75 and P95. P50 is the median. |
| Numeric distribution | Numeric histogram | `numeric_histogram` | `default` · `minimal` · `config` (numeric distributions) | ⭐⭐⭐⭐⭐ | Bin finite numeric values and retain the bin edges and frequencies. |
| Datetime range | Earliest time<br>Latest time<br>Time span | `min_timestamp`<br>`max_timestamp`<br>`time_span` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | Find the earliest and latest valid datetime values and subtract the earliest from the latest. |
| String lengths | Minimum string length<br>Maximum string length<br>Mean string length<br>Median string length | `min_length`<br>`max_length`<br>`mean_length`<br>`median_length` | `default` · `minimal (text)` · `config` (string lengths)<br>`default` · `minimal (text)` · `config` (string lengths)<br>`default` · `minimal (text)` · `config` (string lengths)<br>`default` · `minimal (text)` · `config` (string lengths) | ⭐⭐⭐⭐⭐ | Measure character lengths and summarize them using each length's frequency. |
| Linear and rank correlation | Pearson correlation<br>Spearman rank correlation | `pearson_r`<br>`spearman_rho` | `default` · `config` (correlation methods)<br>`default` · `config` (correlation methods) | ⭐⭐⭐⭐⭐ | Measure linear association and rank association between pairs of numeric columns. |

<details>
<summary>More metrics (40 groups)</summary>

| Scope | Name | ID | Calculation tags | Importance | Calculation |
| --- | --- | --- | --- | :---: | --- |
| Table missingness | Missing cell count<br>Missing cell rate | `missing_cell_count`<br>`missing_cell_rate` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | Sum the missing counts across columns and divide by the number of cells for the rate. |
| Table missingness | Columns with missing values<br>Entirely missing columns | `columns_with_missing_count`<br>`all_missing_column_count` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | Count columns with at least one missing value and columns whose values are all missing. |
| Table memory | Table memory use<br>Average memory per row | `table_memory_bytes`<br>`mean_row_memory_bytes` | `config` (memory usage)<br>`config` (memory usage) | ⭐⭐ | Measure the input data's memory use and divide it by the row count for the per-row average. |
| Duplicate counts | Duplicate group sizes | `duplicate_group_row_count` | `default` · `config` (duplicate detection) | ⭐⭐⭐⭐ | Count the rows in each duplicate group to show how often the same value combination occurs. |
| Column classification | Profiling type<br>Declared type<br>Grouping support<br>Ordering support | `profiling_type`<br>`declared_type`<br>`is_groupable`<br>`is_orderable` | `default` · `minimal`<br>`config` (type override)<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | Record the type used for profiling, any declared type, and whether values can be grouped and ordered. |
| Column memory | Column memory use | `column_memory_bytes` | `config` (memory usage) | ⭐⭐ | Measure the memory used by a column's input data. |
| Singletons and uniqueness | Singleton count<br>Singleton ratio<br>Uniqueness | `singleton_count`<br>`singleton_rate`<br>`is_unique` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | Count the values that appear exactly once. Divide by the present observation count for the ratio. Check whether every present observation has a unique value when the column contains at least one present observation. |
| Numeric spread | Sample variance<br>Sample standard deviation<br>Coefficient of variation | `variance_samp`<br>`stddev_samp`<br>`cv` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | Measure sample dispersion and divide the standard deviation by the mean for the coefficient of variation when the mean is nonzero. |
| Numeric shape | Skewness<br>Excess kurtosis | `skewness`<br>`excess_kurtosis` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐ | Measure distribution asymmetry and the fourth standardized moment relative to a normal distribution. |
| Special numeric values | Negative value count<br>Negative value rate<br>Zero count<br>Zero rate<br>Infinity count<br>Infinity rate | `negative_count`<br>`negative_rate`<br>`zero_count`<br>`zero_rate`<br>`infinity_count`<br>`infinity_rate` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | Count negative values, zero values and positive or negative infinity. Divide by all observations for each rate. Negative infinity also contributes to the negative count. |
| Robust spread | Interquartile range<br>Median absolute deviation | `iqr`<br>`mad` | `default` · `minimal` · `config` (numeric distributions)<br>`default` · `minimal` | ⭐⭐⭐⭐ | Subtract P25 from P75 for the interquartile range. For the median absolute deviation, take the median of the absolute differences from the median. |
| Numeric monotonicity | Nondecreasing order<br>Nonincreasing order<br>Strictly increasing order<br>Strictly decreasing order | `is_nondecreasing`<br>`is_nonincreasing`<br>`is_strictly_increasing`<br>`is_strictly_decreasing` | `config` (row order)<br>`config` (row order)<br>`config` (row order)<br>`config` (row order) | ⭐⭐⭐ | Check whether values are nondecreasing or nonincreasing in the specified order. Strict monotonicity also requires distinct values. |
| Chi-square | Chi-square statistic<br>Chi-square p-value | `chi_squared_statistic`<br>`chi_squared_p_value` | `default` · `config` (uniformity tests)<br>`default` · `config` (uniformity tests) | ⭐⭐ | Compare observed frequencies with equal expected frequencies, using category counts or bins for numeric and datetime values. |
| Boolean mode | Most frequent Boolean value<br>Most frequent Boolean value count | `boolean_mode`<br>`boolean_mode_count` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐ | Identify the most frequent present Boolean value and count its occurrences. |
| Class imbalance | Class imbalance score | `category_imbalance_score` | `default` · `minimal` | ⭐⭐⭐ | Subtract Shannon entropy divided by the base-two logarithm of the observed class count from one. A single observed class gives a score of zero. |
| Invalid dates | Distinct invalid dates<br>Rows with invalid dates<br>Invalid date rate | `invalid_date_distinct_count`<br>`invalid_date_count`<br>`invalid_date_rate` | `config` (date parsing)<br>`config` (date parsing)<br>`config` (date parsing) | ⭐⭐⭐⭐ | Count distinct present values that fail date parsing and count the affected rows. Divide the affected row count by all rows for the rate. |
| Datetime distribution | Datetime histogram | `datetime_histogram` | `default` · `minimal` · `config` (time distributions) | ⭐⭐⭐⭐ | Put datetime values into time bins and count the observations in each bin. |
| String length distribution | Length frequencies<br>Length histogram | `length_counts`<br>`length_histogram` | `default` · `minimal (text)` · `config` (string lengths)<br>`default` · `minimal (text)` · `config` (string lengths) | ⭐⭐⭐ | Count strings at each integer length, or bin those lengths using their frequencies as weights. |
| Character frequencies | Character count<br>Distinct character count<br>Character frequencies | `character_count`<br>`distinct_character_count`<br>`character_counts` | `default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode) | ⭐⭐⭐ | Count each character's occurrences, sum the counts and count the distinct characters. |
| Unicode categories | Unicode category count<br>Unicode category frequencies<br>Character frequencies within categories | `unicode_category_distinct_count`<br>`unicode_category_frequencies`<br>`unicode_category_character_counts` | `default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode) | ⭐⭐ | Map characters to Unicode categories and count both the categories and the characters within them. |
| Unicode blocks | Unicode block count<br>Unicode block frequencies<br>Character frequencies within Unicode blocks | `unicode_block_distinct_count`<br>`unicode_block_frequencies`<br>`unicode_block_character_counts` | `default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode) | ⭐⭐ | Map characters to Unicode blocks and report counts by block and by character within each block. |
| Unicode scripts | Writing system count<br>Writing system frequencies<br>Character frequencies within writing systems | `unicode_script_distinct_count`<br>`unicode_script_frequencies`<br>`unicode_script_character_counts` | `default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode)<br>`default` · `minimal (text)` · `config` (characters and Unicode) | ⭐⭐ | Group character occurrences by Unicode script and count the scripts and the characters within them. |
| Word frequencies | Word frequencies | `word_counts` | `default` · `minimal (text)` · `config` (word frequencies) | ⭐⭐⭐ | Normalize case, split on whitespace, strip leading and trailing punctuation, and count words after removing configured stop words. |
| Missingness patterns | Present counts by column<br>Cell-level missingness flags<br>Missingness correlation | `column_present_counts`<br>`missing_mask`<br>`missingness_correlation` | `default` · `minimal`<br>`config` (missingness patterns)<br>`config` (missingness patterns) | ⭐⭐⭐ | Count present values by column, record whether each cell is missing, and correlate missingness flags across columns with varying missingness. |
| Automatic association | Association by column type | `auto_association` | `config` (automatic association) | ⭐⭐⭐⭐ | Use rank correlation for numeric pairs and corrected Cramér’s V for pairs involving categorical or Boolean values. Bin numeric values in mixed pairs. |
| Kendall rank correlation | Kendall rank correlation | `kendall_tau` | `config` (correlation methods) | ⭐⭐⭐ | Measure rank association based on agreements and disagreements in pairwise order. |
| Categorical association | Corrected Cramér’s V | `cramers_v` | `config` (correlation methods) | ⭐⭐⭐ | Build a contingency table for two categorical or Boolean columns and calculate the bias-corrected association strength. |
| Phi-K association | Phi-K association | `phi_k` | `config` (correlation methods) | ⭐⭐ | Calculate the association strength from binned contingency tables for eligible column pairs. |
| URL components | URL scheme frequencies<br>URL network location frequencies<br>URL path frequencies<br>URL query string frequencies<br>URL fragment frequencies | `url_scheme_counts`<br>`url_netloc_counts`<br>`url_path_counts`<br>`url_query_counts`<br>`url_fragment_counts` | `config` (URL profiling)<br>`config` (URL profiling)<br>`config` (URL profiling)<br>`config` (URL profiling)<br>`config` (URL profiling) | ⭐⭐ | Parse each URL and count schemes, network locations, paths, query strings and fragments separately. |
| Path components | Common path prefix<br>Path frequencies without extension<br>Extension frequencies<br>Basename frequencies<br>Parent directory frequencies<br>Drive prefix frequencies | `path_common_prefix`<br>`path_stem_counts`<br>`path_suffix_counts`<br>`path_basename_counts`<br>`path_parent_counts`<br>`path_drive_counts` | `config` (path profiling)<br>`config` (path profiling)<br>`config` (path profiling)<br>`config` (path profiling)<br>`config` (path profiling)<br>`config` (path profiling) | ⭐⭐ | Find the shared string prefix and count paths without extensions, extensions, basenames, parent directories and drive prefixes. |
| Path component cardinality | Distinct paths without extension<br>Distinct extensions<br>Distinct basenames<br>Distinct parent directories<br>Distinct drive prefixes | `path_stem_distinct_count`<br>`path_suffix_distinct_count`<br>`path_basename_distinct_count`<br>`path_parent_distinct_count`<br>`path_drive_distinct_count` | `config` (path profiling)<br>`config` (path profiling)<br>`config` (path profiling)<br>`config` (path profiling)<br>`config` (path profiling) | ⭐⭐ | Count distinct values for each path component. |
| File sizes | File size in bytes<br>File size histogram | `file_size_bytes`<br>`file_size_histogram` | `config` (file metadata)<br>`config` (file metadata) | ⭐⭐ | Read each file's size in bytes and bin the sizes into a histogram. |
| File timestamps | Modification time frequencies<br>Access time frequencies<br>Metadata change time frequencies | `file_modified_time_counts`<br>`file_access_time_counts`<br>`file_metadata_change_time_counts` | `config` (file metadata)<br>`config` (file metadata)<br>`config` (file metadata) | ⭐ | Summarize the frequencies of modification, access and metadata change timestamps from file metadata. |
| Image integrity and dimensions | Truncated image count<br>Image dimension frequencies | `truncated_image_count`<br>`image_dimension_counts` | `config` (image profiling)<br>`config` (image profiling) | ⭐ | Count images that open but fail to load. Group successfully loaded images by width and height. |
| Image dimensions and area | Minimum image width<br>Maximum image width<br>Mean image width<br>Median image width<br>Minimum image height<br>Maximum image height<br>Mean image height<br>Median image height<br>Minimum image area<br>Maximum image area<br>Mean image area<br>Median image area | `min_image_width`<br>`max_image_width`<br>`mean_image_width`<br>`median_image_width`<br>`min_image_height`<br>`max_image_height`<br>`mean_image_height`<br>`median_image_height`<br>`min_image_area`<br>`max_image_area`<br>`mean_image_area`<br>`median_image_area` | `config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling)<br>`config` (image profiling) | ⭐ | Calculate the minimum, maximum, mean and median of widths, heights and pixel areas. |
| Image EXIF | EXIF tag frequencies<br>EXIF value frequencies by tag | `exif_tag_counts`<br>`exif_value_counts` | `config` (EXIF metadata)<br>`config` (EXIF metadata) | ⭐ | Count how often each EXIF tag appears and the frequency of each value within a tag. |
| Time index | Time series count<br>Time index observation count<br>Time index start<br>Time index end<br>Average index step | `time_series_count`<br>`time_index_observation_count`<br>`time_index_start`<br>`time_index_end`<br>`mean_time_index_step` | `config` (time series)<br>`config` (time series)<br>`config` (time series)<br>`config` (time series)<br>`config` (time series) | ⭐⭐⭐ | Count time series and observations, find the minimum and maximum index, and take the mean absolute step between adjacent index values. |
| Stationarity and seasonality | ADF p-value<br>Stationarity<br>Seasonality | `adf_p_value`<br>`is_stationary`<br>`is_seasonal` | `config` (time series)<br>`config` (time series)<br>`config` (time series) | ⭐⭐ | Test for stationarity with ADF and detect periodic peaks in the frequency spectrum. The stationarity flag also takes seasonality into account. |
| Time gaps | Gap count<br>Gap endpoints<br>Minimum gap length<br>Maximum gap length<br>Mean gap length<br>Sample standard deviation of gap lengths | `gap_count`<br>`gap_endpoints`<br>`min_gap`<br>`max_gap`<br>`mean_gap`<br>`stddev_gap_samp` | `config` (time series)<br>`config` (time series)<br>`config` (time series)<br>`config` (time series)<br>`config` (time series)<br>`config` (time series) | ⭐⭐⭐⭐ | Locate gaps from successive index intervals after dropping missing observations. Summarize gap lengths with their minimum, maximum, mean and sample standard deviation. |
| Autocorrelation | Autocorrelation<br>Partial autocorrelation | `acf`<br>`pacf` | `config` (time series)<br>`config` (time series) | ⭐⭐ | Calculate ACF and PACF coefficients and confidence intervals at each lag. |

</details>
