**English** | [简体中文](./README.zh-CN.md)

# AVA Data Profiling

AVA Data Profiling computes dataset statistics in DuckDB SQL. Start with row counts, column types, and basic aggregates. Request frequencies, distributions, or pairwise statistics when an analysis needs more detail. Derived metrics reuse those results.

The project is inspired by the one-call exploratory data analysis workflow in [`fg-data-profiling`](https://github.com/Data-Centric-AI-Community/fg-data-profiling).

> [!NOTE]
> This README describes a proposed SQL API and implementation plan.

## Usage

Pass a table or view name to `ava_profile()`. Use a view to profile a file, filtered data, or a join.

```sql
CREATE TEMP VIEW orders AS
SELECT * FROM read_parquet('orders.parquet');

SELECT * FROM ava_profile('orders');
```

Select columns or request extra statistics. Exact frequency summaries and quantile precision are independent options.

```sql
SELECT *
FROM ava_profile(
    'orders',
    columns := ['amount', 'channel'],
    options := '{"frequency_summary":true,"quantiles":[0.25,0.5,0.75],"quantile_method":"continuous"}'
);
```

Choose an analysis when you need its detail rows. This example returns a frequency table for one column.

```sql
SELECT *
FROM ava_profile(
    'orders',
    analysis := 'frequencies',
    columns := ['channel'],
    options := '{"order":"frequency_desc","limit":5}'
);
```

## Metric catalog

**Default** runs with `ava_profile(source)`. **On demand** is planned for the first release through a selected analysis or option. **Later** covers capabilities planned for a subsequent release.

Read the catalog from basic counts and aggregates through frequencies, distributions, pairs, and ordered observations. The last entries cover comparisons and states derived from those results.

| Scope | Metric | Inputs and definition | What it supports | Analysis | Stage |
| --- | --- | --- | --- | --- | --- |
| **Schema** | `column_name`, `column_type`, `column_position`, `logical_type` | Read the bound DuckDB schema and map native types to profiling types. | Field selection and type-aware aggregation. | `summary` | Default |
| Schema | `column_count`, `profiled_column_count`, `column_type_counts` | Count all columns, selected columns, and selected columns by type. | Table width, type distribution, and the denominator for table-wide missingness. | `summary` | Default |
| **Rows and cells** | `row_count` | Count all rows in the input table or view. | Ratio denominators, empty input detection, and batch volume. | `summary` | Default |
| Rows and cells | `cell_count` | Multiply row count by the number of selected columns. | The denominator for cell-level rates. | `summary` | Default |
| **Missing values** | `null_count`, `nan_count` | Count SQL NULL and floating-point NaN separately. | Separate SQL nulls from non-numeric floating-point values. | `summary` | Default |
| Missing values | `missing_count`, `present_count` | Add NULL and NaN counts for missing count. Subtract it from row count for present count. | Denominators for missingness and value frequencies. | `summary` | Default |
| Missing values | `null_rate`, `missing_rate`, `present_rate` | Divide the respective count by row count. | Compare columns, groups, and batches. | `summary` | Default |
| Missing values | `missing_cell_count`, `missing_cell_rate` | Add missing counts across selected columns and divide by cell count for the rate. | Table-wide missingness. | `summary` | Default |
| Missing values | `rows_with_missing_count`, `complete_row_count` | Count each row once if any selected field is missing. Subtract from row count for the complete-row count. | Complete-case sample size. | `summary` (`row_completeness`) | On demand |
| Missing values | `sentinel_count`, `sentinel_rate` | Count caller-specified placeholder values, such as N/A or -999, and divide by row count for the rate. | Measure the impact of placeholder encodings. | `summary` (`sentinels`) | On demand |
| **Special numeric values** | `positive_infinity_count`, `negative_infinity_count`, `infinity_count`, `infinity_rate` | Count both signs separately and add their counts. Divide by row count for the rate. | Infinity counts and their share of all rows. | `summary` | Default |
| Special numeric values | `finite_count`, `finite_rate` | Subtract infinities from the numeric present count. Divide by row count for the rate. | Coverage for numeric summaries and distributions. | `summary` | Default |
| **Numeric aggregates** | `min`, `max`, `range` | Find finite min and max. Subtract min from max for the range. | Value bounds, span, and constant finite values. | `summary` | Default |
| Numeric aggregates | `sum`, `mean` | Use DuckDB SUM and AVG over the same finite values. | Totals, central tendency, and weighted recombination of batch means using finite counts. | `summary` | Default |
| Numeric aggregates | `variance_samp`, `stddev_samp`, `cv` | Use sample variance and take its square root for standard deviation. CV is sample standard deviation divided by the mean. | Absolute spread and relative spread on scales with a meaningful zero. | `summary` | Default |
| Numeric aggregates | `zero_count`, `negative_count`, `positive_count`, `zero_rate`, `negative_rate`, `positive_rate` | Use conditional counts over finite values. Divide by the finite count for the rates. | Zero concentration, sign distribution, and range-check evidence. | `summary` | Default |
| Numeric aggregates | `skewness`, `excess_kurtosis` | Use DuckDB moment aggregates over finite values and report the valid count. | Asymmetry and tail characteristics. | `summary` (`moments`) | On demand |
| **Boolean values** | `true_count`, `false_count`, `true_rate`, `false_rate` | Count true and false. Use present count as the denominator. | Boolean distribution and binary label proportions. | `summary` | Default |
| **Text length** | `empty_count`, `blank_count` | Count empty strings and nonempty whitespace-only strings separately. | Identify empty and blank text independently of NULL. | `summary` | Default |
| Text length | `min_length`, `max_length`, `mean_length` | Apply numeric aggregations to character lengths, including zero-length strings. | Length bounds and constant-length checks. | `summary` | Default |
| **Dates and timestamps** | `min_timestamp`, `max_timestamp`, `time_span` | Find the earliest and latest valid, finite dates or timestamps and compute their span. | Observation coverage and batch time bounds. | `summary` | Default |
| **Value frequencies** | `approx_distinct_count` | Apply DuckDB’s approximate distinct-count aggregate to non-missing values and label the estimate. | Quick cardinality estimates for high-cardinality columns. | `summary` (`approx_distinct`) | On demand |
| Value frequencies | `value_counts` | Group non-missing values and count each group exactly. | Shared input for exact cardinality, singletons, mode, and most or least frequent values. | `frequencies` | On demand |
| Value frequencies | `distinct_count`, `distinct_rate` | Count distinct value groups and divide by present count for the rate. | Category scale and candidate-key checks. | `summary` (`frequency_summary`) | On demand |
| Value frequencies | `singleton_count`, `singleton_rate` | Count groups with frequency one. Divide by present count for the rate. | The share of observations whose value occurs only once. | `summary` (`frequency_summary`) | On demand |
| Value frequencies | `is_unique`, `is_constant` | Require at least one non-missing value. Uniqueness compares exact distinct count with present count. Constancy checks for one distinct value. | Column uniqueness and constancy among non-missing values. | `summary` (`frequency_summary`) | On demand |
| Value frequencies | `value_rate`, `top_values`, `bottom_values` | Divide each frequency by the count of included values. Sort by count with a deterministic tie order. | Category shares, Top-K coverage, and low-frequency values. | `frequencies` (`order`, `limit`) | On demand |
| Value frequencies | `mode`, `mode_count`, `mode_rate` | Reuse the most frequent value and its count and share. Break ties using the same value order as the frequency table. | Dominant value and concentration. | `summary` (`frequency_summary`) | On demand |
| Value frequencies | `low_values`, `high_values` | Sort finite numeric value groups by value to inspect either end, with exact counts. | Distinguish isolated extreme values from frequently repeated endpoints. | `frequencies` (`order`, `finite_only`) | On demand |
| Value frequencies | `rare_value_count`, `rare_row_rate` | Use a declared rarity threshold to count qualifying values and the share of rows they cover. | Measure category rarity and how much data it affects. | `summary` (`category_stats`) | Later |
| Value frequencies | `category_imbalance`, `category_uniformity` | Evaluate concentration or uniformity with a selected method using the frequency table. | Label and category distribution checks. | `summary` (`category_stats`) | Later |
| Value frequencies | `normalized_value_counts`, `variant_groups` | Group values after explicit normalization and retain the original-to-normalized mapping and counts. | Find case, whitespace, formatting, and potential spelling variants. | `frequencies` (`normalize`, `output`) | Later |
| **Numeric distributions** | `quantiles` | Evaluate requested quantiles on finite values and record the exact continuous, exact discrete, or approximate method. | Median, quartiles, and tail percentiles. | `summary` (`quantiles`, `quantile_method`) | On demand |
| Numeric distributions | `median`, `iqr` | Take P50 for the median and subtract P25 from P75 for IQR when both are requested. | Robust location and spread, and IQR fences. | `summary` (`quantiles`) | On demand |
| Numeric distributions | `histogram` | Count finite values by bin. Retain bin edges, the endpoint convention, and out-of-range counts. | Histograms, bin shares, shape, and comparisons on shared bins. | `histogram` (`bins`, `bin_edges`) | On demand |
| Numeric distributions | `below_threshold_count`, `above_threshold_count` | Count original finite values below or above caller-supplied bounds, which can be computed from a previous profile. | Actual tail counts, range violations, and counts outside IQR fences. | `summary` (`bounds`) | On demand |
| Numeric distributions | `mad` | Take the median of absolute deviations from the median. | Robust spread and MAD-based outlier candidates. | `summary` (`numeric_details`) | Later |
| Numeric distributions | `uniformity_statistic`, `uniformity_p_value` | Evaluate against a defined expected distribution and bins, with the sample size and test method. | Evidence for a given uniformity hypothesis. | `summary` (`numeric_details`) | Later |
| **Group counts** | `group_counts` | Group by selected columns or all columns and count the rows in each group exactly. | Key combinations, duplicate groups, and duplicate row counts. | `duplicates` (`output=groups`) | On demand |
| Group counts | `key_missing_rows` | Count rows where any selected key component is missing. | Candidate-key completeness alongside exact uniqueness. | `duplicates` | On demand |
| Group counts | `duplicate_group_count`, `rows_in_duplicate_groups`, `duplicate_rows`, `duplicate_rate` | For each group with size g greater than one, count the group and sum g and g minus one. Divide excess rows by grouped rows for the rate. | Distinguish all rows in repeated groups from rows beyond the first. | `duplicates` | On demand |
| Group counts | `near_duplicate_groups`, `near_duplicate_rows` | Construct candidate groups with selected fields, similarity method, and threshold. | Locate similar records that differ in some values. | `near_duplicates` | Later |
| **Missingness pairs** | `missing_pair_counts` | Count n00, n01, n10, and n11 for each requested pair. The first digit refers to the left column and 1 means missing. | Marginal counts and the joint missingness pattern. | `missingness` | On demand |
| Missingness pairs | `co_missing_count`, `co_missing_rate` | Use n11 for the count and divide by the number of rows examined for the rate. | The number and share of rows missing both values. | `missingness` | On demand |
| Missingness pairs | `conditional_missing_rate`, `missingness_correlation` | Divide by the relevant marginal missing count. Left given right missing is n11 / (n01 + n11). Correlate the binary missingness indicators. | How often missing values occur together relative to each column’s overall missingness. | `missingness` | On demand |
| Missingness pairs | `missing_row_patterns`, `sample_missing_mask` | Group by missingness patterns across selected columns, or return the cell mask for an explicitly bounded sample. | Common missingness patterns and missingness matrices. | `missingness` (`output=patterns`, `output=mask`) | Later |
| **Numeric pairs** | `pair_valid_count`, `pair_coverage` | Count rows with finite values in both selected columns and divide by input row count for coverage. | Sample support for covariance and correlation. | `correlations` | On demand |
| Numeric pairs | `covariance_samp`, `pearson_r` | Compute sample covariance and Pearson correlation over the same finite pairs. Pearson is undefined with too few pairs or a constant input. | Linear association and pair-level comparisons. | `correlations` | On demand |
| **Column relationships** | `spearman_rho`, `kendall_tau` | Compute rank association on shared valid observations, with a defined tie convention. | Rank and monotonic association. | `correlations` (`method`) | Later |
| Column relationships | `joint_value_counts`, `cramers_v` | Count joint value groups and compute Cramér’s V from the contingency table. Bin numeric values explicitly for mixed pairs. | Categorical and mixed-type association. | `correlations` (`method`, `output=joint_counts`) | Later |
| Column relationships | `phi_k`, `association_method` | Compute Phi-K from a joint distribution with a documented method. For automatic selection, record the method used for each pair. | Comparable, interpretable association matrices. | `correlations` (`method`) | Later |
| Column relationships | `joint_histogram`, `paired_sample` | Count joint bins or return an explicitly bounded sample of valid pairs. | Joint distributions, scatter plots, and variable interactions. | `interactions` (`output`) | Later |
| **Ordered observations** | `adjacent_step_counts`, `monotonicity` | Use an explicit sort key and tie order to count increases, decreases, and ties between consecutive values. | Strict and non-strict monotonicity. | `sequence` (`output=steps`) | Later |
| Ordered observations | `time_step_distribution`, `gap_count`, `max_gap` | Measure adjacent timestamp differences and detect gaps relative to a declared expected interval. | Time-index coverage and missing observation intervals. | `sequence` (`output=gaps`) | Later |
| Ordered observations | `lag_pair_count`, `acf`, `pacf` | Compute lag statistics for a defined series and lag set, recording coverage, missing-value handling, and method. | Lag relationships, candidate periods, and data for time-series plots. | `sequence` (`output=lags`) | Later |
| Ordered observations | `stationarity_statistic`, `stationarity_p_value`, `seasonality` | Use an explicit method and parameters, such as ADF for stationarity and a defined periodicity test. | Stationarity and seasonality signals. | `sequence` (`output=tests`) | Later |
| **Type and format inference** | `inferred_type`, `type_match_count`, `type_match_rate` | Apply explicit type tests with tested and matched counts, and allow type overrides. | Numeric categories, date-like or boolean-like text, free text, URLs, paths, files, and images. | `summary` (`infer_types`) | Later |
| Type and format inference | `parse_success_count`, `parse_failure_count`, `parse_failure_rate` | Attempt parsing with a defined target type, format, and time zone where relevant. Retain the attempted count. | Format consistency and invalid date, numeric, or boolean text. | `summary` (`parse`) | Later |
| **Date distributions** | `time_bucket_counts` | Group timestamps with declared interval, boundary, and time zone. | Date and timestamp histograms and per-period volume. | `histogram` (`time_unit`, `time_zone`) | Later |
| **Text distributions** | `median_length`, `length_histogram` | Apply numeric quantile and histogram logic to string length. | Text length distribution. | `text` (`output=lengths`) | Later |
| Text distributions | `word_counts`, `character_counts` | Extract words or characters, apply the declared case and stop-word rules where applicable, then count frequencies. | Word and character distributions. | `text` (`output=words`, `output=characters`) | Later |
| Text distributions | `unicode_category_counts`, `unicode_script_counts`, `unicode_block_counts` | Map characters to Unicode categories, scripts, or blocks and aggregate counts. | Writing systems and character patterns. | `text` (`output=unicode`) | Later |
| **Source metadata** | `storage_bytes`, `column_storage_bytes`, `bytes_per_row` | Read available source storage metadata and document the measure, such as compressed physical bytes. | Table and column storage footprint. | `summary` (`storage`) | Later |
| Source metadata | `url_component_counts`, `path_component_counts` | Parse components into columns and reuse value-frequency calculations. | Schemes, hosts, directories, filenames, and extensions. | `text` (`output=url_components`, `output=path_components`) | Later |
| Source metadata | `file_size_distribution`, `file_timestamp_range` | Aggregate SQL-visible file sizes and creation or modification timestamps. | File size and timestamp profiles. | `file_metadata` (`kind=file`) | Later |
| Source metadata | `image_dimension_distribution`, `truncated_image_count`, `exif_counts` | Aggregate dimensions, truncation indicators, and selected EXIF fields from a SQL-visible metadata relation. | Image dimensions and metadata coverage. | `file_metadata` (`kind=image`) | Later |
| **Profile metadata** | `profile_scope`, `method`, `is_approximate` | Record the source, selected columns, applicable population, computation method, and approximation status. | Reproducible interpretation and comparisons between compatible results. | `summary` | Default |
| **Profile comparison** | `metric_delta`, `category_delta`, `bin_delta` | Align compatible profile results, then compare values, categories, and counts on shared bin edges. | Volume and missingness changes, new or removed categories, and distribution shifts. | `comparison` (`baseline`, `result_kind`) | Later |
| **Derived states** | `is_empty`, `is_all_missing`, `is_constant_length` | Derive from row count, present count, and length bounds. All-missing requires rows to examine, and constant length requires at least one observed string. | Exact states available from the default profile. | `summary` | Default |
| **Derived checks** | `check_result` | Compare a saved metric with a supplied threshold or reference value. Carry through the scope and denominator when present. | Evidence for high missingness, high cardinality, skewness, high correlation, and duplicates. | `checks` (`rules`) | On demand |

### Counting and precision

- **Counts and rates.** Row count covers the input relation. Table-wide missingness uses the selected columns. Missing values include SQL `NULL` and floating-point `NaN`. Infinity has separate counts and remains a non-missing value. Ratios range from 0 to 1 and return `NULL` when the denominator is zero.
- **Numeric coverage.** Numeric aggregates, histograms, and numeric correlations use finite values. Sample variance and covariance require at least two observations. CV returns `NULL` when the mean is zero.
- **Frequency and duplicate counts.** Frequency summaries use non-missing values. Duplicate grouping follows DuckDB equality and grouping semantics, including grouping equal null-key tuples together. Candidate keys require both completeness and uniqueness.
- **Precision and scope.** Record the method and flag an estimate or a metric derived from an estimate. Use exact counts for uniqueness. Combine group counts or compatible histogram bins across batches when available. Combining cardinalities or quantiles across batches requires the underlying data or compatible aggregate states.
- **Checks.** The library exposes metrics and exact states. The checks analysis applies caller-supplied rules to saved metrics.

## SQL API

`ava_profile(source, analysis := 'summary', columns := [], options := '{}')`

Each metric in the catalog has a primary analysis. The **Analysis** column names the mode and lists any additional options. Analyses can share calculations. For example, `summary` uses the same value frequencies as `frequencies` to derive exact cardinality and singletons, then returns one row per metric.

For raw-data analyses, `source` names the input table or view. For `checks` and `comparison`, it names a table or view holding previously computed results. File and image profiling takes a relation containing the metadata. The selected analysis, columns, and output options determine the result schema at bind time.

### First-release analyses

| Analysis | Input and options | Result |
| --- | --- | --- |
| `summary` | Raw table or view. An empty column list selects all columns. Optional settings include `row_completeness`, `moments`, `approx_distinct`, `frequency_summary`, `sentinels` by column, and numeric `bounds` by column. Set `quantiles` to a list of probabilities and `quantile_method` to `continuous` (default), `discrete`, or `approximate`. | One row per metric with `column_name`, `column_type`, `metric`, JSON `value`, `method`, and `is_approximate`. Table-level rows have a `NULL` column name and type. `frequency_summary` derives exact distinct and singleton counts and rates, uniqueness, constancy, and mode with its count and share. |
| `histogram` | One numeric column. Use `bins` to request a bin count or `bin_edges` to supply shared boundaries. | One row per bucket with `lower_bound`, `upper_bound`, `bucket_kind`, and `value_count`. Includes underflow and overflow buckets where applicable. |
| `frequencies` | One column. `order` accepts `frequency_desc`, `frequency_asc`, `value_asc`, or `value_desc`. `limit` defaults to 10. JSON `null` returns all values. Set `finite_only` for numeric extremes. | One row per returned value with native SQL `value`, exact `value_count`, and `value_rate` over included values. |
| `duplicates` | Raw table or view. Select key columns or leave the list empty to group by the whole row. `output` defaults to `summary`. Set it to `groups` for the grouped counts. | Summary output has `row_count`, `key_missing_rows`, `duplicate_group_count`, `rows_in_duplicate_groups`, `duplicate_rows`, and `duplicate_rate`. Group output returns `group_key` and `row_count` per group. |
| `missingness` | At least two selected columns. | One row per pair with `left_column`, `right_column`, `n00`, `n01`, `n10`, `n11`, `co_missing_count`, `co_missing_rate`, `left_missing_given_right`, `right_missing_given_left`, and `missingness_correlation`. |
| `correlations` | At least two numeric columns. The first release uses Pearson correlation. | One row per pair with `left_column`, `right_column`, `pair_valid_count`, `pair_coverage`, `covariance_samp`, and `pearson_r`. |
| `checks` | Saved metric rows with `column_name`, `metric`, and JSON `value`. Project details such as duplicate counts or pair correlations into that shape to check them. Pass `rules` with a rule ID, metric, column, comparison operator, and threshold for each rule. A reference value can serve as the threshold. | One row per rule and target with the observed value, expected value, and check status. Carry through any supplied scope and denominator. Missing or undefined results are marked unavailable. |

```sql
SELECT * FROM ava_profile(
    'orders', analysis := 'histogram', columns := ['amount'],
    options := '{"bins":12}'
);
SELECT * FROM ava_profile('orders', analysis := 'duplicates', columns := ['order_id']);
SELECT * FROM ava_profile('orders', analysis := 'missingness', columns := ['amount', 'channel']);
SELECT * FROM ava_profile('orders', analysis := 'correlations', columns := ['amount', 'quantity']);

SELECT column_name, value::DOUBLE AS missing_rate
FROM ava_profile('orders')
WHERE metric = 'missing_rate'
ORDER BY missing_rate DESC NULLS LAST;
```

```sql
CREATE TEMP VIEW order_metrics AS
SELECT * FROM ava_profile('orders', columns := ['amount']);

SELECT * FROM ava_profile(
    'order_metrics',
    analysis := 'checks',
    options := '{"rules":[{"id":"amount_missing","metric":"missing_rate","column":"amount","op":"lte","threshold":0.05}]}'
);
```

### Planned analyses and extensions

| Analysis | Input and options | Result |
| --- | --- | --- |
| `summary` | Extend the existing mode with `infer_types`, `parse`, and `storage` for type detection, parsing, and source sizes. Use `numeric_details` for MAD or a uniformity test with a stated expected distribution, and `category_stats` for rarity, imbalance, or category uniformity. | The summary schema, with additional scalar metrics and their computation methods. |
| `histogram` | Extend to a date or timestamp column using `time_unit` and, where applicable, `time_zone`. | One row per time bucket with its bounds and count. |
| `frequencies` | Extend `normalize` and `output` to group by normalized values or show which original labels contributed to a group. | One row per normalized value for frequencies, or one row per original-to-normalized mapping for variants. |
| `missingness` | Add `output` choices `patterns` and `mask`. Mask output requires a `sample_size` and explicit `order_by`. | One row per observed missingness pattern, or one row per sampled cell with its missingness flag. |
| `correlations` | Add `method` choices for Spearman, Kendall, Cramér’s V, Phi-K, and automatic selection. Mixed pairs use defined numeric bins. Request `output=joint_counts` to inspect the contingency table. | One row per pair with the chosen method and coefficient, or one row per joint value group. |
| `near_duplicates` | Raw relation with selected fields, a stable `row_id`, and a defined `method` and `threshold`. | Candidate group and member counts, with group membership available for follow-up. |
| `interactions` | Two selected columns. Choose joint bins or a bounded valid-pair sample with `output`. | One row per joint bin or sampled pair. |
| `sequence` | Selected series with an explicit `order_by` and tie order. Choose `output` as `steps`, `gaps`, `lags`, or `tests`, and provide the expected interval or lags when required. | Step and gap summaries, one row per lag for ACF/PACF, or one row per series and test for stationarity or seasonality. |
| `text` | Text columns and an `output` such as `lengths`, `words`, `characters`, `unicode`, `url_components`, or `path_components`. Specify tokenization or parsing rules when needed. | Length statistics or detail rows keyed by length bin, token, Unicode class, or component. |
| `file_metadata` | A table or view exposing the required file or image metadata. Use `kind` to select `file` or `image`. | Metrics and distributions for available fields such as size, timestamps, dimensions, truncation, and EXIF. |
| `comparison` | A saved current result relation and a named `baseline` relation of the same `result_kind`. Use compatible scopes, methods, value types, and bin boundaries. | One row per aligned metric, category, or bin with current and baseline values and the delta, when defined. |

## Reports and interaction

DuckDB computes the statistics and exposes them as query results. A client such as AVA can render and explore those results.

| Capability | Delivery |
| --- | --- |
| **SQL and structured export** | First release. Query, store, and export results to JSON or CSV with DuckDB. |
| **Reports and charts** | Later in the client. Render tables, distributions, missingness, correlations, and findings from the SQL results. |
| **Sample and duplicate previews** | Later in the client. Request bounded previews and control whether raw values appear. |
| **Dataset comparison** | Later in the client. Display comparable profiles side by side using comparison results computed in DuckDB. |
| **HTML and notebooks** | Later in the client. Add standalone HTML export and embeddable notebook views. |
| **Interactive exploration** | Later in the client. Request the relevant analysis as the user filters data or selects columns. |
| **Metadata and reproducibility** | Later in the client. Add descriptions, data dictionaries, report styling, and records of the input, settings, DuckDB version, and run time. |

## Implementation

Start with DuckDB SQL table macros. Resolve the input relation with `query_table()` and apply type-appropriate aggregates across the selected columns. Select the analysis before building its query, and construct SQL from known templates and validated inputs.

Combine compatible default aggregates. Compute a frequency table once per call when several metrics need it, and derive ratios or flags from existing counts. Run histogram, grouping, and pairwise queries only when requested. Advanced format analysis aggregates metadata made available as a DuckDB relation.

The table-macro routing pattern was verified on DuckDB 1.5.5. The proposed metrics, compatibility with reference statistics, and end-to-end performance still need validation.
