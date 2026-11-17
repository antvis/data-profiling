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

## Core metrics

The **Importance** rating reflects each group's value for general-purpose profiling in AVA. Five stars mark the core metrics. Four stars are for common follow-up analyses, three for context-specific statistics, two for specialized analysis, and one for narrow domain needs.

Field names and calculation rules come from the FG source at `c27f8dc`. The final column describes FG's defaults. Short column field names refer to entries under `variables.<column>`.

| Scope | Original field name | Importance | Calculation | FG default or required setting |
| --- | --- | :---: | --- | --- |
| Table size | `table.n`, `table.n_var` | ⭐⭐⭐⭐⭐ | Number of input rows and columns. | Pandas and Spark by default. |
| Column types | `table.types` | ⭐⭐⭐⭐⭐ | Column counts grouped by the detected profiling type. | Pandas and Spark by default. |
| Duplicate groups | `table.n_duplicates`, `table.p_duplicates` | ⭐⭐⭐⭐⭐ | Number of groups with more than one row, and that group count divided by total rows. Pandas groups by supported columns and Spark groups by all columns. | Pandas and Spark by default when `duplicates.head` is positive. The minimal preset sets it to 0. |
| Column missingness | `n`, `n_missing`, `p_missing`, `count` | ⭐⭐⭐⭐⭐ | Total observations, missing observations, missing observations divided by total, and total minus missing. Pandas sums missing groups. Spark reads the first matching missing group when counting `NULL` or NaN. | Pandas and Spark by default. |
| Value frequencies | `value_counts_without_nan`, `value_counts_index_sorted` | ⭐⭐⭐⭐⭐ | Non-missing value frequencies and a frequency table ordered by value. Spark takes the first 200 groups ordered by value from its full grouping for the second field. | Pandas and Spark by default when applicable. Pandas produces the sorted field when the values can be sorted. |
| Distinct values | `n_distinct`, `p_distinct` | ⭐⭐⭐⭐⭐ | Exact distinct count and ratio. Pandas uses non-missing groups and observations. Spark uses all groups and all rows, so missing groups can contribute. | Pandas and Spark by default. |
| Numeric location and range | `min`, `max`, `mean`, `sum`, `range` | ⭐⭐⭐⭐⭐ | Minimum, maximum, mean, sum and maximum minus minimum. Pandas can include infinities in the basic aggregates. Spark filters `NULL`, `NaN` and infinities before those aggregates. | Pandas and Spark numeric columns by default. |
| Quantiles | `5%`, `25%`, `50%`, `75%`, `95%` | ⭐⭐⭐⭐⭐ | Default percentile keys. Pandas uses Series.quantile. Spark uses `approxQuantile` with relative error 0.05. The median is stored under 50%. | Pandas and Spark numeric columns by default. `vars.num.quantiles` controls which percentile keys are generated. |
| Numeric distribution | `histogram` | ⭐⭐⭐⭐⭐ | Excludes infinities and bins values weighted by frequency. The result contains bin values and bin edges. With `density` enabled the bin values are densities. | Pandas and Spark numeric columns by default when data can be binned. `plot.histogram` controls binning and density. |
| Datetime range | `min`, `max`, `range` | ⭐⭐⭐⭐⭐ | Earliest and latest parsed value and the elapsed time between them. Spark aggregates the typed date or timestamp column. | Pandas and Spark datetime columns by default. |
| String lengths | `min_length`, `max_length`, `mean_length`, `median_length` | ⭐⭐⭐⭐⭐ | Minimum, maximum, frequency-weighted mean and weighted median of character lengths. | On by default via `vars.cat.length` for Pandas categorical columns and `vars.text.length` for Pandas and Spark text columns. |
| Linear and rank correlation | `correlations.pearson`, `correlations.spearman` | ⭐⭐⭐⭐⭐ | Pearson linear and Spearman rank correlation matrices. Spark assembles the eligible numeric columns into a vector and skips rows marked invalid by the assembler. | Pandas requires the corresponding `calculate` switch. Both are on in the ordinary Spark configuration. |

<details>
<summary>More FG metrics and configuration (40 groups)</summary>

