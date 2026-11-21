# 指标目录与计算口径

使用统一的 `ProfileResult` 协议和稳定指标 ID，提供表、列和列对级统计结果，供应用、数据平台及分析系统消费。

`createProfilingPlan` 默认保持原有 15 项。`profile` 默认使用导出的 `ALL_METRICS` 完整目录（149 个 ID，含别名），也支持 `metrics: []` 或所需 ID 的子集。结果只包含适用目标：表级 `columns: []`，单列 `[name]`，列对 `[a, b]`，每个无序列对只返回一次。

## 执行方式

AVA 接入可显式选择导出的只读 `BASIC_METRICS`：`row_count`、`null_count`、`distinct_count`、`top_values`、`min`、`max`、`mean`。该集合原生执行，不改变 `profile` 或 `createProfilingPlan` 的默认选择；去重和频数仍有基数相关成本。

原生计划可用 `decodeWithDiagnostics(row)` 返回 `{ results, skipped }`。跳过原因区分字段类型不适用的 `unsupported_type` 和高频值基数限制的 `cardinality_limit`；已计算但无定义的值继续返回带类型的 `null`。诊断不追加查询。详见 [AVA 接入说明](./ava.md)。

原生 SQL 批量计算基础统计、精确去重、方差/偏度/峰度、MAD、IQR、长度、普通数值分位、数值直方图、卡方统计量、频数、单例、布尔众数、类别失衡、重复组及 Pearson。其余算法按需使用 Python；数据通过临时 Parquet 交换，源数据不进入 JavaScript。频数、文本、URL/路径、文件和图像使用带权不同值，不重复展开整列。跨列相关和时序只导出必要原始列；内存指标导出参与画像的全部列。

Python 3.10+ 依赖见 `python-requirements.txt`。默认解释器为 `python3`，用 `python` 指定其他解释器。worker 复用导入，空闲 30 秒退出，不阻止 Node 进程结束；每次请求重新读取数据和文件。专项失败会拒绝整个请求并清理临时文件。

## 目录

