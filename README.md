**English** | [简体中文](./README.zh-CN.md)

# AVA Data Profiling

AVA Data Profiling computes dataset statistics in DuckDB SQL. Start with row counts, column types, and basic aggregates. Request frequencies, distributions, or pairwise statistics when an analysis needs more detail. Derived metrics reuse those results.

The project is inspired by the one-call exploratory data analysis workflow in [`fg-data-profiling`](https://github.com/Data-Centric-AI-Community/fg-data-profiling).

> [!NOTE]
> This README describes a proposed SQL API and implementation plan.

## Usage

Pass a table or view name to the proposed `ava_profile()` function. A view can expose a file, filtered data, or a join.

```sql
CREATE TEMP VIEW orders AS
SELECT * FROM read_parquet('orders.parquet');

SELECT * FROM ava_profile('orders', columns := ['amount', 'channel']);
```

The proposed `ava_profile_counts()` function returns exact counts by key. Use one column for value frequencies, or select several columns to check a compound key.

```sql
SELECT group_key.channel AS channel, row_count
FROM ava_profile_counts('orders', ['channel'])
WHERE group_key.channel IS NOT NULL
ORDER BY row_count DESC, channel
LIMIT 5;
```

## Metric catalog

The ratings apply to a general-purpose DuckDB table profiling library. They reflect how often a result is useful and how many other metrics can reuse it. Importance is independent of execution cost and release stage.

| Rating | Meaning |
| --- | --- |
| ⭐⭐⭐⭐⭐ | Core statistics or information that multiple important metrics depend on |
| ⭐⭐⭐⭐ | Commonly useful, with clear uses for on-demand analysis |
| ⭐⭐⭐ | Useful in context or conveniently derived from other results |
| ⭐⭐ | Useful for a narrower but recurring task, with additional inputs or methods |
| ⭐ | Relevant mainly to a specialized extension |

The review covers **70 rows**. There are 18 five-star, 24 four-star, 15 three-star, 9 two-star, and 4 one-star rows. Ratings apply to each row as a group. The value column calls out differences within groups when they matter.

**Default** describes basic results planned for the first release. **On demand** covers opt-in library calls and DuckDB SQL recipes for that release. **Later** identifies capabilities that need more input, a separate method, or a decision on the result format. **Later (extension)** identifies the four one-star rows.

| Scope | Metric | Importance | Inputs and definition | Value | Calculation route | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| **Schema** | `column_name`, `column_type`, `column_position`, `logical_type` | ⭐⭐⭐⭐⭐ | Read the bound DuckDB schema and map native types to profiling types. | Defines which calculations apply and identifies the target field. | Summary | Default |
| Schema | `column_count`, `profiled_column_count`, `column_type_counts` | ⭐⭐⭐⭐ | Count all columns, selected columns, and selected columns by type. | Useful for table summaries and the missing-cell denominator. Derive it from the schema. | Summary | Default |
| **Rows and cells** | `row_count` | ⭐⭐⭐⭐⭐ | Count all rows in the input table or view. | Foundation for ratios, completeness, and batch comparisons. | Summary | Default |
| Rows and cells | `cell_count` | ⭐⭐⭐ | Multiply row count by the number of selected columns. | Useful for table-wide missingness and directly derived from two counts. | Summary | Default |
| **Missing values** | `null_count`, `nan_count` | ⭐⭐⭐⭐⭐ | Count SQL NULL and floating-point NaN separately. | Keep separate counts so callers can verify the missingness definition. | Summary | Default |
| Missing values | `missing_count`, `present_count` | ⭐⭐⭐⭐⭐ | Add NULL and NaN counts for missing count. Subtract it from row count for present count. | Missing counts and frequency denominators reuse these values. | Summary | Default |
| Missing values | `null_rate`, `missing_rate`, `present_rate` | ⭐⭐⭐⭐⭐ | Divide the respective count by row count. | Missing rate is a common result. All three rates reuse the same counts. | Summary | Default |
| Missing values | `missing_cell_count`, `missing_cell_rate` | ⭐⭐⭐ | Add missing counts across selected columns and divide by cell count for the rate. | Useful for an overview. A table-wide rate can hide problems in a key field. | Summary | Default |
| Missing values | `rows_with_missing_count`, `complete_row_count` | ⭐⭐⭐⭐ | Count each row once if any selected field is missing. Subtract from row count for the complete-row count. | Determines the usable row count for analyses that need all selected fields. | Conditional counts | On demand |
| Missing values | `sentinel_count`, `sentinel_rate` | ⭐⭐⭐ | Count caller-specified placeholder values, such as N/A or -999, and divide by row count for the rate. | Useful when the source has declared placeholder conventions. | Conditional counts | On demand |
| **Special numeric values** | `positive_infinity_count`, `negative_infinity_count`, `infinity_count`, `infinity_rate` | ⭐⭐⭐⭐ | Count both signs separately and add their counts. Divide by row count for the rate. | Explains non-finite results and smaller usable numeric samples. | Summary | Default |
| Special numeric values | `finite_count`, `finite_rate` | ⭐⭐⭐⭐⭐ | Subtract infinities from the numeric present count. Divide by row count for the rate. | Defines the population used by numeric aggregates and distributions. | Summary | Default |
| **Numeric aggregates** | `min`, `max`, `range` | ⭐⭐⭐⭐⭐ | Find finite min and max. Subtract min from max for the range. | Basic bounds for exploration. Range is derived from the two endpoints. | Summary | Default |
| Numeric aggregates | `sum`, `mean` | ⭐⭐⭐⭐⭐ | Use DuckDB SUM and AVG over the same finite values. | Common statistics. Sums and valid counts also support a combined mean across batches. | Summary | Default |
| Numeric aggregates | `variance_samp`, `stddev_samp`, `cv` | ⭐⭐⭐⭐ | Use sample variance and take its square root for standard deviation. CV is sample standard deviation divided by the mean. | Variance and standard deviation are broadly useful. CV is a narrower derived metric. | Summary | Default |
| Numeric aggregates | `zero_count`, `negative_count`, `positive_count`, `zero_rate`, `negative_rate`, `positive_rate` | ⭐⭐⭐⭐ | Use conditional counts over finite values. Divide by the finite count for the rates. | Describe sign distribution and give evidence for range checks. | Summary | Default |
| Numeric aggregates | `skewness`, `excess_kurtosis` | ⭐⭐ | Use DuckDB moment aggregates over finite values and report the valid count. | Useful for distribution analysis. Percentiles and histograms are often easier to interpret in routine checks. | Native aggregates | On demand |
| **Boolean values** | `true_count`, `false_count`, `true_rate`, `false_rate` | ⭐⭐⭐⭐ | Count true and false. Use present count as the denominator. | Direct description of boolean and binary label distributions. | Summary | Default |
| **Text length** | `empty_count`, `blank_count` | ⭐⭐⭐⭐ | Count empty strings and nonempty whitespace-only strings separately. | Common in imported text and spreadsheets. Distinguish blank values from SQL NULL. | Projection, then reuse | Default |
| Text length | `min_length`, `max_length`, `mean_length` | ⭐⭐⭐ | Apply numeric aggregations to character lengths, including zero-length strings. | Useful for truncation, encoding, and length constraints. | Summary | Default |
| **Dates and timestamps** | `min_timestamp`, `max_timestamp`, `time_span` | ⭐⭐⭐⭐⭐ | Find the earliest and latest valid, finite dates or timestamps and compute their span. | Shows whether the batch covers the intended time range. | Native aggregates | Default |
| **Value frequencies** | `approx_distinct_count` | ⭐⭐⭐⭐ | Apply DuckDB’s approximate distinct-count aggregate to non-missing values and label the estimate. | Fast cardinality estimate on wide or high-cardinality data. | Grouping | On demand |
| Value frequencies | `value_counts` | ⭐⭐⭐⭐⭐ | Group non-missing values and count each group exactly. | Shared input for exact cardinality, singletons, mode, and Top-K. | Grouping | On demand |
| Value frequencies | `distinct_count`, `distinct_rate` | ⭐⭐⭐⭐⭐ | Count distinct value groups and divide by present count for the rate. | Common input to category profiles and candidate-key checks. | Grouping | On demand |
| Value frequencies | `singleton_count`, `singleton_rate` | ⭐⭐⭐⭐ | Count groups with frequency one. Divide by present count for the rate. | Distinguishes values seen once from repeated categories. | Grouping | On demand |
| Value frequencies | `is_unique`, `is_constant` | ⭐⭐⭐⭐⭐ | Require at least one non-missing value. Uniqueness compares exact distinct count with present count. Constancy checks for one distinct value. | Supports key and constant-column checks. A candidate key also needs a missingness check. | Grouping | On demand |
| Value frequencies | `value_rate`, `top_values`, `bottom_values` | ⭐⭐⭐⭐ | Divide each frequency by the count of included values. Sort by count with a deterministic tie order. | Quickly shows dominant and infrequent values from the same frequencies. | Grouping | On demand |
| Value frequencies | `mode`, `mode_count`, `mode_rate` | ⭐⭐⭐ | Reuse the most frequent value and its count and share. Break ties using the same value order as the frequency table. | A convenient summary of the most frequent value and its share. | Grouping | On demand |
| Value frequencies | `low_values`, `high_values` | ⭐⭐⭐ | Sort finite numeric value groups by value to inspect either end, with exact counts. | Shows whether extremes occur once or repeat. | Grouping | On demand |
| Value frequencies | `rare_value_count`, `rare_row_rate` | ⭐⭐⭐ | Use a declared rarity threshold to count qualifying values and the share of rows they cover. | Useful for categorical fields with many values. Choose a threshold for the task. | Grouping | Later |
| Value frequencies | `category_imbalance`, `category_uniformity` | ⭐⭐⭐ | Evaluate concentration or uniformity with a selected method using the frequency table. | Imbalance is useful for labels. A uniformity test applies to a narrower set of distributions. | Grouping | Later |
| Value frequencies | `normalized_value_counts`, `variant_groups` | ⭐⭐⭐ | Group values after explicit normalization and retain the original-to-normalized mapping and counts. | Useful before cleaning when case, whitespace, and other normalization rules are known. | Projection, then reuse | Later |
| **Numeric distributions** | `quantiles` | ⭐⭐⭐⭐⭐ | Evaluate requested quantiles on finite values and record the exact continuous, exact discrete, or approximate method. | Describes the distribution beyond the mean and supplies quartiles and tail values. | Distribution | On demand |
| Numeric distributions | `median`, `iqr` | ⭐⭐⭐⭐ | Take P50 for the median and subtract P25 from P75 for IQR when both are requested. | Robust summaries directly derived from the requested quantiles. | Distribution | On demand |
| Numeric distributions | `histogram` | ⭐⭐⭐⭐ | Count finite values by bin. Retain bin edges, the endpoint convention, and out-of-range counts. | Shows shape and concentration, and supports comparisons when bin boundaries match. | Distribution | On demand |
| Numeric distributions | `below_threshold_count`, `above_threshold_count` | ⭐⭐⭐⭐ | Count original finite values below or above caller-supplied bounds, which can be computed from a previous profile. | An exact count makes the impact of a rule or tail threshold measurable. | Conditional counts | On demand |
| Numeric distributions | `mad` | ⭐⭐⭐ | Take the median of absolute deviations from the median. | A useful robust spread measure when IQR alone is insufficient. | Distribution | Later |
| Numeric distributions | `uniformity_statistic`, `uniformity_p_value` | ⭐ | Evaluate against a defined expected distribution and bins, with the sample size and test method. | Interpretable when there is a stated reason to expect a uniform distribution. | Specialized tests | Later (extension) |
| **Group counts** | `group_counts` | ⭐⭐⭐⭐⭐ | Group by selected columns or all columns and count the rows in each group exactly. | One grouped result supports frequencies and exact duplicate checks. | Grouping | On demand |
| Group counts | `key_missing_rows` | ⭐⭐⭐⭐⭐ | Count rows where any selected key component is missing. | Candidate-key validation needs completeness as well as uniqueness. | Conditional counts | On demand |
| Group counts | `duplicate_group_count`, `rows_in_duplicate_groups`, `duplicate_rows`, `duplicate_rate` | ⭐⭐⭐⭐⭐ | For each group with size g greater than one, count the group and sum g and g minus one. Divide excess rows by grouped rows for the rate. | Separates all affected rows from the rows removed by deduplication. | Grouping | On demand |
| Group counts | `near_duplicate_groups`, `near_duplicate_rows` | ⭐⭐ | Construct candidate groups with selected fields, similarity method, and threshold. | Useful for cleaning and entity matching, with a defined similarity and grouping rule. | Similarity | Later |
| **Missingness pairs** | `missing_pair_counts` | ⭐⭐⭐⭐ | Count n00, n01, n10, and n11 for each requested pair. The first digit refers to the left column and 1 means missing. | The four counts support marginal, joint, and conditional missingness. | Column pairs | On demand |
| Missingness pairs | `co_missing_count`, `co_missing_rate` | ⭐⭐⭐⭐ | Use n11 for the count and divide by the number of rows examined for the rate. | Makes shared missingness visible and derives directly from the four counts. | Column pairs | On demand |
| Missingness pairs | `conditional_missing_rate`, `missingness_correlation` | ⭐⭐⭐⭐ | Divide by the relevant marginal missing count. Left given right missing is n11 / (n01 + n11). Correlate the binary missingness indicators. | Conditional rates are easy to interpret. Correlation also gives a compact summary. | Column pairs | On demand |
| Missingness pairs | `missing_row_patterns`, `sample_missing_mask` | ⭐⭐⭐ | Group by missingness patterns across selected columns, or return the cell mask for an explicitly bounded sample. | Patterns help narrow the search. Cell-level samples mainly support inspection and rendering. | Grouping and row-level results | Later |
| **Numeric pairs** | `pair_valid_count`, `pair_coverage` | ⭐⭐⭐⭐ | Count rows with finite values in both selected columns and divide by input row count for coverage. | Shows how many rows support any pairwise statistic. | Column pairs | On demand |
| Numeric pairs | `covariance_samp`, `pearson_r` | ⭐⭐⭐⭐ | Compute sample covariance and Pearson correlation over the same finite pairs. Pearson is undefined with too few pairs or a constant input. | Common linear relationship measures, best interpreted with valid pair counts. | Column pairs | On demand |
| **Column relationships** | `spearman_rho`, `kendall_tau` | ⭐⭐⭐ | Compute rank association on shared valid observations, with a defined tie convention. | Useful for ordered relationships, with explicit handling of ties and missing pairs. | Column pairs | Later |
| Column relationships | `joint_value_counts`, `cramers_v` | ⭐⭐⭐⭐ | Count joint value groups and compute Cramér’s V from the contingency table. Bin numeric values explicitly for mixed pairs. | Joint counts are reusable. Cramér’s V is one statistic derived from them. | Column pairs | Later |
| Column relationships | `phi_k`, `association_method` | ⭐⭐ | Compute Phi-K from a joint distribution with a documented method. For automatic selection, record the method used for each pair. | Phi-K is specialized. Record the actual method for every association result. | Column pairs | Later |
| Column relationships | `joint_histogram`, `paired_sample` | ⭐⭐⭐ | Count joint bins or return an explicitly bounded sample of valid pairs. | Helps explain relationships. Samples are useful for drill-down and visualization. | Column pairs | Later |
| **Ordered observations** | `adjacent_step_counts`, `monotonicity` | ⭐⭐ | Use an explicit sort key and tie order to count increases, decreases, and ties between consecutive values. | Useful when row order matters and a stable ordering key exists. | Ordered observations | Later |
| Ordered observations | `time_step_distribution`, `gap_count`, `max_gap` | ⭐⭐⭐⭐ | Measure adjacent timestamp differences and detect gaps relative to a declared expected interval. | Practical when checking whether expected time intervals have observations. | Ordered observations | Later |
| Ordered observations | `lag_pair_count`, `acf`, `pacf` | ⭐⭐ | Compute lag statistics for a defined series and lag set, recording coverage, missing-value handling, and method. | Useful in time-series modeling and narrower in general profiling. | Ordered observations | Later |
| Ordered observations | `stationarity_statistic`, `stationarity_p_value`, `seasonality` | ⭐ | Use an explicit method and parameters, such as ADF for stationarity and a defined periodicity test. | Depends on specific algorithms and assumptions about the series. | Specialized tests | Later (extension) |
| **Type and format inference** | `inferred_type`, `type_match_count`, `type_match_rate` | ⭐⭐⭐⭐ | Apply explicit type tests with tested and matched counts, and allow type overrides. | Useful for CSV and spreadsheet data with weak type information. Match rates make the inference auditable. | Projection, then reuse | Later |
| Type and format inference | `parse_success_count`, `parse_failure_count`, `parse_failure_rate` | ⭐⭐⭐⭐ | Attempt parsing with a defined target type, format, and time zone where relevant. Retain the attempted count. | Direct evidence for format validity and type inference. | Projection, then reuse | Later |
| **Date distributions** | `time_bucket_counts` | ⭐⭐⭐⭐ | Group timestamps with declared interval, boundary, and time zone. | Useful for time coverage, batch volume, and time distributions. | Distribution | Later |
| **Text distributions** | `median_length`, `length_histogram` | ⭐⭐⭐ | Apply numeric quantile and histogram logic to string length. | Shows truncation, padding, and mixed formats using numeric distributions of text lengths. | Projection, then reuse | Later |
| Text distributions | `word_counts`, `character_counts` | ⭐⭐ | Extract words or characters, apply the declared case and stop-word rules where applicable, then count frequencies. | Useful for free text. Tokenization quality depends on language and rules. | Projection, then reuse | Later |
| Text distributions | `unicode_category_counts`, `unicode_script_counts`, `unicode_block_counts` | ⭐⭐ | Map characters to Unicode categories, scripts, or blocks and aggregate counts. | Useful for control characters, multilingual data, and mixed writing systems. | Projection, then reuse | Later |
| **Source metadata** | `storage_bytes`, `column_storage_bytes`, `bytes_per_row` | ⭐⭐ | Read available source storage metadata and document the measure, such as compressed physical bytes. | Source-specific metadata with different physical measurement conventions. | Source metadata | Later |
| Source metadata | `url_component_counts`, `path_component_counts` | ⭐⭐ | Parse components into columns and reuse value-frequency calculations. | Useful for log, link, and path columns after parsing. | Projection, then reuse | Later |
| Source metadata | `file_size_distribution`, `file_timestamp_range` | ⭐ | Aggregate SQL-visible file sizes and creation or modification timestamps. | Useful for file catalogs when file metadata is already available to SQL. | Source metadata | Later (extension) |
| Source metadata | `image_dimension_distribution`, `truncated_image_count`, `exif_counts` | ⭐ | Aggregate dimensions, truncation indicators, and selected EXIF fields from a SQL-visible metadata relation. | Useful for image catalogs after image metadata has been extracted. | Source metadata | Later (extension) |
| **Profile metadata** | `profile_scope`, `method`, `is_approximate` | ⭐⭐⭐⭐⭐ | Record the source, selected columns, applicable population, computation method, and approximation status. | Required to compare results and to distinguish estimates from exact counts. | Result metadata | Default |
| **Profile comparison** | `metric_delta`, `category_delta`, `bin_delta` | ⭐⭐⭐⭐⭐ | Align compatible profile results, then compare values, categories, and counts on shared bin edges. | High value for comparable batch profiles and early change checks. | Profile comparison | Later |
| **Derived states** | `is_empty`, `is_all_missing`, `is_constant_length` | ⭐⭐⭐⭐ | Derive from row count, present count, and length bounds. All-missing requires rows to examine, and constant length requires at least one observed string. | Convenient exact states that reuse existing counts and bounds. | Summary | Default |
| **Derived checks** | `check_result` | ⭐⭐⭐ | Compare a saved metric with a supplied threshold or reference value. Carry through the scope and denominator when present. | Useful as a caller-supplied rule. SQL comparisons can express the check. | Profile comparison | On demand |

### Counting and precision

- **Counts and rates.** Row count covers the input relation. Table-wide missingness uses the selected columns. Missing values include SQL `NULL` and floating-point `NaN`. Infinity has separate counts and remains a non-missing value. Ratios range from 0 to 1 and return `NULL` when the denominator is zero.
- **Numeric coverage.** Numeric aggregates, histograms, and numeric correlations use finite values. Sample variance and covariance require at least two observations. CV returns `NULL` when the mean is zero.
- **Frequency and duplicate counts.** Frequency summaries use non-missing values. Duplicate grouping follows DuckDB equality and grouping semantics, including grouping equal null-key tuples together. Candidate keys require both completeness and uniqueness.
- **Precision and scope.** Record the method and flag an estimate or a metric derived from an estimate. Use exact counts for uniqueness. Combine group counts or compatible histogram bins across batches when available. Combining cardinalities or quantiles across batches requires the underlying data or compatible aggregate states.
- **Checks.** Callers can compare reported metrics with explicit thresholds or baselines in SQL.

## SQL API

The first release proposes two table functions. Both take a DuckDB table or view name, and both have fixed top-level result columns.

| Proposed function | Result | Coverage |
| --- | --- | --- |
| `ava_profile(source, columns := [])` | One row per table or column metric with `column_name`, `column_type`, `metric`, JSON `value`, `method`, and `is_approximate`. A table-level row has a `NULL` column name and type. The `profile_scope` metric records the source and selected columns. An empty column list profiles all columns. | Schema, row counts, missingness, basic numeric statistics, booleans, text lengths, time ranges, and states and rates derived from them. |
| `ava_profile_counts(source, columns)` | One row per exact group with a named, typed `group_key` struct and `row_count`. Pass an empty list to group by the entire row. | Value frequencies, jointly observed categories, candidate keys, and exact duplicate analysis. Keys containing `NULL` follow DuckDB grouping rules. |

One frequency computation can supply distinct and singleton counts and the denominator for shares.

```sql
WITH channel_counts AS (
    SELECT row_count
    FROM ava_profile_counts('orders', ['channel'])
    WHERE group_key.channel IS NOT NULL
)
SELECT
    COUNT(*) AS distinct_count,
    COUNT(*) FILTER (WHERE row_count = 1) AS singleton_count,
    COALESCE(SUM(row_count), 0) AS present_count
FROM channel_counts;
```

The same grouped result can count duplicate groups, all rows in those groups, and rows beyond the first in each group. To validate a candidate key, also count rows with missing key components.

```sql
SELECT
    COUNT(*) AS duplicate_group_count,
    COALESCE(SUM(row_count), 0) AS rows_in_duplicate_groups,
    COALESCE(SUM(row_count - 1), 0) AS duplicate_rows
FROM ava_profile_counts('orders', ['order_id'])
WHERE row_count > 1;
```

### How the catalog is covered

Each catalog row has a calculation route. Derived metrics reuse the cheapest compatible result. Routes for later work identify the required inputs and the expected result grain.

| Calculation route | Input and result | How to access it |
| --- | --- | --- |
| **Summary and result metadata** | A named relation yields one row per table or column metric, with its scope, method, and precision. | Use `ava_profile()` and derive summary ratios and states using the reported counts. |
| **Grouping** | Selected key columns yield exact counts per key. One key gives frequencies, several keys give combinations or joint frequencies, and the full row gives exact duplicate groups. | Use `ava_profile_counts()` and derive exact cardinality, singletons, mode, shares, extremes, and duplicate metrics in SQL. |
| **Conditional counts and native aggregates** | A filter, value rule, or specific aggregate yields one scalar per requested scope. | Use `COUNT(*) FILTER (WHERE ...)` for completeness, sentinels, and bounds. Use native aggregates for approximate cardinality and higher moments. |
| **Distribution** | Finite values and requested probabilities or shared bin boundaries yield quantile values or bin counts. | Use `quantile_cont()`, `quantile_disc()`, `approx_quantile()` or `histogram()`. Derive the median and IQR from the requested quantiles. |
| **Column pairs and row-level results** | Selected fields share the same input rows. Results are counts or coefficients per pair, joint bins, or a bounded set of rows. | Use conditional counts for the four missingness cases and `corr()` or `covar_samp()` over the same finite pairs. Use exact grouping for joint frequencies. Measures derived from the contingency table follow the stages in the catalog. Rank methods, Phi-K, joint bins, and sampled detail have later paths in the catalog. |
| **Projection and source metadata** | A typed or normalized projection supplies columns for the usual summaries, group counts, and bins. File and image statistics start from a SQL-visible metadata relation. | Reuse the same contracts after extraction. Define parsing, tokenization, Unicode classification, or metadata inputs for the requested capability. |
| **Ordered observations** | An explicit order and, when needed, an expected interval or lag set. Results are steps, gaps, or lag statistics. | Use SQL window functions for steps and gaps. Specify and validate ACF, PACF, and related methods before exposing a public contract. |
| **Similarity** | Selected fields, a stable row identifier, and a similarity rule. Results describe candidate duplicate groups and membership. | Validate the matching and grouping semantics before adding a public contract. |
| **Profile comparison** | Two aligned profile results or one result and a caller-supplied threshold. Results are deltas or check outcomes. | Join compatible results by metric, category, or bin, or compare a metric directly with its threshold in SQL. |
| **Specialized tests** | Method-specific input such as an expected distribution or an ordered series with test parameters. Results include the observed test statistic and, where applicable, a p-value. | Keep these in the extension scope and validate their assumptions and algorithms separately. |

```sql
SELECT
    quantile_cont(amount, [0.25, 0.5, 0.75]) AS quantiles,
    histogram(amount, [50.0, 100.0, 250.0]) AS histogram
FROM orders
WHERE isfinite(amount);
```

Before adding a public function, trace the metrics it would serve to their input, result grain, and derivation. Give each metric a concrete SQL example or, for a later capability, an explicit input and result contract before marking it supported.

## Reports and interaction

DuckDB computes the statistics and exposes them as query results. A client such as AVA can render and explore those results.

| Capability | Delivery |
| --- | --- |
| **SQL and structured export** | First release. Query, store, and export results to JSON or CSV with DuckDB. |
| **Reports and charts** | Later in the client. Render tables, distributions, missingness, correlations, and findings from the SQL results. |
| **Sample and duplicate previews** | Later in the client. Request bounded previews and control whether raw values appear. |
| **Dataset comparison** | Later in the client. Display comparable profiles side by side using comparison results computed in DuckDB. |
| **HTML and notebooks** | Later in the client. Add standalone HTML export and embeddable notebook views. |
| **Interactive exploration** | Later in the client. Query the appropriate statistics as the user filters data or selects columns. |
| **Metadata and reproducibility** | Later in the client. Add descriptions, data dictionaries, report styling, and records of the input, settings, DuckDB version, and run time. |

## Implementation

Start with DuckDB SQL table macros. Resolve the input relation with `query_table()` and bind the selected columns to type-appropriate aggregates or grouping expressions. The count function keeps the original key types in its struct fields.

Combine compatible default aggregates. Reuse grouped counts and other intermediate results when several derived metrics share them. Run distribution and pairwise calculations when requested.

The table-macro building blocks were prototyped in DuckDB 1.5.5. The two function contracts, reference parity, and end-to-end performance still need validation.
