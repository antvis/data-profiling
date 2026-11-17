[English](./README.md) | **简体中文**

# AVA 数据画像

AVA 数据画像在 DuckDB 中用 SQL 计算数据集统计。先看行数、字段类型和基础聚合，需要深入时再请求频数、分布或列对统计。派生指标复用这些结果。

项目灵感来自 `fg-data-profiling` 一次调用即可开展探索性数据分析的做法。[fg-data-profiling](https://github.com/Data-Centric-AI-Community/fg-data-profiling)

> [!NOTE]
> 这份 README 说明拟议的 SQL 接口和实现计划。

## 用法

把表名或视图名传给 `ava_profile()`。要分析文件、筛选后的数据或多表连接结果，可以先定义一个视图。

```sql
CREATE TEMP VIEW orders AS
SELECT * FROM read_parquet('orders.parquet');

SELECT * FROM ava_profile('orders');
```

可以按需指定字段或请求额外统计。是否计算精确频数摘要，以及分位数采用哪种精度，可以分别设置。

```sql
SELECT *
FROM ava_profile(
    'orders',
    columns := ['amount', 'channel'],
    options := '{"frequency_summary":true,"quantiles":[0.25,0.5,0.75],"quantile_method":"continuous"}'
);
```

需要明细时，指定要执行的分析。下面的示例返回一个字段的频数表。

```sql
SELECT *
FROM ava_profile(
    'orders',
    analysis := 'frequencies',
    columns := ['channel'],
    options := '{"order":"frequency_desc","limit":5}'
);
```

## 指标目录

**首版默认**表示运行 `ava_profile(source)` 时直接计算。**首版按需**表示首版通过指定分析或选项提供。**后续支持**表示计划在后续版本实现。

表格从基础计数和聚合开始，往下是取值频数、分布、列对和有序观测。末尾列出基于这些结果可以做的对比，以及可以直接推出的状态。

| 范围 | 指标 | 基础量与统计口径 | 可派生或支持的分析 | 阶段 |
| --- | --- | --- | --- | --- |
| **表结构** | `column_name`, `column_type`, `column_position`, `logical_type` | 读取 DuckDB 解析后的表或视图结构，并将原生类型映射为画像类型。 | 选择字段，并按字段类型选择聚合方式。 | 首版默认 |
| 表结构 | `column_count`, `profiled_column_count`, `column_type_counts` | 分别统计总列数、参与画像的列数和各类型的列数。 | 表宽、类型分布和表级缺失指标的分母。 | 首版默认 |
| **行与单元格** | `row_count` | 统计输入表或视图的全部行。 | 比例的分母、空表判断和批次规模。 | 首版默认 |
| 行与单元格 | `cell_count` | 用行数乘以参与画像的列数。 | 单元格级比例的分母。 | 首版默认 |
| **缺失值** | `null_count`, `nan_count` | 分别统计 SQL NULL 和浮点 NaN。 | 区分 SQL 空值和浮点非数值。 | 首版默认 |
| 缺失值 | `missing_count`, `present_count` | 缺失数为 NULL 数与 NaN 数之和。总行数减缺失数得到非缺失值数。 | 缺失率和取值频率的分母。 | 首版默认 |
| 缺失值 | `null_rate`, `missing_rate`, `present_rate` | 把各自的计数除以总行数。 | 在列、分组或批次之间比较。 | 首版默认 |
| 缺失值 | `missing_cell_count`, `missing_cell_rate` | 将参与画像的各列缺失数相加，再除以单元格总数得到缺失率。 | 表级缺失程度。 | 首版默认 |
| 缺失值 | `rows_with_missing_count`, `complete_row_count` | 任一选中字段缺失的行只计一次，其余为完整行。 | 各字段均完整的样本量。 | 首版按需 |
| 缺失值 | `sentinel_count`, `sentinel_rate` | 统计调用方指定的占位值，例如 N/A 或 -999，再除以总行数得到比例。 | 衡量占位写法涉及多少数据。 | 首版按需 |
| **特殊数值** | `positive_infinity_count`, `negative_infinity_count`, `infinity_count`, `infinity_rate` | 分别统计正负无穷，再加总得到无穷值数。比例以总行数为分母。 | 无穷值的数量及其占全部行的比例。 | 首版默认 |
| 特殊数值 | `finite_count`, `finite_rate` | 从数值列的非缺失值数中扣除无穷值数。比例以总行数为分母。 | 数值统计和分布分析的有效样本覆盖率。 | 首版默认 |
| **数值聚合** | `min`, `max`, `range` | 对有限数值取最小值、最大值，两者相减得到极差。 | 取值边界、跨度，以及有限值是否恒定。 | 首版默认 |
| 数值聚合 | `sum`, `mean` | 在同一批有限数值上执行 DuckDB 的 SUM 和 AVG。 | 总量和中心位置。可用各批总和及有限值数合成全量均值。 | 首版默认 |
| 数值聚合 | `variance_samp`, `stddev_samp`, `cv` | 计算样本方差，再开平方得到样本标准差。变异系数是样本标准差除以均值。 | 绝对离散程度，以及零点有实际意义时的相对离散程度。 | 首版默认 |
| 数值聚合 | `zero_count`, `negative_count`, `positive_count`, `zero_rate`, `negative_rate`, `positive_rate` | 对有限数值做条件计数，再除以有限值数得到各自的比例。 | 零值集中度、正负分布和取值范围检查的依据。 | 首版默认 |
| 数值聚合 | `skewness`, `excess_kurtosis` | 使用 DuckDB 的矩统计聚合计算偏度和超额峰度，并记录有效值数。 | 分布的非对称程度和尾部特征。 | 首版按需 |
| **布尔值** | `true_count`, `false_count`, `true_rate`, `false_rate` | 分别统计真值和假值，比例以非缺失值数为分母。 | 布尔值分布和二分类标签占比。 | 首版默认 |
| **文本长度** | `empty_count`, `blank_count` | 分别统计空字符串和非空但仅由空白字符组成的字符串。 | 分别识别空字符串、空白字符串和 SQL NULL。 | 首版默认 |
| 文本长度 | `min_length`, `max_length`, `mean_length` | 对字符长度做数值聚合，长度为零的字符串也计入。 | 长度范围和恒定长度检查。 | 首版默认 |
| **日期与时间戳** | `min_timestamp`, `max_timestamp`, `time_span` | 对有效且有限的日期或时间戳取最早值、最晚值并计算跨度。 | 观测覆盖的时间范围和批次边界。 | 首版默认 |
| **取值频数** | `approx_distinct_count` | 对非缺失值做 DuckDB 近似去重计数，并标记为估算值。 | 快速了解高基数列有多少种取值。 | 首版按需 |
| 取值频数 | `value_counts` | 对非缺失值分组，精确统计每组的频次。 | 精确不同值数、单例值、众数和高低频值的共同基础。 | 首版按需 |
| 取值频数 | `distinct_count`, `distinct_rate` | 统计取值分组数，再除以非缺失值数得到比例。 | 类别规模和候选键检查。 | 首版按需 |
| 取值频数 | `singleton_count`, `singleton_rate` | 统计频次恰好为 1 的取值组，再除以非缺失值数得到比例。 | 取值只出现一次的观测占比。 | 首版按需 |
| 取值频数 | `is_unique`, `is_constant` | 要求至少有一个非缺失值。精确不同值数等于非缺失值数时为唯一，精确不同值数为 1 时为常量。 | 非缺失值范围内的唯一性和恒定性。 | 首版按需 |
| 取值频数 | `value_rate`, `top_values`, `bottom_values` | 用每个值的频次除以计入分析的值数。按频次排序，同频时按固定规则排序。 | 类别占比、前 K 项覆盖率和低频值。 | 首版按需 |
| 取值频数 | `mode`, `mode_count`, `mode_rate` | 复用频次最高的值及其计数和占比。同频时沿用频数表中的取值排序。 | 主要取值及其集中程度。 | 首版按需 |
| 取值频数 | `low_values`, `high_values` | 按有限数值的取值大小排序，查看两端的值及其精确频次。 | 区分偶发极值和反复出现的边界值。 | 首版按需 |
| 取值频数 | `rare_value_count`, `rare_row_rate` | 按指定的低频阈值，计算符合条件的取值数和这些值覆盖的行占比。 | 衡量类别有多稀少，以及涉及多少数据。 | 后续支持 |
| 取值频数 | `category_imbalance`, `category_uniformity` | 用明确的方法分析频数表，评估类别的集中程度或均匀性。 | 检查标签和类别分布。 | 后续支持 |
| 取值频数 | `normalized_value_counts`, `variant_groups` | 按显式规则标准化后重新分组，保留原始值、标准化结果和频次。 | 发现大小写、空格、格式及疑似拼写变体。 | 后续支持 |
| **数值分布** | `quantiles` | 对有限数值计算指定分位数，并记录使用精确连续分位数、精确离散分位数还是近似算法。 | 中位数、四分位数和尾部分位数。 | 首版按需 |
| 数值分布 | `median`, `iqr` | 用 P50 表示中位数。同时请求 P25 和 P75 时，用 P75 减 P25 得到四分位距。 | 稳健的中心位置、离散程度和 IQR 围栏。 | 首版按需 |
| 数值分布 | `histogram` | 对有限数值分箱计数，保留箱边界、端点归属规则和界外计数。 | 直方图、分箱占比、分布形状及同分箱对比。 | 首版按需 |
| 数值分布 | `below_threshold_count`, `above_threshold_count` | 按调用方给定的上下界对有限值计数。上下界也可以由先前的画像结果算出。 | 实际尾部计数、越界数量和 IQR 围栏外的数量。 | 首版按需 |
| 数值分布 | `mad` | 先计算各值与中位数的绝对偏差，再取这些偏差的中位数。 | 稳健的离散程度和基于 MAD 的离群值候选。 | 后续支持 |
| 数值分布 | `uniformity_statistic`, `uniformity_p_value` | 依据明确的期望分布和分箱做检验，记录样本量和方法。 | 检验指定的均匀分布假设。 | 后续支持 |
| **分组计数** | `group_counts` | 按指定列或整行分组，精确统计每组行数。 | 键组合、重复组和重复行数。 | 首版按需 |
| 分组计数 | `key_missing_rows` | 统计所选键的任一组成列缺失的行数。 | 配合精确唯一性检查判断候选键是否完整。 | 首版按需 |
| 分组计数 | `duplicate_group_count`, `rows_in_duplicate_groups`, `duplicate_rows`, `duplicate_rate` | 对行数大于 1 的组分别计组数、加总组内行数和每组扣除一行后的行数。重复率以参与分组的行数为分母。 | 区分落在重复组里的全部行与每组多出的行。 | 首版按需 |
| 分组计数 | `near_duplicate_groups`, `near_duplicate_rows` | 指定字段、相似度方法和阈值，形成候选重复组。 | 定位部分取值不同但内容相似的记录。 | 后续支持 |
| **缺失列对** | `missing_pair_counts` | 对每对指定列统计 n00、n01、n10、n11。第一位表示左列，1 表示缺失。 | 保留两列各自和共同缺失的情况。 | 首版按需 |
| 缺失列对 | `co_missing_count`, `co_missing_rate` | 用 n11 表示共同缺失数，再除以参与计算的行数得到共同缺失率。 | 两列同时缺失涉及的行数和占比。 | 首版按需 |
| 缺失列对 | `conditional_missing_rate`, `missingness_correlation` | 用相应的单列缺失数计算条件缺失率。例如右列缺失时左列也缺失的比例为 n11 除以 n01 与 n11 之和。缺失相关性对两列缺失标记计算。 | 对照各列整体缺失情况，看缺失是否集中在同一批行。 | 首版按需 |
| 缺失列对 | `missing_row_patterns`, `sample_missing_mask` | 按所选列的缺失标记组合分组，或为显式限定的样本返回逐个单元格的缺失标记。 | 常见缺失模式和缺失矩阵。 | 后续支持 |
| **数值列对** | `pair_valid_count`, `pair_coverage` | 统计两列都为有限值的行数，再除以输入总行数得到覆盖率。 | 协方差和相关系数的有效样本量。 | 首版按需 |
| 数值列对 | `covariance_samp`, `pearson_r` | 用同一批有效配对计算样本协方差和 Pearson 相关系数。有效配对不足或任一列方差为零时，相关系数返回 NULL。 | 线性关联和列对比较。 | 首版按需 |
| **列间关系** | `spearman_rho`, `kendall_tau` | 在共同有效的观测上计算秩关联，并明确并列值的处理规则。 | 顺序关系和单调关联。 | 后续支持 |
| 列间关系 | `joint_value_counts`, `cramers_v` | 对两列取值联合分组，从列联表计算 Cramér’s V。混合类型列对先明确数值分箱。 | 类别关联和混合类型关联。 | 后续支持 |
| 列间关系 | `phi_k`, `association_method` | 按明确定义的方法从联合分布计算 Phi-K。自动选择算法时，记录每对列使用的方法。 | 便于比较和核对口径的关联矩阵。 | 后续支持 |
| 列间关系 | `joint_histogram`, `paired_sample` | 统计联合分箱，或返回行数明确受限的有效配对样本。 | 联合分布、散点图和变量交互。 | 后续支持 |
| **有序观测** | `adjacent_step_counts`, `monotonicity` | 明确排序键和并列顺序之后，统计相邻值上升、下降和持平的次数。 | 严格和非严格单调性。 | 后续支持 |
| 有序观测 | `time_step_distribution`, `gap_count`, `max_gap` | 计算相邻时间戳之差，再根据声明的预期间隔判断时间缺口。 | 时间索引覆盖范围和缺失观测区间。 | 后续支持 |
| 有序观测 | `lag_pair_count`, `acf`, `pacf` | 在定义好的序列和滞后集合上计算统计量，记录覆盖率、缺失处理和算法。 | 滞后关系、候选周期和时序图数据。 | 后续支持 |
| 有序观测 | `stationarity_statistic`, `stationarity_p_value`, `seasonality` | 明确算法和参数，例如用 ADF 检查平稳性，并指定检测周期性的方法。 | 平稳性和季节性信号。 | 后续支持 |
| **类型与格式推断** | `inferred_type`, `type_match_count`, `type_match_rate` | 用明确的规则检测类型，记录检测数和命中数，允许手动覆盖类型。 | 识别数值类别、疑似日期或布尔值的文本、自由文本、URL、路径、文件和图像。 | 后续支持 |
| 类型与格式推断 | `parse_success_count`, `parse_failure_count`, `parse_failure_rate` | 按指定目标类型和格式尝试解析，需要时明确时区，同时记录尝试解析的值数。 | 检查格式是否一致，定位无法解析为日期、数值或布尔值的文本。 | 后续支持 |
| **日期分布** | `time_bucket_counts` | 按明确的粒度、边界和时区对时间戳分组计数。 | 日期和时间戳直方图，以及各时间段的数据量。 | 后续支持 |
| **文本分布** | `median_length`, `length_histogram` | 把字符串长度作为数值，复用分位数和分箱计算。 | 文本长度的分布情况。 | 后续支持 |
| 文本分布 | `word_counts`, `character_counts` | 提取词或字符，按需要应用指定的大小写和停用词规则，再统计频次。 | 词频和字符频次。 | 后续支持 |
| 文本分布 | `unicode_category_counts`, `unicode_script_counts`, `unicode_block_counts` | 将字符映射到 Unicode 类别、书写系统或区块，再汇总计数。 | 文字系统构成与字符模式。 | 后续支持 |
| **数据源元数据** | `storage_bytes`, `column_storage_bytes`, `bytes_per_row` | 读取数据源提供的存储元数据，并说明口径，例如压缩后的物理字节数。 | 表和列的存储占用。 | 后续支持 |
| 数据源元数据 | `url_component_counts`, `path_component_counts` | 把组成部分解析成列，再复用取值频数计算。 | 协议、主机、目录、文件名和扩展名的分布。 | 后续支持 |
| 数据源元数据 | `file_size_distribution`, `file_timestamp_range` | 统计 SQL 可读的文件大小、创建时间和修改时间。 | 文件大小和时间戳的分布。 | 后续支持 |
| 数据源元数据 | `image_dimension_distribution`, `truncated_image_count`, `exif_counts` | 从 SQL 可查询的元数据关系中读取图像尺寸、截断标记和选定的 EXIF 字段，再做聚合。 | 图像尺寸分布和元数据覆盖情况。 | 后续支持 |
| **画像元数据** | `profile_scope`, `method`, `is_approximate` | 记录数据来源、参与画像的列、适用的统计范围、计算方法和近似标记。 | 核对统计口径，并比较口径相同的结果。 | 首版默认 |
| **画像对比** | `metric_delta`, `category_delta`, `bin_delta` | 对齐统计范围和口径一致的画像结果，再比较指标、类别和相同分箱内的计数。 | 行数与缺失率变化、新增或消失的类别，以及分布变化。 | 后续支持 |
| **派生状态** | `is_empty`, `is_all_missing`, `is_constant_length` | 根据行数、非缺失值数和长度上下界派生。整列缺失要求表中有行，恒定长度要求至少有一个实际字符串。 | 默认画像可直接提供的精确状态。 | 首版默认 |
| **派生检查** | `check_result` | 用明确的阈值或基准比较观测指标，并保留指标值、统计范围和分母。 | 高缺失、高基数、偏态、高相关和重复等检查的依据。 | 首版按需 |

### 计数口径与精度

- **计数和比例。** 行数以输入表或视图为范围。表级缺失指标按参与画像的列计算。缺失包括 SQL `NULL` 和浮点 `NaN`。无穷值单独计数，仍属于非缺失值。比例取值为 0 到 1，分母为零时返回 `NULL`。
- **有效数值范围。** 数值聚合、直方图和数值相关性使用有限值。样本方差和样本协方差至少需要两个有效观测。均值为零时，变异系数返回 `NULL`。
- **频数和重复。** 频数摘要使用非缺失值。重复分组沿用 DuckDB 的 `GROUP BY` 规则，对应位置同为空值的键也会归到同一组。检查候选键时，需要同时验证完整性和唯一性。
- **精度和统计范围。** 记录计算方法，并标记估算值及由估算值派生的指标。唯一性使用精确计数。跨批次可以合并分组计数，或合并边界一致的分箱计数。要合成全量基数或分位数，需要原数据或可合并的聚合状态。
- **检查。** 底层库提供指标和精确状态。调用方可以在 SQL 中结合业务规则、阈值或基准做判断。

## SQL API

`ava_profile(source, analysis := 'summary', columns := [], options := '{}')`

`source` 指定表名或视图名，`analysis` 选择本次要执行的分析，`columns` 指定输入列，`options` 是用于该分析的 JSON 参数对象。

| 分析 | 输入与选项 | 返回结果 |
| --- | --- | --- |
| `summary` | 列列表为空时选择所有列。可通过 `row_completeness`、`moments`、`approx_distinct` 和 `frequency_summary` 请求额外统计。`sentinels` 指定各列的占位值，`bounds` 指定各数值列的上下界。请求 `quantiles` 时，可用 `quantile_method` 选择 `continuous`、`discrete` 或 `approximate`，默认使用 `continuous`。 | 每项指标一行，包含 `column_name`、`column_type`、`metric`、`value`（JSON）、`method` 和 `is_approximate`。表级指标的列名和列类型为 `NULL`。`frequency_summary` 复用每列的频数，推出精确不同值数、单例值数、唯一性、恒定性和众数。 |
| `histogram` | 选择一个数值列。用 `bins` 请求分箱数，或用 `bin_edges` 指定可在不同批次使用的分箱边界。 | 每个分箱一行，包含 `lower_bound`、`upper_bound`、`bucket_kind` 和 `value_count`。适用时另返回低于或高于边界的分箱。 |
| `frequencies` | 选择一列。`order` 支持 `frequency_desc`、`frequency_asc`、`value_asc` 和 `value_desc`。`limit` 默认为 10，传 JSON `null` 时返回完整频数表。`finite_only` 将数值频数限定在有限值内。 | 每个返回的值占一行，包含原生 SQL 类型的 `value`、精确频次 `value_count` 和它在纳入统计的值中所占的比例 `value_rate`。 |
| `duplicates` | 指定键列，或留空以按整行分组。`output` 默认为 `summary`，设为 `groups` 时请求底层分组计数。 | 摘要模式返回一行，包含 `row_count`、`key_missing_rows`、`duplicate_group_count`、`rows_in_duplicate_groups`、`duplicate_rows` 和 `duplicate_rate`。分组模式每组一行，包含 `group_key` 和 `row_count`。 |
| `missingness` | 显式指定至少两列。 | 每对列一行，包含 `left_column`、`right_column`、`n00`、`n01`、`n10`、`n11`、`co_missing_rate`、`left_missing_given_right`、`right_missing_given_left` 和 `missingness_correlation`。 |
| `correlations` | 显式指定至少两个数值列。首版使用 Pearson 相关。 | 每对列一行，包含 `left_column`、`right_column`、`pair_valid_count`、`pair_coverage`、`covariance_samp` 和 `pearson_r`。 |

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

指标目录既列出了具体指标，也列出了频数表这类结果的名称。DuckDB 绑定查询时，根据分析名选择返回结构，并校验参数。后续能力会在实现相应计算时定义调用方式。

## 报告与交互

DuckDB 负责计算统计，并以查询结果的形式提供给调用方。AVA 或其他客户端可以用这些结果生成报告并提供交互。

| 能力 | 交付方式 |
| --- | --- |
| **SQL 与结构化导出** | 首版提供。可用 DuckDB 查询和保存结果，也可以导出为 JSON 或 CSV。 |
| **报告与图表** | 后续由客户端提供。把 SQL 结果渲染为指标表、分布、缺失情况、相关性和发现。 |
| **样本和重复行预览** | 后续由客户端提供。显式请求带行数上限的预览，并控制是否展示原始值。 |
| **数据集对比** | 后续由客户端提供。使用 DuckDB 计算出的对比结果，并排展示口径一致的画像。 |
| **HTML 与 Notebook** | 后续由客户端提供。支持独立 HTML 导出和可嵌入 Notebook 的视图。 |
| **交互式探索** | 后续由客户端提供。根据用户的筛选条件和选中列，请求对应的 SQL 分析。 |
| **元数据和可复现性** | 后续由客户端提供。加入数据描述、数据字典、报告样式和运行记录，记录输入、参数、DuckDB 版本和耗时。 |

## 实现方式

首版从 DuckDB SQL 表宏起步。用 `query_table()` 引用输入表或视图，再对参与画像的列使用与类型匹配的聚合函数。先确定本次要跑哪种分析，再用固定模板和校验过的输入生成 SQL。

把能一起计算的默认指标合并。在多个指标共用频数时，只分组一次，再从已有计数推出比例和状态。直方图、重复分组和列对查询按需执行。文件、图像等专项分析从 DuckDB 可以查询的元数据表或视图取数，再做统计。

已在 DuckDB 1.5.5 上验证表宏按分析类型选择查询的方式。拟议指标的完整实现、与参考库的口径对照和端到端性能还有待验证。
