**English** | [简体中文](./README.zh-CN.md)

# Data Profiling

Data Profiling is a DuckDB SQL library for profiling tabular data, inspired by [fg-data-profiling](https://github.com/Data-Centric-AI-Community/fg-data-profiling). Its focus is on statistics you can query and reuse.

> [!NOTE]
> The library currently provides `row_count`, `column_count` and per-column `missing_count`. Column selection and all other metrics below are planned.

## Quick start

The library is pure SQL, distributed as an npm package for Node.js consumers such as AVA. It exports the SQL text and uses the consumer's existing DuckDB connection. It requires no Python environment and has no runtime npm dependencies.

For local integration, install this repository in the consuming project:

```sh
npm install /absolute/path/to/data_profiling
```

Use the connection that already contains the data:

```ts
import { dataProfilingSQL } from 'data_profiling';

await connection.run(dataProfilingSQL);
const result = await connection.runAndReadAll(
  'SELECT * FROM data_profiling(?)',
  ['orders']
);
console.log(result.getRowObjects());
// [
//   { column_name: null, metric: 'row_count', value: 3n },
//   { column_name: null, metric: 'column_count', value: 2n },
//   { column_name: 'amount', metric: 'missing_count', value: 1n },
//   { column_name: 'channel', metric: 'missing_count', value: 1n }
// ]
```

Load the macro when AVA initializes its DuckDB session, then call it during profiling. AVA remains responsible for adapting these rows to its existing `Profile` structure. Run the registration through AVA's internal connection initialization, since its public query API accepts only read-only `SELECT` statements.

`value` is a DuckDB `BIGINT`, represented as JavaScript `bigint` by [`@duckdb/node-api`](https://duckdb.org/docs/lts/clients/node_neo/overview). The consumer handles any conversion needed by its JSON contract.

## DuckDB CLI

From the repository root, open the DuckDB CLI and load the metric definitions before the public entry point. The macro uses DuckDB's built-in [`query_table`](https://duckdb.org/docs/stable/guides/sql_features/query_and_query_table_functions) function; no extension is needed.

```sql
.read sql/metrics/table.sql
.read sql/metrics/missingness.sql
.read sql/data_profiling.sql

CREATE TEMP TABLE orders AS
SELECT * FROM (VALUES (120, 'web'), (80, 'store'), (NULL, NULL)) AS t(amount, channel);

SELECT * FROM data_profiling('orders');
```

| column_name | metric | value |
| --- | --- | ---: |
| NULL | row_count | 3 |
| NULL | column_count | 2 |
| amount | missing_count | 1 |
| channel | missing_count | 1 |

The result contains `column_name` (`VARCHAR`, `NULL` for table metrics), `metric` (`VARCHAR`) and `value` (`BIGINT`). `row_count` counts every row, including duplicates and rows containing `NULL`; an empty table returns zero. `column_count` counts the columns exposed by the table or view, including when it is empty. It reads [`pragma_table_info`](https://duckdb.org/docs/current/configuration/pragmas#table-information) metadata without scanning column values. `missing_count` counts SQL `NULL` values in each column; empty inputs return zero for every column. Empty strings, zero and DuckDB `NaN` are not treated as `NULL`. Tables, views and schema-qualified names are supported. Missing tables raise DuckDB errors. Loading the SQL again replaces the macros in the current schema.

`.read` is a DuckDB CLI command. With another client, execute `dataProfilingSQL` or load the SQL files in the order above before calling the macro.

## Organization and performance

```text
sql/
  metrics/
    table.sql           # Table metrics, separated by comment blocks
    missingness.sql     # Column missingness metrics
  data_profiling.sql    # Public entry point and result assembly
index.cjs               # Loads metric definitions, then the entry point
tests/
  data-profiling.test.cjs # One core comparison with fg-data-profiling
  fixtures/core.json     # Shared input and generated reference values
  generate-reference.py # Refreshes the fixture, outside normal tests
```

Keep each category in one file and separate its metrics with comment blocks containing the metric ID and calculation rules. Add categories such as numeric, string and datetime when their first metrics are implemented.

Simple aggregate metrics are expression macros, without their own `FROM` clause. The public entry point computes row counts and missing counts for all columns in one aggregate, then reshapes the result. Column names are recovered after aggregation so that empty inputs still retain their names. DuckDB [expands macros into their expressions](https://duckdb.org/docs/2.0/sql/statements/create_macro), so splitting definitions across files does not require separate scans. The npm entry loads SQL files once per module load, before any profiling queries run.

As metrics are added, combine compatible aggregates in one query before reshaping the result. Frequency tables, exact quantiles, duplicate detection and pairwise correlations may need separate query stages or substantial state; a single scan is not a guarantee for every metric. Use [`EXPLAIN ANALYZE`](https://duckdb.org/docs/current/guides/meta/explain_analyze) and representative data to check scan counts, time and memory. No large-data performance benchmark has been run yet.

This is a foundation for the metric roadmap, rather than a complete execution architecture for every metric in the README. Before adding non-count metrics, the current `BIGINT` result needs a representation for decimal, timestamp and structured values. Pairwise metrics also need to identify both columns. File/image metadata and tests such as ADF require suitable extensions or execution adapters; they are not covered by the current SQL aggregates. Add those capabilities when their metrics are implemented, keeping the SQL entry point and category files as the integration boundaries.

## Development

Use Node.js 22.13 or later. From the repository root:

```sh
npm ci
npm test
npm pack
```

`index.cjs` exports the combined metric definitions and public entry point as `dataProfilingSQL`, with TypeScript declarations in `index.d.ts`. Tests use Node's built-in test runner and `@duckdb/node-api` 2.0.0-r.1, matching the current local AVA checkout. The driver is a development dependency only. `npm pack` creates a local installable archive; the package has not been published to npm.

The suite retains one core case: mixed numeric, text and Boolean columns, with partial missingness, an entirely missing column and a complete column. `tests/fixtures/core.json` stores the input and expected output generated by actually running [`fg-data-profiling`](https://pypi.org/project/fg-data-profiling/). Its reference metadata records the package version, options and field mappings (`table.n`, `table.n_var`, `variables.<column>.n_missing`). The Node test compares the full combined output against this fixture; it does not need Python.

To refresh the reference, install `fg-data-profiling==4.20.0` in a separate Python environment and run `python tests/generate-reference.py`. Review the fixture diff before accepting changed reference values. The shared case maps Python missing values to SQL `NULL`; it does not assert that DuckDB `NaN` has pandas missing-value semantics.

## Planned column selection

The following API is a design example and is not implemented:

```sql
SELECT * FROM data_profiling('orders', columns := ['amount', 'quantity']);
```

## Planned core metrics

The **Importance** rating reflects each group's value for general-purpose profiling. Five stars mark the core metrics. Four stars are for common follow-up analyses, three for context-specific statistics, two for specialized analysis, and one for narrow domain needs.

The tags describe the library's planned behavior for applicable input types. Only `row_count`, `column_count` and `missing_count` are implemented.

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
