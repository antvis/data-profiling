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

| Scope | Metrics | Importance | Calculation |
| --- | --- | :---: | --- |
| Table size | Row count and column count | ⭐⭐⭐⭐⭐ | Count the rows and columns in the input table or view. |
| Column types | Column counts by type | ⭐⭐⭐⭐⭐ | Group columns by their profiling type and count each group. |
| Duplicate groups | Duplicate group count and ratio | ⭐⭐⭐⭐⭐ | Group rows by their profiled values and count the groups containing more than one row. Divide the group count by the total row count for the ratio. |
| Column missingness | Observation count, missing count and rate, present count | ⭐⭐⭐⭐⭐ | Count all observations and the missing observations for each column. The difference gives the present count. The rate uses all observations as the denominator. |
| Value frequencies | Value frequencies and frequencies ordered by value | ⭐⭐⭐⭐⭐ | Count occurrences of each present value. Sort by value to inspect the ends of an ordered column. |
| Distinct values | Distinct value count and ratio | ⭐⭐⭐⭐⭐ | Count distinct present values. Divide by the count of present observations for the ratio. |
| Numeric location and range | Minimum, maximum, mean, sum and range | ⭐⭐⭐⭐⭐ | Summarize numeric values with basic aggregates. Subtract the minimum from the maximum for the range. |
| Quantiles | Quantiles and median | ⭐⭐⭐⭐⭐ | Find values at selected cumulative probabilities, such as P5, P25, P50, P75 and P95. P50 is the median. |
| Numeric distribution | Numeric histogram | ⭐⭐⭐⭐⭐ | Bin finite numeric values and retain the bin edges and frequencies. |
| Datetime range | Earliest value, latest value and time span | ⭐⭐⭐⭐⭐ | Find the earliest and latest valid datetime values and subtract the earliest from the latest. |
| String lengths | Minimum, maximum, mean and median string length | ⭐⭐⭐⭐⭐ | Measure character lengths and summarize them using each length's frequency. |
| Linear and rank correlation | Pearson and Spearman correlations | ⭐⭐⭐⭐⭐ | Measure linear association and rank association between pairs of numeric columns. |

<details>
<summary>More metrics (40 groups)</summary>

