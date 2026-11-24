# Metric catalog

The runner accepts the metric IDs below through repeatable `--metric` arguments. An explicit selection replaces the default profile and retains `row_count`.

The default profile requests `row_count`, `column_count`, `profiling_type`, `missing_count`, `missing_rate`, `distinct_count`, `top_values`, `min`, `max`, and `mean`.

## Table metrics

| Metric IDs | Statistical definition |
| --- | --- |
| `row_count`, `column_count` | The number of rows and columns in the full input table. |
| `missing_cell_count`, `missing_cell_rate` | The count and proportion of missing cells across the selected fields. The denominator for the rate is the number of rows multiplied by the number of selected fields. |
| `columns_with_missing_count`, `all_missing_column_count` | The number of selected fields with at least one missing observation or with all observations missing, respectively. An empty table yields zero for both. |

## Column metrics

| Metric IDs | Statistical definition and applicability |
| --- | --- |
| `observation_count`, `present_count`, `missing_count`, `null_count`, `missing_rate` | Total observations, nonmissing observations, missing observations, and the fraction of observations that are missing. The runner uses extended semantics, under which SQL NULL and floating-point NaN contribute equally to both missing counts. |
| `profiling_type`, `declared_type`, `is_groupable`, `is_orderable` | Profiling type, DuckDB schema type, and the planner's grouping and ordering flags. |
| `distinct_count`, `distinct_rate` | Exact count of distinct nonmissing values and its ratio to the nonmissing count, for recognized scalar types. |
| `duplicate_count`, `is_unique` | Excess observations after keeping one of each nonmissing value, and whether a nonempty set of nonmissing observations has no repeats. Pair `is_unique` with `missing_count` when evaluating a candidate key. |
| `top_values` | Up to three most frequent nonmissing values and their counts for string and Boolean columns. The planner skips this metric when distinct nonmissing values exceed half the total row count. |
| `min`, `max` | The lower and upper bounds of a numeric or native temporal column. |
| `mean`, `sum`, `median`, `range` | The arithmetic mean, sum, median, and difference between the maximum and minimum for numeric observations. |
| `stddev`, `stddev_samp`, `variance_samp`, `cv` | Sample standard deviation under either ID, sample variance, and sample standard deviation divided by the mean. |
| `skewness`, `excess_kurtosis`, `iqr`, `mad` | Distribution asymmetry, excess kurtosis, interquartile range, and median absolute deviation for numeric observations. |
| `negative_count`, `negative_rate`, `zero_count`, `zero_rate`, `infinity_count`, `infinity_rate` | Counts and proportions of negative, zero, or infinite observations for numeric columns. The denominator for each rate is the total row count. |
| `min_length`, `max_length`, `mean_length`, `median_length` | The minimum, maximum, arithmetic mean, and median of string lengths. |
| `min_timestamp`, `max_timestamp`, `time_span` | Finite temporal bounds and the elapsed interval in nanoseconds for native date and timestamp columns. |

A metric's applicability is determined per field. The JSON profile records `unsupported_type` and `cardinality_limit` under `skipped`. A computed but undefined statistic is represented by a tagged null in `results`.