| 指标族 | ID | 适用与定义 |
| --- | --- | --- |
| 表规模 | `row_count`, `column_count`, `column_type_counts` | 行数、原表实际列数、参与画像字段的类型计数。 |
| 表缺失 | `missing_cell_count`, `missing_cell_rate`, `columns_with_missing_count`, `all_missing_column_count` | 参与画像字段的缺失单元格和比例；至少一个缺失、全部缺失的列数。空表比例和列数为 0。 |
| 重复组 | `duplicate_group_count`, `duplicate_group_rate`, `duplicate_group_row_count` | 按参与画像字段分组，计数 ≥2 的组数、组数/总行数、各组行数列表（降序）。包括含 NULL 的组；NaN 与 NULL 合并。 |
| 列缺失 | `observation_count`, `present_count`, `missing_count`, `null_count`, `missing_rate` | 总观测、非缺失、缺失、缺失比例；空表比例为 0。 |
| 类型 | `profiling_type`, `declared_type`, `is_groupable`, `is_orderable` | schema/显式角色、数据库原生类型、DuckDB 是否支持分组、是否为可排序标量。 |
| 不同值与唯一性 | `distinct_count`, `distinct_rate`, `duplicate_count`, `singleton_count`, `singleton_rate`, `is_unique` | 非缺失不同值及比例；重复观测数；恰好出现一次的值及比例。比例分母为非缺失数量，空输入为 0；空列不唯一。 |
| 频数 | `value_counts`, `value_counts_by_value`, `top_values` | 完整非缺失频数按频数或原生值排序；高频值支持条数和基数比例阈值。 |
| 数值位置 | `min`, `max`, `mean`, `sum`, `median`, `range` | 原生聚合及极差。 |
| 数值离散/形状 | `stddev`, `stddev_samp`, `variance_samp`, `cv`, `skewness`, `excess_kurtosis`, `iqr`, `mad` | 样本标准差、样本方差、标准差/均值、校正偏度、校正超额峰度、P75-P25、中位绝对偏差。均值为 0 时 CV 为 null。 |
| 特殊数值 | `negative_count`, `negative_rate`, `zero_count`, `zero_rate`, `infinity_count`, `infinity_rate` | 负值含负无穷；零值；正负无穷。比例分母为全部观测。 |
| 分位/分布 | `quantiles`, `numeric_histogram`, `chi_squared_statistic`, `chi_squared_p_value` | 带权精确分位；有限数值直方图；类别频数或自动分箱相对均匀分布的卡方检验。 |
| 布尔/类别 | `boolean_mode`, `boolean_mode_count`, `category_imbalance_score` | 布尔众数及频次；1 − Shannon 熵/log2(类别数)，0 或 1 个类别时为 0。 |
| 时间范围 | `min_timestamp`, `max_timestamp`, `time_span` | 有限时间边界与纳秒跨度；支持 DATE、各 TIMESTAMP 精度和时区。 |
| 日期解析 | `invalid_date_distinct_count`, `invalid_date_count`, `invalid_date_rate`, `datetime_histogram` | 显式 date 角色可解析字符串；解析失败的不同值数、行数、行数/总观测；有效时间分布，边界 UTC。 |
| 字符串长度 | `min_length`, `max_length`, `mean_length`, `median_length`, `length_counts`, `length_histogram` | Unicode 字符长度及带权长度分布，保留空字符串和空白。 |
| 字符/词 | `character_count`, `distinct_character_count`, `character_counts`, `word_counts` | 带权字符频数；词按小写、空白切分，去首尾 ASCII 标点与空白，可排除停用词。 |
| Unicode 类别 | `unicode_category_distinct_count`, `unicode_category_frequencies`, `unicode_category_character_counts` | Unicode 类别数、频数、每类字符频数。 |
| Unicode 区块 | `unicode_block_distinct_count`, `unicode_block_frequencies`, `unicode_block_character_counts` | Unicode 区块数、频数、每区块字符频数。 |
| Unicode 脚本 | `unicode_script_distinct_count`, `unicode_script_frequencies`, `unicode_script_character_counts` | Unicode 脚本数、频数、每脚本字符频数。 |
| 相关性 | `pearson_r`, `spearman_rho`, `kendall_tau`, `cramers_v`, `phi_k`, `auto_correlation` | 数值 Pearson/Spearman/Kendall；经偏差校正 Cramér V；Phi-K；数值对用 Spearman、类别/混合对用 Cramér V 的自动选择。类别不同值须为 2–100；混合数值用 10 个等宽箱。 |
| URL | `url_scheme_counts`, `url_netloc_counts`, `url_path_counts`, `url_query_counts`, `url_fragment_counts` | 按 Python `urllib.parse.urlsplit` 拆分，带权统计。 |
| 路径 | `path_common_prefix`, `path_stem_counts`, `path_suffix_counts`, `path_basename_counts`, `path_parent_counts`, `path_drive_counts` | 依宿主平台 `os.path` 语义；公共字符前缀，无前缀时为 `No common prefix`。 |
| 路径基数 | `path_stem_distinct_count`, `path_suffix_distinct_count`, `path_basename_distinct_count`, `path_parent_distinct_count`, `path_drive_distinct_count` | 各路径部件的不同值数。 |
| 文件 | `file_size_bytes`, `file_size_histogram`, `file_modified_time_counts`, `file_access_time_counts`, `file_metadata_change_time_counts` | 每个不同路径的字节数及出现次数、带权大小分布；宿主本地时区、秒精度的 mtime/atime/ctime 频数。读取失败会报错。 |
| 图像 | `truncated_image_count`, `image_dimension_counts`, `duplicate_image_hash_count` | 能打开但加载失败的图像数、成功图像宽高频数、感知哈希的重复观测数。打不开的图像不进入尺寸统计。 |
| 图像尺寸 | `min_image_width`, `max_image_width`, `mean_image_width`, `median_image_width`, `min_image_height`, `max_image_height`, `mean_image_height`, `median_image_height`, `min_image_area`, `max_image_area`, `mean_image_area`, `median_image_area` | 成功图像的带权宽度、高度和像素面积聚合。 |
| EXIF | `exif_tag_counts`, `exif_value_counts` | 标签频数及标签下的值频数，值保留文本表示。 |
| 单调性 | `is_nondecreasing`, `is_nonincreasing`, `is_strictly_increasing`, `is_strictly_decreasing` | 按显式顺序、去掉缺失后判断；严格单调要求互异。 |
| 时序索引 | `time_series_count`, `time_index_observation_count`, `time_index_start`, `time_index_end`, `mean_time_index_step` | 时序列数、索引观测数、边界、相邻索引差绝对值的均值。 |
| 平稳/季节 | `adf_p_value`, `is_stationary`, `is_seasonal`, `seasonal_periods` | statsmodels ADF；SciPy FFT 峰值、离群阈值与谐波过滤；平稳要求通过 ADF 且无季节性。数据不足/常数无法检验时 ADF 返回 null。 |
| 缺口 | `gap_count`, `gap_endpoints`, `min_gap`, `max_gap`, `mean_gap`, `stddev_gap_samp` | 去掉缺失观测后，正索引间隔超过其均值 2 倍为缺口；包含端点及间隔聚合。无缺口统计为 0，单缺口标准差为 0。 |
| 自相关 | `acf`, `pacf` | statsmodels ACF（FFT）/PACF（Yule-Walker MLE）；返回滞后、系数和置信区间。 |
| 内存 | `table_memory_bytes`, `mean_row_memory_bytes`, `column_memory_bytes` | 导出列的 Pandas 表示的 `memory_usage`；表/列内存包含各自索引开销。 |