| Scope | Metrics | Importance | Calculation |
| --- | --- | :---: | --- |
| Table missingness | Missing cell count and rate | ⭐⭐⭐⭐ | Sum the missing counts across columns and divide by the number of cells for the rate. |
| Table missingness | Columns with missing values and entirely missing columns | ⭐⭐⭐⭐ | Count columns with at least one missing value and columns whose values are all missing. |
| Table memory | Table memory and average memory per row | ⭐⭐ | Measure the input data's memory use and divide it by the row count for the per-row average. |
| Duplicate counts | Duplicate group sizes | ⭐⭐⭐⭐ | Count the rows in each duplicate group to show how often the same value combination occurs. |
| Column classification | Detected and declared type, grouping and ordering support | ⭐⭐⭐⭐ | Record the type used for profiling, any declared type, and whether values can be grouped and ordered. |
| Column memory | Column memory use | ⭐⭐ | Measure the memory used by a column's input data. |
| Singletons and uniqueness | Singleton count and ratio, uniqueness | ⭐⭐⭐⭐ | Count the values that appear exactly once. Divide by the present observation count for the ratio. Check whether every present observation has a unique value when the column contains at least one present observation. |
| Numeric spread | Sample variance, sample standard deviation and coefficient of variation | ⭐⭐⭐⭐ | Measure sample dispersion and divide the standard deviation by the mean for the coefficient of variation when the mean is nonzero. |
| Numeric shape | Skewness and excess kurtosis | ⭐⭐⭐ | Measure distribution asymmetry and the fourth standardized moment relative to a normal distribution. |
| Special numeric values | Negative, zero and infinite value counts and rates | ⭐⭐⭐⭐ | Count negative values, zero values and positive or negative infinity. Divide by all observations for each rate. Negative infinity also contributes to the negative count. |
| Robust spread | Interquartile range and median absolute deviation | ⭐⭐⭐⭐ | Subtract P25 from P75 for the interquartile range. For the median absolute deviation, take the median of the absolute differences from the median. |
| Numeric monotonicity | Increasing and decreasing order, strict monotonicity | ⭐⭐⭐ | Check whether values are nondecreasing or nonincreasing in the specified order. Strict monotonicity also requires distinct values. |
| Chi-square | Chi-square statistic and p-value | ⭐⭐ | Compare observed frequencies with equal expected frequencies, using category counts or bins for numeric and datetime values. |
| Boolean mode | Most frequent Boolean value and count | ⭐⭐⭐ | Identify the most frequent present Boolean value and count its occurrences. |
| Class imbalance | Class imbalance score | ⭐⭐⭐ | Subtract Shannon entropy divided by the base-two logarithm of the observed class count from one. A single observed class gives a score of zero. |
| Invalid dates | Distinct invalid dates, invalid date count and rate | ⭐⭐⭐⭐ | Count distinct present values that fail date parsing and count the affected rows. Divide the affected row count by all rows for the rate. |
| Datetime distribution | Datetime histogram | ⭐⭐⭐⭐ | Put datetime values into time bins and count the observations in each bin. |
| String length distribution | Length frequencies and histogram | ⭐⭐⭐ | Count strings at each integer length, or bin those lengths using their frequencies as weights. |
| Character frequencies | Character count, distinct characters and frequencies | ⭐⭐⭐ | Count each character's occurrences, sum the counts and count the distinct characters. |
| Unicode categories | Unicode category count and frequencies | ⭐⭐ | Map characters to Unicode categories and count both the categories and the characters within them. |
| Unicode blocks | Unicode block count and frequencies | ⭐⭐ | Map characters to Unicode blocks and report counts by block and by character within each block. |
| Unicode scripts | Writing system count and frequencies | ⭐⭐ | Group character occurrences by Unicode script and count the scripts and the characters within them. |
| Word frequencies | Word frequencies | ⭐⭐⭐ | Normalize case, split on whitespace, strip leading and trailing punctuation, and count words after removing configured stop words. |
| Missingness patterns | Present counts, cell-level missingness flags and missingness correlations | ⭐⭐⭐ | Count present values by column, record whether each cell is missing, and correlate missingness flags across columns with varying missingness. |
| Automatic association | Association by column type | ⭐⭐⭐⭐ | Use rank correlation for numeric pairs and corrected Cramér’s V for pairs involving categorical or Boolean values. Bin numeric values in mixed pairs. |
| Kendall rank correlation | Kendall rank correlation | ⭐⭐⭐ | Measure rank association based on agreements and disagreements in pairwise order. |
| Categorical association | Corrected Cramér’s V | ⭐⭐⭐ | Build a contingency table for two categorical or Boolean columns and calculate the bias-corrected association strength. |
| Phi-K association | Phi-K association | ⭐⭐ | Calculate the association strength from binned contingency tables for eligible column pairs. |
| URL components | URL component frequencies | ⭐⭐ | Parse each URL and count schemes, network locations, paths, query strings and fragments separately. |
| Path components | Common path prefix and component frequencies | ⭐⭐ | Find the shared string prefix and count paths without extensions, extensions, basenames, parent directories and drive prefixes. |
| Path component cardinality | Distinct path components | ⭐⭐ | Count distinct values for each path component. |
| File sizes | File size and size histogram | ⭐⭐ | Read each file's size in bytes and bin the sizes into a histogram. |
| File timestamps | File timestamp frequencies | ⭐ | Summarize the frequencies of modification, access and metadata change timestamps from file metadata. |
| Image integrity and dimensions | Truncated image count and dimension frequencies | ⭐ | Count images that open but fail to load. Group successfully loaded images by width and height. |
| Image dimensions and area | Width, height and area summaries | ⭐ | Calculate the minimum, maximum, mean and median of widths, heights and pixel areas. |
| Image EXIF | EXIF tag and value frequencies | ⭐ | Count how often each EXIF tag appears and the frequency of each value within a tag. |
| Time index | Series count, observation count, index bounds and average step | ⭐⭐⭐ | Count time series and observations, find the minimum and maximum index, and take the mean absolute step between adjacent index values. |
| Stationarity and seasonality | ADF p-value, stationarity and seasonality | ⭐⭐ | Test for stationarity with ADF and detect periodic peaks in the frequency spectrum. The stationarity flag also takes seasonality into account. |
| Time gaps | Gap count, endpoints and length statistics | ⭐⭐⭐⭐ | Locate gaps from successive index intervals after dropping missing observations. Summarize gap lengths with their minimum, maximum, mean and sample standard deviation. |
| Autocorrelation | Autocorrelation and partial autocorrelation | ⭐⭐ | Calculate ACF and PACF coefficients and confidence intervals at each lag. |

</details>
