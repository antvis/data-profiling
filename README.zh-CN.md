[English](./README.md) | **简体中文**

# AVA 数据画像

AVA 数据画像是一个面向 DuckDB SQL 的数据画像项目，灵感来自 [fg-data-profiling](https://github.com/Data-Centric-AI-Community/fg-data-profiling)。从缺失值、取值频数到分布和重复组，统计结果都可以用 SQL 查询和复用。

> [!NOTE]
> 项目目前处于设计阶段。下面展示拟议的 AVA SQL 调用方式。

## 使用示例

假设 DuckDB 中有一张 `orders` 表，其中 `amount` 和 `quantity` 是数值列，`channel` 是文本列，`created_at` 是时间戳列。

```sql
SELECT * FROM ava_profile('orders');
```

这次调用覆盖适用于订单表的核心指标。表级统计给出行列数、各类型列数、重复组数及其比例，各列统计缺失值、取值频数和不同值数。数值列再算范围、基础聚合、分位数和直方图，`channel` 计算文本长度，`created_at` 计算时间范围。两列数值之间还会计算 Pearson 和 Spearman 相关性。

## 核心指标

**重要性**按各组统计对 AVA 通用画像的价值评估。五星是核心指标，四星常用于进一步排查，三星视场景使用，两星用于专项分析，一星适用于少数领域。

字段名和统计口径来自 FG 源码提交 `c27f8dc`。表格最后一列记录的是 FG 的默认行为。列级指标沿用 `variables.<列名>` 内的字段名。

| 范围 | 原始字段名 | 重要性 | 计算口径 | FG 默认或开启条件 |
| --- | --- | :---: | --- | --- |
| 表规模 | `table.n`, `table.n_var` | ⭐⭐⭐⭐⭐ | 输入行数和列数。 | Pandas、Spark 默认。 |
| 列类型 | `table.types` | ⭐⭐⭐⭐⭐ | 按画像识别出的类型统计列数。 | Pandas、Spark 默认。 |
| 重复组 | `table.n_duplicates`, `table.p_duplicates` | ⭐⭐⭐⭐⭐ | 包含两行及以上的组数，以及重复组数占总行数的比例。Pandas 按受支持的列分组，Spark 按所有列分组。 | Pandas、Spark 默认。`duplicates.head` 大于 0 才计算，最小配置设为 0。 |
| 列缺失 | `n`, `n_missing`, `p_missing`, `count` | ⭐⭐⭐⭐⭐ | 观测总数、缺失数、缺失比例、总数减缺失数。Pandas 汇总缺失分组。Spark 在匹配 `NULL` 或 `NaN` 时只取第一个缺失分组的计数。 | Pandas、Spark 默认。 |
| 取值频数 | `value_counts_without_nan`, `value_counts_index_sorted` | ⭐⭐⭐⭐⭐ | 非缺失值频数，以及按值排序的频数表。Spark 的排序字段取完整分组按值升序排列的前 200 组。 | Pandas、Spark 默认计算适用的字段。Pandas 在取值可排序时生成排序字段。 |
| 不同值 | `n_distinct`, `p_distinct` | ⭐⭐⭐⭐⭐ | 精确不同值数及比例。Pandas 使用非缺失分组，分母为非缺失值数。Spark 使用完整分组，分母为总行数，缺失分组可以计入。 | Pandas、Spark 默认。 |
| 数值位置与范围 | `min`, `max`, `mean`, `sum`, `range` | ⭐⭐⭐⭐⭐ | 最小值、最大值、均值、总和及极差。Pandas 的基础聚合可纳入无穷值。Spark 在这些聚合前排除 `NULL`、`NaN` 和正负无穷。 | Pandas、Spark 数值列默认。 |
| 分位数 | `5%`, `25%`, `50%`, `75%`, `95%` | ⭐⭐⭐⭐⭐ | 默认分位点的键名。Pandas 用 `Series.quantile`，Spark 用 `approxQuantile`，相对误差参数为 0.05。中位数保存在 50%。 | Pandas、Spark 数值列默认。`vars.num.quantiles` 决定生成哪些分位点。 |
| 数值分布 | `histogram` | ⭐⭐⭐⭐⭐ | 排除无穷后按频数加权分箱，保存箱值和边界。开启 `density` 时箱值为密度。 | Pandas、Spark 数值列默认在数据可分箱时计算。`plot.histogram` 控制分箱和密度。 |
| 日期时间范围 | `min`, `max`, `range` | ⭐⭐⭐⭐⭐ | 最早和最晚的有效日期时间，以及两者的跨度。Spark 在日期或时间戳列上聚合。 | Pandas、Spark 日期时间列默认。 |
| 字符串长度 | `min_length`, `max_length`, `mean_length`, `median_length` | ⭐⭐⭐⭐⭐ | 字符长度的最小值、最大值、按频数加权的均值和中位数。 | Pandas 类别列由 `vars.cat.length` 控制，Pandas、Spark 文本列由 `vars.text.length` 控制。普通配置均开启。 |
| 线性和秩相关 | `correlations.pearson`, `correlations.spearman` | ⭐⭐⭐⭐⭐ | Pearson 线性相关矩阵和 Spearman 秩相关矩阵。Spark 将符合条件的数值列组成向量，跳过向量组装器判为无效的行。 | Pandas 需打开相应的 `calculate` 开关。Spark 普通配置默认开启两项。 |

<details>
<summary>更多 FG 指标和配置（40 组）</summary>

FG 的最小配置关闭相关性、缺失图、重复检测和表中列出的卡方检验，也关闭类别列的长度、字符和词频统计。文本列有独立开关。FG 的探索配置开启 URL、路径、文件和图像识别。

| 范围 | 原始字段名 | 重要性 | 计算口径 | FG 默认或开启条件 |
| --- | --- | :---: | --- | --- |
| 表缺失 | `table.n_cells_missing`, `table.p_cells_missing` | ⭐⭐⭐⭐ | 各列缺失数之和，以及该总数占全部单元格的比例。 | Pandas、Spark 默认。 |
| 表缺失 | `table.n_vars_with_missing`, `table.n_vars_all_missing` | ⭐⭐⭐⭐ | 至少有一个缺失值的列数，以及全部值都缺失的列数。 | Pandas、Spark 默认。 |
| 表内存 | `table.memory_size`, `table.record_size` | ⭐⭐ | DataFrame 内存用量总和，以及平均每行的内存用量。 | Pandas 默认。`memory_deep` 为 true 时使用深度内存统计。 |
| 重复组频次 | `duplicates`, `# duplicates` | ⭐⭐⭐⭐ | 返回频次最高的重复组及各组行数。计数列名由 `duplicates.key` 指定。 | Pandas、Spark 默认。`duplicates.head` 默认为 10，限制返回的组数。 |
| 列分类 | `type`, `cast_type`, `hashable`, `ordering` | ⭐⭐⭐⭐ | 画像类型、调用方声明的列类型、取值能否进行哈希计数，以及频数表能否按取值排序。 | 两后端都返回 type。Pandas 在声明列类型时记录 `cast_type`，并在计数时填写 `hashable` 和 `ordering`。Spark 的 `cast_type` 为空。 |
| 列内存 | `memory_size` | ⭐⭐ | Pandas Series 内存用量。Spark 的同名字段固定填 0。 | Pandas 默认实算，`memory_deep` 调整统计口径。 |
| 单例与唯一性 | `n_unique`, `p_unique`, `is_unique` | ⭐⭐⭐⭐ | 频次恰好为 1 的组数、对应比例和唯一性标记。Pandas 使用非缺失值，判定唯一时要求至少有一个非缺失值。Spark 使用完整分组和总行数。 | Pandas、Spark 默认。 |
| 数值离散程度 | `variance`, `std`, `cv` | ⭐⭐⭐⭐ | 样本方差、样本标准差、标准差除以均值。均值为零时 cv 为 `NaN`。 | Pandas、Spark 数值列默认。 |
| 数值形状 | `skewness`, `kurtosis` | ⭐⭐⭐ | 偏度和超额峰度。Pandas 使用 Series 方法，Spark 使用原生聚合。 | Pandas、Spark 数值列默认。 |
| 特殊数值 | `n_negative`, `p_negative`, `n_zeros`, `p_zeros`, `n_infinite`, `p_infinite` | ⭐⭐⭐⭐ | 负值、零值及正负无穷合计的计数与比例。比例以观测总数为分母。负无穷也计入负值。 | Pandas、Spark 数值列默认。 |
| 稳健离散程度 | `iqr`, `mad` | ⭐⭐⭐⭐ | IQR 是 P75 减 P25。MAD 是各值与中位数的绝对偏差的中位数。Spark 用近似分位数计算 MAD。 | Pandas、Spark 数值列默认。IQR 依赖 P25 和 P75，Spark 的 MAD 还依赖 P50。 |
| 数值单调性 | `monotonic_increase`, `monotonic_decrease`, `monotonic_increase_strict`, `monotonic_decrease_strict`, `monotonic` | ⭐⭐⭐ | 按序列顺序判断递增和递减。严格单调还要求取值唯一。综合编码为严格递增 2、严格递减 −2、非严格递增 1、非严格递减 −1，其余为 0。 | Pandas 数值列默认。Spark 的 `monotonic` 固定填 0。 |
| 卡方检验 | `chi_squared.statistic`, `chi_squared.pvalue` | ⭐⭐ | 基于观测频数计算卡方统计量和 p 值。数值和日期先分箱，类别列使用各类别频次。 | Pandas 对这些类型默认计算，触发条件是 `vars.num.chi_squared_threshold` 大于 0，类别列也走这个条件。最小配置设为 0。 |
| 布尔众数 | `top`, `freq` | ⭐⭐⭐ | 最高频值及其次数。Pandas 使用非缺失值频数。Spark 取完整频数表的第一组，可能取到缺失组。 | Pandas、Spark 布尔列默认。 |
| 类别失衡 | `imbalance` | ⭐⭐⭐ | 用 1 减去归一化 Shannon 熵，归一化分母是观测类别数的 log₂。只有一个类别时返回 0。 | Pandas 类别列和布尔列默认。 |
| 无效日期 | `invalid_dates`, `n_invalid_dates`, `p_invalid_dates` | ⭐⭐⭐⭐ | 非缺失但解析失败的不同值数、解析失败的行数及其占总行数的比例。 | Pandas 日期时间列默认实算。Spark 的三个字段固定填 0。 |
| 日期时间分布 | `histogram` | ⭐⭐⭐⭐ | 将日期时间转为数值时间戳后分箱。 | Pandas、Spark 日期时间列默认。 |
| 字符串长度分布 | `length_histogram`, `histogram_length` | ⭐⭐⭐ | 每个整数长度的精确频数，以及将这些长度频数再分箱得到的直方图。 | 与字符串长度共用开关。 |
| 字符频数 | `n_characters`, `n_characters_distinct`, `character_counts` | ⭐⭐⭐ | 字符出现总次数、不同字符数和各字符频次。 | Pandas 类别列由 `vars.cat.characters` 控制，Pandas、Spark 文本列由 `vars.text.characters` 控制。普通配置均开启。 |
| Unicode 类别 | `category_alias_values`, `category_alias_counts`, `n_category`, `category_alias_char_counts` | ⭐⭐ | 字符到 Unicode 类别的映射、各类别频次、类别数及各类别内部的字符频次。 | 与字符频数共用开关。 |
| Unicode 区块 | `block_alias_values`, `block_alias_counts`, `n_block_alias`, `block_alias_char_counts` | ⭐⭐ | 字符到区块缩写的映射、各区块频次、区块数及各区块内部的字符频次。 | 与字符频数共用开关。 |
| Unicode 书写系统 | `script_counts`, `n_scripts`, `script_char_counts` | ⭐⭐ | 各书写系统的字符总频次、书写系统数及各系统内部的字符频次。 | 与字符频数共用开关。缺少 Unicode 分类依赖时，部分分类归为 (unknown)。 |
| 词频 | `word_counts` | ⭐⭐⭐ | 转小写、按空白切词、去除词两端的标点、过滤停用词，再统计词频。有结果时才写入该字段。 | Pandas 类别列由 `vars.cat.words` 控制，Pandas、Spark 文本列由 `vars.text.words` 控制。普通配置均开启。停用词用 `vars.cat.stop_words`，Spark 返回条数由 `vars.text.spark_words_limit` 限制。 |
| 缺失图统计 | `missing.bar`, `missing.matrix`, `missing.heatmap` | ⭐⭐⭐ | Pandas 分别用逐列非缺失计数、逐格的非缺失标记，以及缺失标记的 Pearson 相关矩阵生成图。热图排除全不缺和全缺的列。 | Pandas 普通配置默认开启，热图需要至少两列部分缺失。Spark 普通配置和最小配置会关闭这些图。 |
| 自动关联 | `correlations.auto` | ⭐⭐⭐⭐ | 数值列对用 Spearman。含类别列或布尔列的配对用校正 Cramér’s V，混合配对中的数值列先做等宽分箱。 | Pandas 默认，至少两列符合条件时才产出矩阵。最小配置关闭。 |
| Kendall 秩相关 | `correlations.kendall` | ⭐⭐⭐ | 数值列的 Kendall 相关矩阵。 | Pandas 需将 `correlations.kendall.calculate` 设为 true。 |
| 类别关联 | `correlations.cramers` | ⭐⭐⭐ | 对符合条件的类别列和布尔列构造列联表，计算校正 Cramér’s V。 | Pandas 需将 `correlations.cramers.calculate` 设为 true。 |
| Phi-K 关联 | `correlations.phi_k` | ⭐⭐ | 对符合条件的非常量列计算 Phi-K 矩阵，将数值列作为区间变量。 | Pandas 需将 `correlations.phi_k.calculate` 设为 true。当前 Spark 的实现名为 `phi_k_compute`，分派查找的是 `phik_compute`，标准流程无法调用。 |
| URL 部件 | `scheme_counts`, `netloc_counts`, `path_counts`, `query_counts`, `fragment_counts` | ⭐⭐ | 用 `urlsplit` 拆出协议、网络位置、路径、查询串和片段，各自计频。 | Pandas 需开启 `vars.url.active`，并识别到 URL 列。 |
| 路径部件 | `common_prefix`, `stem_counts`, `suffix_counts`, `name_counts`, `parent_counts`, `anchor_counts` | ⭐⭐ | 字符串公共前缀，以及去掉最后一个扩展名的路径、扩展名、文件名、父目录和驱动器部分的频次。 | Pandas 需开启 `vars.path.active`，并识别到 Path、File 或 Image 列。 |
| 路径部件基数 | `n_stem_unique`, `n_suffix_unique`, `n_name_unique`, `n_parent_unique`, `n_anchor_unique` | ⭐⭐ | 分别统计五张部件频数表中的不同值数。 | 与路径部件共用开关。 |
| 文件大小 | `file_size`, `histogram_file_size` | ⭐⭐ | 从 `os.stat().st_size` 读取每个文件的字节数，再做大小直方图。 | Pandas 需开启 `vars.path.active` 和 `vars.file.active`，并识别到 File 或 Image 列。 |
| 文件时间 | `file_created_time`, `file_accessed_time`, `file_modified_time` | ⭐ | 把 `st_ctime`、`st_atime`、`st_mtime` 转为本地时间字符串。在 Unix 上，`st_ctime` 是元数据变更时间。报告再对这些字符串计频。 | 与文件大小共用开关。 |
| 图像完整性与尺寸 | `n_truncated`, `image_dimensions` | ⭐ | 已打开但加载失败的图像数，以及成功加载的图像的宽高组合。报告可对宽高组合计频。 | Pandas 需开启路径、文件和图像识别，并识别到 Image 列。 |
| 图像宽高与面积 | `min_width`, `max_width`, `mean_width`, `median_width`, `min_height`, `max_height`, `mean_height`, `median_height`, `min_area`, `max_area`, `mean_area`, `median_area` | ⭐ | 分别对宽度、高度和宽乘高得到的面积计算最小值、最大值、均值和中位数。 | 图像分析启用后计算。 |
| 图像 EXIF | `exif_keys_counts`, `exif_data` | ⭐ | EXIF 标签出现次数，以及每个标签各取值的频数。 | 启用图像分析且 `vars.image.exif` 为 true 时计算。该子开关在普通配置中默认开启。 |
| 时序索引 | `time_index_analysis.n_series`, `time_index_analysis.length`, `time_index_analysis.start`, `time_index_analysis.end`, `time_index_analysis.period` | ⭐⭐⭐ | TimeSeries 列数、输入观测数、索引的最小值和最大值，以及相邻索引差绝对值的均值。 | Pandas 需将 `tsmode` 设为 true，且索引是数值或日期时间。 |
| 平稳性与季节性 | `addfuller`, `stationary`, `seasonal` | ⭐⭐ | ADF 检验的 p 值、平稳性标记和季节性标记。平稳要求 p 值低于显著性阈值且没有季节性，季节性由 FFT 峰值检测得到。 | Pandas 需将 `tsmode` 设为 true，并识别到 TimeSeries 列。ADF 使用 `autolag`、`maxlag` 和 `significance`。 |
| 时序缺口 | `gap_stats.n_gaps`, `gap_stats.gaps`, `gap_stats.min`, `gap_stats.max`, `gap_stats.mean`, `gap_stats.std` | ⭐⭐⭐⭐ | 剔除缺失观测后，超过正间隔均值两倍的正间隔记为缺口。记录缺口数、两端索引，以及长度的最小值、最大值、均值和样本标准差。 | Pandas 时序列启用后计算。 |
| 时序自相关图 | `ACF`, `PACF` | ⭐⭐ | 各滞后的自相关、偏自相关和置信区间。原生图表用 FFT 算 ACF，用 ywm 算 PACF，alpha 为 0.05。滞后数受 `pacf_acf_lag` 和样本长度限制。 | Pandas 生成时序图时计算。ACF 和 PACF 是图表标签。 |

### 源码细节

- 图像辅助函数收到 `hash=True` 时可计算 `n_duplicate_hash`。标准图像分析只传入 EXIF 设置。
- 时序索引结果声明了 `frequency`，当前留空。季节性辅助函数会找出候选周期，列摘要保留 `seasonal` 标记。

</details>
