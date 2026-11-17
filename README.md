**English** | [简体中文](./README.zh-CN.md)

# AVA Data Profiling

AVA Data Profiling is a DuckDB SQL project for profiling tabular data, inspired by [fg-data-profiling](https://github.com/Data-Centric-AI-Community/fg-data-profiling). Its focus is on statistics you can query and reuse, from missingness and value counts to distributions and duplicate groups.

> [!NOTE]
> The library is in the design stage. The example shows the proposed AVA SQL interface.

## Usage example

Suppose `orders` is a DuckDB table with numeric columns `amount` and `quantity`, a text column `channel`, and a timestamp column `created_at`.

```sql
SELECT * FROM ava_profile('orders');
```

The proposed call covers the core metrics that apply to this table. It summarizes row and column counts, counts by column type, and duplicate-group counts and rates, as well as missing values, frequencies and distinct counts for each column. It also computes numeric ranges, aggregates, quantiles and histograms, string lengths for `channel`, and the time range for `created_at`. For the numeric pair, it computes Pearson and Spearman correlations.

Use `columns` to profile just the two numeric columns.

```sql
SELECT * FROM ava_profile('orders', columns := ['amount', 'quantity']);
```

## Core metrics

The **Importance** rating reflects each group's value for general-purpose profiling in AVA. Five stars mark the core metrics. Four stars are for common follow-up analyses, three for context-specific statistics, two for specialized analysis, and one for narrow domain needs.

Names and IDs correspond line by line in each group.

| Scope | Name | ID | Importance | Calculation |
| --- | --- | --- | :---: | --- |
| Table size | Row count<br>Column count | `row_count`<br>`column_count` | ⭐⭐⭐⭐⭐ | Count the rows and columns in the input table or view. |
| Column types | Column counts by type | `column_type_counts` | ⭐⭐⭐⭐⭐ | Group columns by their profiling type and count each group. |
| Duplicate groups | Duplicate group count<br>Duplicate group ratio | `duplicate_group_count`<br>`duplicate_group_rate` | ⭐⭐⭐⭐⭐ | Group rows by their profiled values and count the groups containing more than one row. Divide the group count by the total row count for the ratio. |
| Column missingness | Observation count<br>Missing count<br>Missing rate<br>Present count | `observation_count`<br>`missing_count`<br>`missing_rate`<br>`present_count` | ⭐⭐⭐⭐⭐ | Count all observations and the missing observations for each column. The difference gives the present count. The rate uses all observations as the denominator. |
| Value frequencies | Value frequencies<br>Frequencies ordered by value | `value_counts`<br>`value_counts_by_value` | ⭐⭐⭐⭐⭐ | Count occurrences of each present value. Sort by value to inspect the ends of an ordered column. |
| Distinct values | Distinct value count<br>Distinct value ratio | `distinct_count`<br>`distinct_rate` | ⭐⭐⭐⭐⭐ | Count distinct present values. Divide by the count of present observations for the ratio. |
| Numeric location and range | Minimum<br>Maximum<br>Mean<br>Sum<br>Range | `min`<br>`max`<br>`mean`<br>`sum`<br>`range` | ⭐⭐⭐⭐⭐ | Summarize numeric values with basic aggregates. Subtract the minimum from the maximum for the range. |
| Quantiles | Quantiles<br>Median | `quantiles`<br>`median` | ⭐⭐⭐⭐⭐ | Find values at selected cumulative probabilities, such as P5, P25, P50, P75 and P95. P50 is the median. |
| Numeric distribution | Numeric histogram | `numeric_histogram` | ⭐⭐⭐⭐⭐ | Bin finite numeric values and retain the bin edges and frequencies. |
| Datetime range | Earliest time<br>Latest time<br>Time span | `min_timestamp`<br>`max_timestamp`<br>`time_span` | ⭐⭐⭐⭐⭐ | Find the earliest and latest valid datetime values and subtract the earliest from the latest. |
| String lengths | Minimum string length<br>Maximum string length<br>Mean string length<br>Median string length | `min_length`<br>`max_length`<br>`mean_length`<br>`median_length` | ⭐⭐⭐⭐⭐ | Measure character lengths and summarize them using each length's frequency. |
| Linear and rank correlation | Pearson correlation<br>Spearman rank correlation | `pearson_r`<br>`spearman_rho` | ⭐⭐⭐⭐⭐ | Measure linear association and rank association between pairs of numeric columns. |

<details>
<summary>More metrics (40 groups)</summary>

| Scope | Name | ID | Importance | Calculation |
| --- | --- | --- | :---: | --- |
| Table missingness | Missing cell count<br>Missing cell rate | `missing_cell_count`<br>`missing_cell_rate` | ⭐⭐⭐⭐ | Sum the missing counts across columns and divide by the number of cells for the rate. |
| Table missingness | Columns with missing values<br>Entirely missing columns | `columns_with_missing_count`<br>`all_missing_column_count` | ⭐⭐⭐⭐ | Count columns with at least one missing value and columns whose values are all missing. |
| Table memory | Table memory use<br>Average memory per row | `table_memory_bytes`<br>`mean_row_memory_bytes` | ⭐⭐ | Measure the input data's memory use and divide it by the row count for the per-row average. |
| Duplicate counts | Duplicate group sizes | `duplicate_group_row_count` | ⭐⭐⭐⭐ | Count the rows in each duplicate group to show how often the same value combination occurs. |
| Column classification | Profiling type<br>Declared type<br>Grouping support<br>Ordering support | `profiling_type`<br>`declared_type`<br>`is_groupable`<br>`is_orderable` | ⭐⭐⭐⭐ | Record the type used for profiling, any declared type, and whether values can be grouped and ordered. |
| Column memory | Column memory use | `column_memory_bytes` | ⭐⭐ | Measure the memory used by a column's input data. |
| Singletons and uniqueness | Singleton count<br>Singleton ratio<br>Uniqueness | `singleton_count`<br>`singleton_rate`<br>`is_unique` | ⭐⭐⭐⭐ | Count the values that appear exactly once. Divide by the present observation count for the ratio. Check whether every present observation has a unique value when the column contains at least one present observation. |
| Numeric spread | Sample variance<br>Sample standard deviation<br>Coefficient of variation | `variance_samp`<br>`stddev_samp`<br>`cv` | ⭐⭐⭐⭐ | Measure sample dispersion and divide the standard deviation by the mean for the coefficient of variation when the mean is nonzero. |
| Numeric shape | Skewness<br>Excess kurtosis | `skewness`<br>`excess_kurtosis` | ⭐⭐⭐ | Measure distribution asymmetry and the fourth standardized moment relative to a normal distribution. |
| Special numeric values | Negative value count<br>Negative value rate<br>Zero count<br>Zero rate<br>Infinity count<br>Infinity rate | `negative_count`<br>`negative_rate`<br>`zero_count`<br>`zero_rate`<br>`infinity_count`<br>`infinity_rate` | ⭐⭐⭐⭐ | Count negative values, zero values and positive or negative infinity. Divide by all observations for each rate. Negative infinity also contributes to the negative count. |
| Robust spread | Interquartile range<br>Median absolute deviation | `iqr`<br>`mad` | ⭐⭐⭐⭐ | Subtract P25 from P75 for the interquartile range. For the median absolute deviation, take the median of the absolute differences from the median. |
| Numeric monotonicity | Nondecreasing order<br>Nonincreasing order<br>Strictly increasing order<br>Strictly decreasing order | `is_nondecreasing`<br>`is_nonincreasing`<br>`is_strictly_increasing`<br>`is_strictly_decreasing` | ⭐⭐⭐ | Check whether values are nondecreasing or nonincreasing in the specified order. Strict monotonicity also requires distinct values. |
| Chi-square | Chi-square statistic<br>Chi-square p-value | `chi_squared_statistic`<br>`chi_squared_p_value` | ⭐⭐ | Compare observed frequencies with equal expected frequencies, using category counts or bins for numeric and datetime values. |
| Boolean mode | Most frequent Boolean value<br>Most frequent Boolean value count | `boolean_mode`<br>`boolean_mode_count` | ⭐⭐⭐ | Identify the most frequent present Boolean value and count its occurrences. |
| Class imbalance | Class imbalance score | `category_imbalance_score` | ⭐⭐⭐ | Subtract Shannon entropy divided by the base-two logarithm of the observed class count from one. A single observed class gives a score of zero. |
| Invalid dates | Distinct invalid dates<br>Rows with invalid dates<br>Invalid date rate | `invalid_date_distinct_count`<br>`invalid_date_count`<br>`invalid_date_rate` | ⭐⭐⭐⭐ | Count distinct present values that fail date parsing and count the affected rows. Divide the affected row count by all rows for the rate. |
| Datetime distribution | Datetime histogram | `datetime_histogram` | ⭐⭐⭐⭐ | Put datetime values into time bins and count the observations in each bin. |
| String length distribution | Length frequencies<br>Length histogram | `length_counts`<br>`length_histogram` | ⭐⭐⭐ | Count strings at each integer length, or bin those lengths using their frequencies as weights. |
| Character frequencies | Character count<br>Distinct character count<br>Character frequencies | `character_count`<br>`distinct_character_count`<br>`character_counts` | ⭐⭐⭐ | Count each character's occurrences, sum the counts and count the distinct characters. |
| Unicode categories | Unicode category count<br>Unicode category frequencies<br>Character frequencies within categories | `unicode_category_distinct_count`<br>`unicode_category_frequencies`<br>`unicode_category_character_counts` | ⭐⭐ | Map characters to Unicode categories and count both the categories and the characters within them. |
| Unicode blocks | Unicode block count<br>Unicode block frequencies<br>Character frequencies within Unicode blocks | `unicode_block_distinct_count`<br>`unicode_block_frequencies`<br>`unicode_block_character_counts` | ⭐⭐ | Map characters to Unicode blocks and report counts by block and by character within each block. |
| Unicode scripts | Writing system count<br>Writing system frequencies<br>Character frequencies within writing systems | `unicode_script_distinct_count`<br>`unicode_script_frequencies`<br>`unicode_script_character_counts` | ⭐⭐ | Group character occurrences by Unicode script and count the scripts and the characters within them. |
| Word frequencies | Word frequencies | `word_counts` | ⭐⭐⭐ | Normalize case, split on whitespace, strip leading and trailing punctuation, and count words after removing configured stop words. |
| Missingness patterns | Present counts by column<br>Cell-level missingness flags<br>Missingness correlation | `column_present_counts`<br>`missing_mask`<br>`missingness_correlation` | ⭐⭐⭐ | Count present values by column, record whether each cell is missing, and correlate missingness flags across columns with varying missingness. |
| Automatic association | Association by column type | `auto_association` | ⭐⭐⭐⭐ | Use rank correlation for numeric pairs and corrected Cramér’s V for pairs involving categorical or Boolean values. Bin numeric values in mixed pairs. |
| Kendall rank correlation | Kendall rank correlation | `kendall_tau` | ⭐⭐⭐ | Measure rank association based on agreements and disagreements in pairwise order. |
| Categorical association | Corrected Cramér’s V | `cramers_v` | ⭐⭐⭐ | Build a contingency table for two categorical or Boolean columns and calculate the bias-corrected association strength. |
| Phi-K association | Phi-K association | `phi_k` | ⭐⭐ | Calculate the association strength from binned contingency tables for eligible column pairs. |
| URL components | URL scheme frequencies<br>URL network location frequencies<br>URL path frequencies<br>URL query string frequencies<br>URL fragment frequencies | `url_scheme_counts`<br>`url_netloc_counts`<br>`url_path_counts`<br>`url_query_counts`<br>`url_fragment_counts` | ⭐⭐ | Parse each URL and count schemes, network locations, paths, query strings and fragments separately. |
| Path components | Common path prefix<br>Path frequencies without extension<br>Extension frequencies<br>Basename frequencies<br>Parent directory frequencies<br>Drive prefix frequencies | `path_common_prefix`<br>`path_stem_counts`<br>`path_suffix_counts`<br>`path_basename_counts`<br>`path_parent_counts`<br>`path_drive_counts` | ⭐⭐ | Find the shared string prefix and count paths without extensions, extensions, basenames, parent directories and drive prefixes. |
| Path component cardinality | Distinct paths without extension<br>Distinct extensions<br>Distinct basenames<br>Distinct parent directories<br>Distinct drive prefixes | `path_stem_distinct_count`<br>`path_suffix_distinct_count`<br>`path_basename_distinct_count`<br>`path_parent_distinct_count`<br>`path_drive_distinct_count` | ⭐⭐ | Count distinct values for each path component. |
| File sizes | File size in bytes<br>File size histogram | `file_size_bytes`<br>`file_size_histogram` | ⭐⭐ | Read each file's size in bytes and bin the sizes into a histogram. |
| File timestamps | Modification time frequencies<br>Access time frequencies<br>Metadata change time frequencies | `file_modified_time_counts`<br>`file_access_time_counts`<br>`file_metadata_change_time_counts` | ⭐ | Summarize the frequencies of modification, access and metadata change timestamps from file metadata. |
| Image integrity and dimensions | Truncated image count<br>Image dimension frequencies | `truncated_image_count`<br>`image_dimension_counts` | ⭐ | Count images that open but fail to load. Group successfully loaded images by width and height. |
| Image dimensions and area | Minimum image width<br>Maximum image width<br>Mean image width<br>Median image width<br>Minimum image height<br>Maximum image height<br>Mean image height<br>Median image height<br>Minimum image area<br>Maximum image area<br>Mean image area<br>Median image area | `min_image_width`<br>`max_image_width`<br>`mean_image_width`<br>`median_image_width`<br>`min_image_height`<br>`max_image_height`<br>`mean_image_height`<br>`median_image_height`<br>`min_image_area`<br>`max_image_area`<br>`mean_image_area`<br>`median_image_area` | ⭐ | Calculate the minimum, maximum, mean and median of widths, heights and pixel areas. |
| Image EXIF | EXIF tag frequencies<br>EXIF value frequencies by tag | `exif_tag_counts`<br>`exif_value_counts` | ⭐ | Count how often each EXIF tag appears and the frequency of each value within a tag. |
| Time index | Time series count<br>Time index observation count<br>Time index start<br>Time index end<br>Average index step | `time_series_count`<br>`time_index_observation_count`<br>`time_index_start`<br>`time_index_end`<br>`mean_time_index_step` | ⭐⭐⭐ | Count time series and observations, find the minimum and maximum index, and take the mean absolute step between adjacent index values. |
| Stationarity and seasonality | ADF p-value<br>Stationarity<br>Seasonality | `adf_p_value`<br>`is_stationary`<br>`is_seasonal` | ⭐⭐ | Test for stationarity with ADF and detect periodic peaks in the frequency spectrum. The stationarity flag also takes seasonality into account. |
| Time gaps | Gap count<br>Gap endpoints<br>Minimum gap length<br>Maximum gap length<br>Mean gap length<br>Sample standard deviation of gap lengths | `gap_count`<br>`gap_endpoints`<br>`min_gap`<br>`max_gap`<br>`mean_gap`<br>`stddev_gap_samp` | ⭐⭐⭐⭐ | Locate gaps from successive index intervals after dropping missing observations. Summarize gap lengths with their minimum, maximum, mean and sample standard deviation. |
| Autocorrelation | Autocorrelation<br>Partial autocorrelation | `acf`<br>`pacf` | ⭐⭐ | Calculate ACF and PACF coefficients and confidence intervals at each lag. |

</details>