## 角色与配置

`types` 按列名显式指定 `numeric`、`categorical`、`text`、`boolean`、`date`、`url`、`path`、`file`、`image`、`timeseries`。不指定时，按数据库原生类型映射 Numeric/Categorical/Boolean/DateTime/Unsupported。角色需与原生类型兼容；date 可应用于字符串解析。file 也支持路径部件，image 也支持路径和文件统计。数值类型不因不同值较少而自动改成类别。

| 配置 | 默认值与约束 |
| --- | --- |
| `metrics` | 完整 `ALL_METRICS`；重复 ID 最后一项生效。除 `top_values` 的原有参数外，各配置使用下列顶层字段。 |
| `timeIndex` | 显式数值或时间索引；不允许缺失。无时序角色时，索引外的数值列作为时序列；否则只对显式 timeseries 列做专项检验。 |
| `orderBy` | 升序列名列表，优先于 `timeIndex` 排序；相同键需要调用方提供稳定的次级键。未提供顺序时跳过有序指标。 |
| `quantiles` | `[0.05, 0.25, 0.5, 0.75, 0.95]`，非空，取值在 `[0,1]`。 |
| `bins`, `maxBins`, `density` | `50`, `250`, `false`；箱数取不同值数、上限和请求数的最小值。`bins: 0` 使用 FD/Sturges 自动选择。常量列用单箱。箱边界为浮点数；density 返回概率密度。 |
| `stopWords` | `[]`，忽略大小写。 |
| `lags` | `100`；ACF/PACF 上限同时受有效序列长度 `n/2-1` 约束。 |
| `significance` | `0.05`，须在 `(0,1)`。 |
| `autolag`, `maxlag` | `AIC`，自动最大滞后；也支持 `BIC`、`t-stat` 或 null。 |
| `memoryDeep` | `false`，传递给 Pandas 内存测量。 |

`profile` 将浮点 NaN 视为缺失；±Infinity 参与边界、均值、求和和分位，直方图/卡方只使用有限值，含无穷的方差/偏度等返回 NaN。`createProfilingPlan` 默认 `semantics: 'finite'`，仅将 SQL NULL 计为缺失，数值聚合排除非有限值；`semantics: 'extended'` 使用前述 NaN 和无穷值口径。Pandas 与 DuckDB 的浮点聚合可能有末位误差；小数中位数及离散度沿用 DuckDB 原生精度。并列类别按原生值升序决定顺序和布尔众数。类型来自 schema 或显式角色。

频数输出为带类型的 `[{value, count}]`；分位是点位到值的对象；直方图为 `{counts, edges}`；文件大小为 `[{path, bytes, count}]`。上述结构的所有叶子继续使用 `MetricValue` 标签。图像哈希、EXIF、字符/词统计、精确去重和时序计算有相应的 CPU/内存/I/O 成本，只有选择这些指标时才会执行。

普通整数/浮点分位数使用 DuckDB 原生精确分位聚合，结果为浮点；大整数和小数使用带权插值保留精度。直方图用原生聚合，分箱边界采用 NumPy 的左闭右开、末箱含右端点规则；双精度舍入导致边界重合时合并对应分箱。箱数和滞后阶数等整数配置上限为 100000；自动卡方分箱超过该上限会报错。
