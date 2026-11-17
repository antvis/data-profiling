**English** | [简体中文](./README.zh-CN.md)

# AVA Data Profiling

AVA Data Profiling brings dataset profiling to DuckDB SQL. Inspect a table or view, summarize distributions, and find data quality issues through table functions. DuckDB computes the statistics, and report clients consume the results.

The project is inspired by the one-call exploratory data analysis workflow in [`fg-data-profiling`](https://github.com/Data-Centric-AI-Community/fg-data-profiling).

> [!NOTE]
> This README is a design draft. The SQL functions and release stages below are proposed.

## Usage

Pass a table or view name to `ava_profile()`. Use a view to profile a file, a filtered query, or a join.

```sql
CREATE TEMP VIEW orders AS
SELECT * FROM read_parquet('orders.parquet');

SELECT * FROM ava_profile('orders');
```

Select fields and request exact counts and quantiles when needed.

```sql
SELECT *
FROM ava_profile(
    'orders',
    columns := ['amount', 'channel'],
    quantiles := [0.05, 0.25, 0.5, 0.75, 0.95],
    exact := true
);
```

Use the results in another SQL query.

```sql
SELECT column_name, value::DOUBLE AS missing_rate
FROM ava_profile('orders')
WHERE metric = 'missing_rate'
ORDER BY missing_rate DESC NULLS LAST;
```

## Profiling coverage

**Default** runs with `ava_profile(source)` in the first release. **On demand** is available in the first release through an explicit option or function call. **Later** identifies capabilities planned for a subsequent release.

The coverage below follows the public `fg-data-profiling` feature set, including specialized analyses behind optional settings. The stages describe AVA Data Profiling’s implementation plan.

| Area | Statistics and analysis | Stage |
| --- | --- | --- |
| **Dataset overview** | Row count, total and profiled column counts, type breakdown, and dataset-wide missing cell count and rate | Default |
| **Column overview** | DuckDB type, analysis type derived from the schema, non-null count, missing count, missing rate, and approximate distinct count and rate | Default |
| **Type inference** | Infer analysis types from values, including low-cardinality numeric categories, date-like strings, boolean-like strings, free text, URLs, paths, files, and images. Support explicit type overrides. | Later |
| **Storage footprint** | Dataset and column size, and average bytes per row where the source exposes a meaningful measure. Document the measurement for each source. | Later |
| **Numeric statistics** | Minimum, maximum, range, sum, mean, sample variance, sample standard deviation, coefficient of variation, skewness, and excess kurtosis | Default |
| **Special numeric values** | Counts and rates for zeros, negatives, `NaN`, and positive and negative infinity | Default |
| **Quantiles and spread** | Requested quantiles, including the median and quartiles. Compute IQR when both quartiles are requested. Quantiles can be approximate or exact. | On demand |
| **Numeric distribution** | Histogram bin boundaries and counts, plus low and high values with their frequencies | On demand |
| **Advanced numeric analysis** | Median absolute deviation, monotonicity, uniformity tests, and outlier summaries | Later |
| **Cardinality and uniqueness** | Exact distinct count and rate, count and rate of values that occur exactly once, and whether every observed value occurs once | On demand |
| **Category frequencies** | Most and least frequent values, counts and shares, mode and its share, and the full frequency table when requested | On demand |
| **Category consistency** | Category imbalance, uniformity tests, and groups of potentially inconsistent labels such as spelling or formatting variants | Later |
| **Boolean values** | True and false counts and shares | Default |
| **Text length** | Empty and whitespace-only counts, minimum, maximum, and mean character length | Default |
| **Text distribution** | Median length, length histogram, word and character frequencies, and Unicode categories, scripts, and blocks | Later |
| **Dates and timestamps** | Earliest and latest values and the time span between them | Default |
| **Date distribution** | Date or timestamp histograms and invalid date counts when profiling date-like strings | Later |
| **Exact duplicates** | Duplicate group count, duplicate row count and rate, across the whole row or a selected set of columns | On demand |
| **Near duplicates** | Similar-row detection and summaries of candidate duplicate groups | Later |
| **Missingness patterns** | Co-missing counts and missingness correlations for selected column pairs | On demand |
| **Row-level missingness** | Missing-value indicators for an explicitly selected sample, suitable for a missingness matrix | Later |
| **Numeric correlations** | Pairwise Pearson correlation and valid pair counts for selected numeric columns | On demand |
| **Rank and mixed-type associations** | Spearman, Kendall, Cramér’s V, and Phi-K. An automatic mode selects a method by type and bins numeric values for mixed-type pairs. | Later |
| **Variable interactions** | Paired values or binned counts for scatter plots and other views of joint distributions | Later |
| **Basic alerts** | Empty relation, missing values, constant values or text length, zeros, non-finite values, skewness, and unsupported types | Default |
| **Alerts based on requested analysis** | High cardinality and uniqueness from exact frequencies, duplicate rows from duplicate analysis, and high Pearson correlation from selected pairs | On demand |
| **Advanced alerts** | Category imbalance, uniformity, inconsistent labels, date-like strings, near duplicates, non-stationarity, and seasonality | Later |
| **Time series** | Time-index gaps, missing observations, lag autocorrelation, ACF/PACF, stationarity, seasonality, and data for time plots | Later |
| **URLs and paths** | URL components such as scheme and host, and path components such as parent, filename, and extension | Later |
| **Files and images** | File sizes and timestamps, image dimensions, truncated-image indicators, and EXIF summaries. DuckDB aggregates metadata exposed through a relation. | Later |
| **Dataset comparison** | Compare profiles across versions or datasets, including schema, missingness, category frequencies, and distributions using shared bins | Later |

## SQL API

| Function | Result |
| --- | --- |
| `ava_profile(source, columns := [], quantiles := [], exact := false)` | One row per metric with `column_name`, `column_type`, `metric`, `value` (`JSON`), and `is_approximate`. Table-level rows have a `NULL` column name and type. `exact := true` enables exact cardinality and uniqueness statistics and uses exact quantiles when requested. |
| `ava_profile_histogram(source, column_name, bins := 10)` | One row per numeric bin with its bounds and count. |
| `ava_profile_top_values(source, column_name, k := 10)` | One row per observed value with its count and share. `k := NULL` returns the full frequency table, which can also be sorted to find the least frequent values. |
| `ava_profile_duplicates(source, columns := [])` | Duplicate group count, duplicate row count, duplicate rate, and any triggered duplicate alert. An empty column list compares whole rows. |
| `ava_profile_missingness(source, columns)` | Co-missing count and missingness correlation for each selected column pair. |
| `ava_profile_correlations(source, columns)` | One row per selected numeric pair with `left_column`, `right_column`, `n_pairs`, `pearson_r`, and any triggered correlation alert. |

```sql
SELECT * FROM ava_profile_histogram('orders', 'amount', bins := 12);
SELECT * FROM ava_profile_top_values('orders', 'channel', k := 5);
SELECT * FROM ava_profile_duplicates('orders', columns := ['order_id']);
SELECT * FROM ava_profile_missingness('orders', ['amount', 'channel']);
SELECT * FROM ava_profile_correlations('orders', ['amount', 'quantity']);
```

### Metric definitions

- **Missingness.** `null_count` counts SQL `NULL`. `missing_count` also includes floating-point `NaN`. Table-wide missingness uses the profiled columns. Rates with a zero denominator return `NULL`.
- **Cardinality.** Distinct values are the different observed values. Singleton values occur exactly once. Distinct and singleton rates use the non-missing count as their denominator. Uniqueness flags use exact counts.
- **Numeric calculations.** Numeric summaries, histograms, and correlations use finite values. Special values have their own counts. Correlation is `NULL` when a pair has too few valid observations or zero variance.
- **Duplicates.** A duplicate group contains at least two rows with the same values in the selected columns. The duplicate row count counts rows beyond the first in each group. A candidate key check also needs the missingness result.
- **Alerts.** An alert includes the rule, affected table or columns, observed value, and applicable threshold. Checks that depend on row order, such as monotonicity and time gaps, require an explicit ordering column.

## Reports and interaction

The DuckDB functions return metrics, bins, frequencies, and alerts. AVA or another client can turn those results into a report or an interactive view.

| Capability | Delivery |
| --- | --- |
| **SQL and machine-readable export** | First release. Query, persist, or export profile results to JSON or CSV using DuckDB. |
| **Report overview and column details** | Later in the report client. Render metric tables, distributions, correlations, missingness views, and an alerts section. |
| **Sample and duplicate previews** | Later in the report client. Request bounded previews explicitly and let report authors control whether raw values appear. |
| **Dataset comparison** | Later in the report client. Show profiles side by side using comparison results computed in DuckDB. |
| **Shareable reports and notebooks** | Later in the report client. Add standalone HTML export and embeddable notebook views. |
| **Interactive exploration** | Later in the report client. Filter or select a column and request the corresponding SQL results. |
| **Metadata, appearance, and reproducibility** | Later in the report client. Add dataset descriptions, a data dictionary, report styling, and a record of the source, DuckDB version, settings, and run time. |

## Implementation

Start with DuckDB SQL table macros. Use `query_table()` to resolve tables and views, and `COLUMNS()` to apply aggregates across the selected fields. Any DuckDB client, including Node.js, can call the functions through its existing connection.

Combine compatible default statistics into a single aggregate query. Choose exact or approximate aggregates before execution. Run full value frequencies, duplicate grouping, and pairwise analysis only when requested. Return compact results to the client for display.

The table-macro primitives were verified on DuckDB 1.5.5. The proposed functions, cross-library metric comparisons, and end-to-end performance still need validation.