FG's minimal preset turns off correlations, missingness charts, duplicate detection and the listed chi-square tests. It also disables categorical length, character and word summaries. Text columns have separate switches. FG's exploratory preset enables URL, path, file and image detection.

| Scope | Original field name | Importance | Calculation | FG default or required setting |
| --- | --- | :---: | --- | --- |
| Table missingness | `table.n_cells_missing`, `table.p_cells_missing` | ⭐⭐⭐⭐ | Sum of missing counts across columns, and that sum divided by rows × columns. | Pandas and Spark by default. |
| Table missingness | `table.n_vars_with_missing`, `table.n_vars_all_missing` | ⭐⭐⭐⭐ | Number of columns with at least one missing value, and number of columns with all values missing. | Pandas and Spark by default. |
| Table memory | `table.memory_size`, `table.record_size` | ⭐⭐ | Total DataFrame memory use, and memory use per input row. | Pandas by default. Set `memory_deep` to true for deep memory accounting. |
| Duplicate counts | `duplicates`, `# duplicates` | ⭐⭐⭐⭐ | The most frequent duplicate groups with a row count for each group. The count column name comes from duplicates.key. | Pandas and Spark by default. `duplicates.head` defaults to 10 and limits the groups returned. |
| Column classification | `type`, `cast_type`, `hashable`, `ordering` | ⭐⭐⭐⭐ | Profiling type, declared type override, whether values can be counted by hashing, and whether the value counts can be sorted by value. | Both backends report type. Pandas reports `cast_type` when overridden, and `hashable` and `ordering` during counting. Spark sets `cast_type` to null. |
| Column memory | `memory_size` | ⭐⭐ | Pandas Series memory usage. Spark fills the column result with 0 as a placeholder. | Measured by Pandas by default. `memory_deep` changes the accounting. |
| Singletons and uniqueness | `n_unique`, `p_unique`, `is_unique` | ⭐⭐⭐⭐ | Number of groups with frequency exactly 1, their ratio, and the uniqueness flag. Pandas uses non-missing values and requires at least one present value for uniqueness. Spark uses all groups and rows. | Pandas and Spark by default. |
| Numeric spread | `variance`, `std`, `cv` | ⭐⭐⭐⭐ | Sample variance, sample standard deviation, and standard deviation divided by the mean. A zero mean yields `NaN` for cv. | Pandas and Spark numeric columns by default. |
| Numeric shape | `skewness`, `kurtosis` | ⭐⭐⭐ | Skewness and excess kurtosis. Pandas uses Series methods and Spark uses native aggregates. | Pandas and Spark numeric columns by default. |
| Special numeric values | `n_negative`, `p_negative`, `n_zeros`, `p_zeros`, `n_infinite`, `p_infinite` | ⭐⭐⭐⭐ | Counts and proportions of negative values, zeros, and positive and negative infinities combined. The denominator is the total observation count. Negative infinity also contributes to the negative count. | Pandas and Spark numeric columns by default. |
| Robust spread | `iqr`, `mad` | ⭐⭐⭐⭐ | IQR is P75 minus P25. MAD is the median absolute deviation from the median. Spark uses approximate quantiles for MAD. | Pandas and Spark numeric columns by default. IQR requires P25 and P75. Spark MAD also requires P50. |
| Numeric monotonicity | `monotonic_increase`, `monotonic_decrease`, `monotonic_increase_strict`, `monotonic_decrease_strict`, `monotonic` | ⭐⭐⭐ | Checks increasing and decreasing order. Strict variants also require unique values. The summary code is 2 for strictly increasing, −2 for strictly decreasing, 1 or −1 for non-strict order, and 0 otherwise. | Pandas numeric columns by default. Spark sets `monotonic` to 0 as a placeholder. |
| Chi-square | `chi_squared.statistic`, `chi_squared.pvalue` | ⭐⭐ | Chi-square statistic and p-value from observed frequencies. Numeric and datetime values are binned. Categorical values use their category frequencies. | Pandas by default for these types when `vars.num.chi_squared_threshold` is positive, including the categorical branch. The minimal preset sets it to 0. |
| Boolean mode | `top`, `freq` | ⭐⭐⭐ | Most frequent value and its count. Pandas uses non-missing frequencies. Spark takes the first group in the full frequency table, which can be a missing group. | Pandas and Spark Boolean columns by default. |
| Class imbalance | `imbalance` | ⭐⭐⭐ | One minus Shannon entropy divided by log₂ of the observed class count. Returns 0 for a single observed class. | Pandas categorical and Boolean columns by default. |
| Invalid dates | `invalid_dates`, `n_invalid_dates`, `p_invalid_dates` | ⭐⭐⭐⭐ | Distinct non-missing values that failed parsing, the number of rows with such values, and their share of total rows. | Measured for Pandas datetime columns by default. Spark fills these fields with 0. |
| Datetime distribution | `histogram` | ⭐⭐⭐⭐ | Transforms date values into numeric timestamps and bins them. | Pandas and Spark datetime columns by default. |
| String length distribution | `length_histogram`, `histogram_length` | ⭐⭐⭐ | Exact frequency per integer length and a binned histogram weighted by those frequencies. | Uses the string length switches. |
| Character frequencies | `n_characters`, `n_characters_distinct`, `character_counts` | ⭐⭐⭐ | Total character occurrences, distinct characters and the frequency of each character. | On by default via `vars.cat.characters` for Pandas categorical columns and `vars.text.characters` for Pandas and Spark text columns. |
| Unicode categories | `category_alias_values`, `category_alias_counts`, `n_category`, `category_alias_char_counts` | ⭐⭐ | Character to Unicode category mapping, frequencies and count of categories, and character frequencies within each category. | Uses the character switches. |
| Unicode blocks | `block_alias_values`, `block_alias_counts`, `n_block_alias`, `block_alias_char_counts` | ⭐⭐ | Character to block abbreviation mapping, frequencies and count of blocks, and character frequencies within each block. | Uses the character switches. |
| Unicode scripts | `script_counts`, `n_scripts`, `script_char_counts` | ⭐⭐ | Frequencies and number of writing systems, plus character frequencies within each system. | Uses the character switches. Some classifications fall back to (unknown) when the Unicode classification dependency is missing. |
| Word frequencies | `word_counts` | ⭐⭐⭐ | Lowercases strings, splits on whitespace, strips punctuation at word boundaries, filters stop words and counts word occurrences. The field appears when there are results. | On by default via `vars.cat.words` for Pandas categorical columns and `vars.text.words` for Pandas and Spark text columns. Stop words use `vars.cat.stop_words.` Spark limits the returned list via `vars.text.spark_words_limit.` |
| Missingness charts | `missing.bar`, `missing.matrix`, `missing.heatmap` | ⭐⭐⭐ | Pandas charts use present counts per column, a presence flag for each cell, and a Pearson matrix of missingness flags, respectively. The heatmap excludes fully present and fully missing columns. | Pandas chart switches are on by default. The heatmap needs at least two partially missing columns. Spark defaults and the minimal preset turn these charts off. |
| Automatic association | `correlations.auto` | ⭐⭐⭐⭐ | Spearman for numeric pairs and corrected Cramér’s V for pairs with a categorical or Boolean member. Numeric values in mixed pairs are first binned with equal-width bins. | Pandas by default with at least two eligible columns. The minimal preset turns it off. |
| Kendall rank correlation | `correlations.kendall` | ⭐⭐⭐ | Kendall correlation matrix for numeric columns. | Pandas requires `correlations.kendall.calculate` set to true. |
| Categorical association | `correlations.cramers` | ⭐⭐⭐ | Corrected Cramér’s V from contingency tables of eligible categorical and Boolean column pairs. | Pandas requires `correlations.cramers.calculate` set to true. |
| Phi-K association | `correlations.phi_k` | ⭐⭐ | Phi-K matrix over eligible nonconstant columns. Numeric columns are passed as interval variables. | Pandas requires `correlations.phi_k.calculate` set to true. In Spark the dispatcher looks for `phik_compute`, while its implementation is named phi_k_compute. |
| URL components | `scheme_counts`, `netloc_counts`, `path_counts`, `query_counts`, `fragment_counts` | ⭐⭐ | Frequencies of URL scheme, network location, path, query string and fragment after urlsplit. | Pandas requires `vars.url.active` and a column detected as URL. |
| Path components | `common_prefix`, `stem_counts`, `suffix_counts`, `name_counts`, `parent_counts`, `anchor_counts` | ⭐⭐ | Common string prefix, and frequencies of paths without their final extension, extensions, basenames, parent directories and drive prefixes. | Pandas requires `vars.path.active` and a Path, File or Image column. |
| Path component cardinality | `n_stem_unique`, `n_suffix_unique`, `n_name_unique`, `n_parent_unique`, `n_anchor_unique` | ⭐⭐ | Number of distinct components in each of the five component frequency tables. | Uses the path switch. |
| File sizes | `file_size`, `histogram_file_size` | ⭐⭐ | Bytes per file from `os.stat().st_size`, and a histogram of those file sizes. | Pandas requires `vars.path.active` and `vars.file.active` and a File or Image column. |
| File timestamps | `file_created_time`, `file_accessed_time`, `file_modified_time` | ⭐ | Local timestamp strings from `st_ctime`, `st_atime` and st_mtime. On Unix `st_ctime` is metadata change time. The report counts frequencies of these strings. | Uses the file switches. |
| Image integrity and dimensions | `n_truncated`, `image_dimensions` | ⭐ | Number of images that open but fail to load, and the width and height pairs of images that load. The report can count frequencies of dimension pairs. | Pandas requires active path, file and image recognition and a column detected as Image. |
| Image dimensions and area | `min_width`, `max_width`, `mean_width`, `median_width`, `min_height`, `max_height`, `mean_height`, `median_height`, `min_area`, `max_area`, `mean_area`, `median_area` | ⭐ | Minimum, maximum, mean and median of widths, heights, and width × height. | Calculated when image analysis runs. |
| Image EXIF | `exif_keys_counts`, `exif_data` | ⭐ | EXIF tag occurrence counts and frequency tables of values for each tag. | Image analysis must be enabled and `vars.image.exif` must be true. This sub-option is on in the ordinary configuration. |
| Time index | `time_index_analysis.n_series`, `time_index_analysis.length`, `time_index_analysis.start`, `time_index_analysis.end`, `time_index_analysis.period` | ⭐⭐⭐ | Number of TimeSeries columns, number of input observations, earliest and latest index values, and mean absolute step between adjacent index values. | Pandas requires `tsmode` set to true and a numeric or datetime index. |
| Stationarity and seasonality | `addfuller`, `stationary`, `seasonal` | ⭐⭐ | ADF p-value, a stationarity flag that requires a p-value below the configured significance level and no seasonality, and a seasonality flag from FFT peak detection. | Pandas requires `tsmode` set to true and a column detected as TimeSeries. ADF uses `autolag`, `maxlag` and `significance`. |
| Time gaps | `gap_stats.n_gaps`, `gap_stats.gaps`, `gap_stats.min`, `gap_stats.max`, `gap_stats.mean`, `gap_stats.std` | ⭐⭐⭐⭐ | After dropping missing observations, a positive index step counts as a gap if it exceeds twice the mean positive step. Records gap counts and endpoints, and minimum, maximum, mean and sample standard deviation of lengths. | Calculated on Pandas TimeSeries columns when time series is enabled. |
| Autocorrelation charts | `ACF`, `PACF` | ⭐⭐ | Autocorrelation, partial autocorrelation and confidence intervals by lag. The native chart uses FFT ACF, ywm PACF and alpha 0.05. `pacf_acf_lag` and the sample size limit the lag count. | Pandas computes these when generating the time-series chart. ACF and PACF are chart labels. |

### Source details

- The image helper can compute `n_duplicate_hash` when it receives `hash=True`. The standard image analysis passes only the EXIF setting.
- The time index result declares `frequency` and leaves it empty. The seasonality helper finds candidate periods, and the column summary keeps the `seasonal` flag.

</details>
