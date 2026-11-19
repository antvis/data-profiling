[English](./README.md) | **简体中文**

# Data Profiling 数据画像

Data Profiling 是一个面向 DuckDB SQL 的数据画像库，灵感来自 [fg-data-profiling](https://github.com/Data-Centric-AI-Community/fg-data-profiling)。统计结果可以用 SQL 查询和复用。

> [!NOTE]
> 已实现 `row_count`、`column_count` 和逐列的 `missing_count`，其余指标和列选择仍在规划中。[结果协议 v1](./docs/result-protocol.md) 已定义标量、分布和列对结果的表达方式。

## 快速开始

npm 包向 AVA 等 Node.js 项目导出 SQL，复用调用方已有的 DuckDB 连接，没有运行时 npm 依赖。运行库和常规测试都不需要 Python 环境。

本地联调时，在调用方项目中安装本仓库：

```sh
npm install /absolute/path/to/data_profiling
```

```ts
import { dataProfilingSQL } from 'data_profiling';
import type { ProfileResult, ProfileRow } from 'data_profiling';

await connection.run(dataProfilingSQL);
const reader = await connection.runAndReadAll('SELECT * FROM data_profiling(?)', ['orders']);
const results: ProfileResult[] = (reader.getRowObjectsJson() as ProfileRow[]).map((row) => ({
  ...row,
  parameters: JSON.parse(row.parameters),
  value: JSON.parse(row.value),
}));
```

AVA 在内部连接初始化时注册 SQL，计算画像时调用宏，再将结果适配成自己的 `Profile` 结构。AVA 对外的查询接口只接受只读 SELECT，注册操作不走该接口。

## 结果协议 v1

| 字段 | 含义 |
| --- | --- |
| `protocol_version` | 固定为 `1`，表示结果协议版本。 |
| `table_name` | 调用时传入的表引用。 |
| `columns` | 表级为 `[]`，单列放一个列名，列对放两个有序列名。 |
| `metric` | 下方指标目录中的 ID。 |
| `parameters` | JSON 对象，记录实际生效的指标参数。 |
| `value` | 带类型标签的 JSON，支持标量及递归的列表、对象。 |

整数和精确小数以文本保留在带类型的值中，浮点数、特殊数值、时间、时长和未定义结果有明确编码。直方图边界、频数和分位点采用结构化值；列对也使用同样六列。详见[完整协议、兼容规则和各指标族的结构](./docs/result-protocol.md)、[协议示例](./docs/result-examples.json)及 [TypeScript 类型](./index.d.ts)。

Node 驱动将 JSON 列返回为文本，按上例解析后得到 `ProfileResult`，无需强制转成 JavaScript `number`。

## DuckDB CLI

按以下顺序加载协议辅助函数、分类指标和统一入口：

```sql
.read sql/result.sql
.read sql/metrics/table.sql
.read sql/metrics/missingness.sql
.read sql/data_profiling.sql

CREATE TEMP TABLE orders AS
SELECT * FROM (VALUES (120, 'web'), (80, 'store'), (NULL, NULL)) AS t(amount, channel);

SELECT * FROM data_profiling('orders');
```

| protocol_version | table_name | columns | metric | parameters | value |
| --- | --- | --- | --- | --- | --- |
| 1 | orders | [] | row_count | {} | {"type":"integer","value":"3"} |
| 1 | orders | [] | column_count | {} | {"type":"integer","value":"2"} |
| 1 | orders | [amount] | missing_count | {} | {"type":"integer","value":"1"} |
| 1 | orders | [channel] | missing_count | {} | {"type":"integer","value":"1"} |

`row_count` 包含重复行和含 NULL 的行，`column_count` 读取列元数据。`missing_count` 统计 SQL NULL，空表每列返回零；空字符串、零和 DuckDB NaN 不算 NULL。支持表、视图和带 schema 的表名；表不存在时保留 DuckDB 报错。重复加载会替换当前 schema 中的同名宏。

`.read` 是 CLI 命令，其他客户端执行 `dataProfilingSQL` 即可加载全部依赖。

## 目录组织与执行

```text
sql/
  result.sql               # 共用的值与结果构造函数
  metrics/
    table.sql              # 表级指标，类内用注释块划分
    missingness.sql        # 列缺失指标
  data_profiling.sql       # 批量执行和结果路由
index.cjs                  # SQL 导出
index.d.ts                 # 协议类型
docs/
  result-protocol.md
  result-examples.json
tests/
  result.test.cjs
  metrics/table.test.cjs
  metrics/missingness.test.cjs
  data-profiling.test.cjs
  fixtures/                # 共用输入；各分类各自保存标答
  generate-reference.py
```

分类函数负责指标计算和带类型的值。统一入口将兼容聚合批量执行、展开成行，再调用 `data_profiling_result`，不重写指标公式。行数和所有列的缺失数共用一次输入扫描。列名在聚合后获取，避免空表丢失列名。npm 模块只在加载时读取 SQL 文件。

结果协议能表达下方各指标族，无需改动外层六列。执行能力单独扩展：分布和列对可能需要分组、排序或额外阶段，文件、图像元数据和 ADF 可能需要扩展或执行适配，目前尚未实现。不要求所有指标强行共用一次扫描，性能用 EXPLAIN ANALYZE 和代表性数据验证。

## 本地开发与标答测试

使用 Node.js 22.13 或更高版本：

```sh
npm install
npm test
npm pack
```

`package-lock.json` 只在本地保留，已加入 Git 忽略规则。测试使用 Node 内置测试框架，`@duckdb/node-api` 2.0.0-r.1 仅作开发依赖。`npm pack` 生成可本地安装的压缩包，目前尚未发布。

每个 SQL 文件对应一个测试文件，各保留一个核心案例。`table.sql`、`missingness.sql` 分别对照自己的标答文件，标答由同一份输入实际运行 `fg-data-profiling 4.20.0` 生成。`result.sql` 验证公开协议示例，入口测试检查路由和列结构。协议示例只验证序列化，并不代表未来指标已实现。

刷新指标标答时，在独立 Python 环境安装 `fg-data-profiling==4.20.0`，运行 `python tests/generate-reference.py`。脚本分别生成 `fixtures/table.json`、`fixtures/missingness.json`，记录包版本、配置和字段映射；接受更新前先检查差异。

本协议与 fg 的报告 JSON 结构不同。fg 用来校验统计值：`table.n` 对应 `row_count`，`table.n_var` 对应 `column_count`，`variables.<column>.n_missing` 对应 `missing_count`。共用输入将 Python 缺失值映射为 SQL NULL，不据此认定 DuckDB NaN 与 pandas 缺失值口径一致。将来若要导出 fg 报告格式，应通过适配层转换，保持核心 SQL 协议稳定。

## 规划中的列选择

以下为接口设计示例，尚未实现：

```sql
SELECT * FROM data_profiling('orders', columns := ['amount', 'quantity']);
```

## 规划中的核心指标

**重要性**按各组统计对通用画像的价值评估。五星是核心指标，四星常用于进一步排查，三星视场景使用，两星用于专项分析，一星适用于少数领域。

计算标记说明库针对适用输入类型的拟议行为。目前只有 `row_count`、`column_count` 和 `missing_count` 已实现。

- `default` 表示默认画像会计算该指标。
- `minimal` 表示最小画像也会计算该指标。`minimal（文本列）` 表示仅对文本列计算。
- `配置` 标出控制该指标的设置。只有 `配置` 标签的指标，需要显式提供设置或开启对应分析。

每组中的名称、ID 和计算标记逐行对应。

| 范围 | 名称 | ID | 计算标记 | 重要性 | 计算口径 |
| --- | --- | --- | --- | :---: | --- |
| 表规模 | 行数<br>列数 | `row_count`<br>`column_count` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | 统计输入表或视图的行数和列数。 |
| 列类型 | 各类型列数 | `column_type_counts` | `default` · `minimal` | ⭐⭐⭐⭐⭐ | 按画像类型汇总列数。 |
| 重复组 | 重复组数<br>重复组数占总行数的比例 | `duplicate_group_count`<br>`duplicate_group_rate` | `default` · `配置`（重复检测）<br>`default` · `配置`（重复检测） | ⭐⭐⭐⭐⭐ | 按参与画像的字段值分组，统计至少包含两行的组数。比例以总行数为分母。 |
| 列缺失 | 观测数<br>缺失数<br>缺失率<br>非缺失数 | `observation_count`<br>`missing_count`<br>`missing_rate`<br>`present_count` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | 逐列统计观测总数和缺失数。两者相减得到非缺失数。缺失率以观测总数为分母。 |
| 取值频数 | 取值频数<br>按值排序的频数 | `value_counts`<br>`value_counts_by_value` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | 统计每个非缺失值出现的次数。取值可比较时，按值排序可查看两端取值及其频次。 |
| 不同值 | 不同值数<br>不同值比例 | `distinct_count`<br>`distinct_rate` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | 精确统计非缺失的不同值数，并除以非缺失观测数得到比例。 |
| 数值位置与范围 | 最小值<br>最大值<br>均值<br>总和<br>极差 | `min`<br>`max`<br>`mean`<br>`sum`<br>`range` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | 对数值做基础聚合。极差等于最大值减去最小值。 |
| 分位数 | 分位数<br>中位数 | `quantiles`<br>`median` | `default` · `minimal` · `配置`（数值分布）<br>`default` · `minimal` · `配置`（数值分布） | ⭐⭐⭐⭐⭐ | 计算指定分位点的值，例如 P5、P25、P50、P75 和 P95。P50 即中位数。 |
| 数值分布 | 数值直方图 | `numeric_histogram` | `default` · `minimal` · `配置`（数值分布） | ⭐⭐⭐⭐⭐ | 对有限数值分箱，保留边界和各箱频数。 |
| 日期时间范围 | 最早时间<br>最晚时间<br>时间跨度 | `min_timestamp`<br>`max_timestamp`<br>`time_span` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐⭐ | 在有效日期时间中找到最早和最晚值，再计算两者的间隔。 |
| 字符串长度 | 最短字符串长度<br>最长字符串长度<br>平均字符串长度<br>中位字符串长度 | `min_length`<br>`max_length`<br>`mean_length`<br>`median_length` | `default` · `minimal（文本列）` · `配置`（字符串长度）<br>`default` · `minimal（文本列）` · `配置`（字符串长度）<br>`default` · `minimal（文本列）` · `配置`（字符串长度）<br>`default` · `minimal（文本列）` · `配置`（字符串长度） | ⭐⭐⭐⭐⭐ | 统计字符长度，再按各长度出现的次数计算最小值、最大值、均值和中位数。 |
| 线性和秩相关 | Pearson 相关<br>Spearman 秩相关 | `pearson_r`<br>`spearman_rho` | `default` · `配置`（相关性方法）<br>`default` · `配置`（相关性方法） | ⭐⭐⭐⭐⭐ | 分别衡量两个数值列的线性关联和秩关联。 |

<details>
<summary>更多指标（40 组）</summary>

| 范围 | 名称 | ID | 计算标记 | 重要性 | 计算口径 |
| --- | --- | --- | --- | :---: | --- |
| 表缺失 | 缺失单元格数<br>缺失单元格比例 | `missing_cell_count`<br>`missing_cell_rate` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | 将各列缺失数加总，并除以单元格总数得到缺失比例。 |
| 表缺失 | 含缺失值的列数<br>整列缺失的列数 | `columns_with_missing_count`<br>`all_missing_column_count` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | 分别统计至少缺一个值的列和所有值都缺失的列。 |
| 表内存 | 表内存占用<br>平均每行内存占用 | `table_memory_bytes`<br>`mean_row_memory_bytes` | `配置`（内存统计）<br>`配置`（内存统计） | ⭐⭐ | 统计输入数据的内存占用，再除以行数得到每行平均占用。 |
| 重复组频次 | 各重复组行数 | `duplicate_group_row_count` | `default` · `配置`（重复检测） | ⭐⭐⭐⭐ | 统计每个重复组有多少行，找出反复出现的取值组合。 |
| 列分类 | 画像类型<br>指定类型<br>能否分组<br>能否排序 | `profiling_type`<br>`declared_type`<br>`is_groupable`<br>`is_orderable` | `default` · `minimal`<br>`配置`（类型覆盖）<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | 记录用于画像的类型和调用方指定的类型，并标记取值能否用于分组和排序。 |
| 列内存 | 列内存占用 | `column_memory_bytes` | `配置`（内存统计） | ⭐⭐ | 统计单列输入数据的内存占用。 |
| 单例与唯一性 | 单例值数<br>单例值比例<br>是否唯一 | `singleton_count`<br>`singleton_rate`<br>`is_unique` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | 统计恰好出现一次的取值数，并除以非缺失观测数得到比例。列中至少有一个非缺失值时，检查所有非缺失值是否唯一。 |
| 数值离散程度 | 样本方差<br>样本标准差<br>变异系数 | `variance_samp`<br>`stddev_samp`<br>`cv` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | 计算样本方差和标准差。均值非零时，用标准差除以均值得到变异系数。 |
| 数值形状 | 偏度<br>超额峰度 | `skewness`<br>`excess_kurtosis` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐ | 偏度衡量分布不对称程度。超额峰度将标准化四阶矩与正态分布的基准比较。 |
| 特殊数值 | 负值数<br>负值比例<br>零值数<br>零值比例<br>无穷值数<br>无穷值比例 | `negative_count`<br>`negative_rate`<br>`zero_count`<br>`zero_rate`<br>`infinity_count`<br>`infinity_rate` | `default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐⭐ | 分别统计负值、零值和正负无穷值，以观测总数为比例的分母。负无穷同时计入负值数。 |
| 稳健离散程度 | 四分位距<br>中位绝对偏差 | `iqr`<br>`mad` | `default` · `minimal` · `配置`（数值分布）<br>`default` · `minimal` | ⭐⭐⭐⭐ | P75 减 P25 得到四分位距。取各值到中位数的绝对偏差，再取这些偏差的中位数，得到中位绝对偏差。 |
| 数值单调性 | 是否非递减<br>是否非递增<br>是否严格递增<br>是否严格递减 | `is_nondecreasing`<br>`is_nonincreasing`<br>`is_strictly_increasing`<br>`is_strictly_decreasing` | `配置`（行顺序）<br>`配置`（行顺序）<br>`配置`（行顺序）<br>`配置`（行顺序） | ⭐⭐⭐ | 按指定顺序判断取值是否非递减或非递增。严格单调还要求取值互异。 |
| 卡方检验 | 卡方统计量<br>卡方检验 p 值 | `chi_squared_statistic`<br>`chi_squared_p_value` | `default` · `配置`（均匀性检验）<br>`default` · `配置`（均匀性检验） | ⭐⭐ | 用各类别频数或数值、日期分箱频数，与各组频数相等的假设进行卡方检验。 |
| 布尔众数 | 布尔众数<br>布尔众数频次 | `boolean_mode`<br>`boolean_mode_count` | `default` · `minimal`<br>`default` · `minimal` | ⭐⭐⭐ | 找出出现最多的非缺失布尔值，记录其出现次数。 |
| 类别失衡 | 类别失衡分数 | `category_imbalance_score` | `default` · `minimal` | ⭐⭐⭐ | 用 1 减去归一化 Shannon 熵，归一化的分母是观测类别数的对数。只有一个观测类别时记为 0。 |
| 无效日期 | 不同的无效日期数<br>无效日期行数<br>无效日期比例 | `invalid_date_distinct_count`<br>`invalid_date_count`<br>`invalid_date_rate` | `配置`（日期解析）<br>`配置`（日期解析）<br>`配置`（日期解析） | ⭐⭐⭐⭐ | 在非缺失值中统计解析失败的不同值数及涉及的行数。无效日期比例以总行数为分母。 |
| 日期时间分布 | 日期时间直方图 | `datetime_histogram` | `default` · `minimal` · `配置`（时间分布） | ⭐⭐⭐⭐ | 将日期时间分箱，并统计每个时间箱内的观测数。 |
| 字符串长度分布 | 长度频数<br>长度直方图 | `length_counts`<br>`length_histogram` | `default` · `minimal（文本列）` · `配置`（字符串长度）<br>`default` · `minimal（文本列）` · `配置`（字符串长度） | ⭐⭐⭐ | 统计每个整数长度出现的次数，也可按这些频数加权分箱。 |
| 字符频数 | 字符总数<br>不同字符数<br>字符频数 | `character_count`<br>`distinct_character_count`<br>`character_counts` | `default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode） | ⭐⭐⭐ | 统计各字符出现的次数、累计出现次数及不同字符的数量。 |
| Unicode 类别 | Unicode 类别数<br>类别频数<br>类内字符频数 | `unicode_category_distinct_count`<br>`unicode_category_frequencies`<br>`unicode_category_character_counts` | `default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode） | ⭐⭐ | 把字符映射到 Unicode 类别，统计类别数、各类别频数和每个类别内的字符频数。 |
| Unicode 区块 | Unicode 区块数<br>区块频数<br>区块内字符频数 | `unicode_block_distinct_count`<br>`unicode_block_frequencies`<br>`unicode_block_character_counts` | `default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode） | ⭐⭐ | 把字符映射到 Unicode 区块，统计区块数、各区块频数及区块内的字符频数。 |
| Unicode 书写系统 | 书写系统数<br>书写系统频数<br>系统内字符频数 | `unicode_script_distinct_count`<br>`unicode_script_frequencies`<br>`unicode_script_character_counts` | `default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode）<br>`default` · `minimal（文本列）` · `配置`（字符与 Unicode） | ⭐⭐ | 按 Unicode 书写系统汇总字符出现次数，统计系统数、各系统频数和系统内的字符频数。 |
| 词频 | 词频 | `word_counts` | `default` · `minimal（文本列）` · `配置`（词频） | ⭐⭐⭐ | 统一大小写，按空白拆词并去除词两端的标点，过滤停用词后统计词频。 |
| 缺失模式 | 各列非缺失计数<br>逐格缺失标记<br>缺失相关性 | `column_present_counts`<br>`missing_mask`<br>`missingness_correlation` | `default` · `minimal`<br>`配置`（缺失模式）<br>`配置`（缺失模式） | ⭐⭐⭐ | 逐列统计非缺失值，标记每个单元格是否缺失，再对缺失状态有变化的列计算缺失相关性。 |
| 自动关联 | 按列类型计算的关联度 | `auto_association` | `配置`（自动关联） | ⭐⭐⭐⭐ | 数值列对用秩相关。配对包含类别或布尔列时用校正 Cramér’s V，混合配对中的数值列先分箱。 |
| Kendall 秩相关 | Kendall 秩相关 | `kendall_tau` | `配置`（相关性方法） | ⭐⭐⭐ | 基于观测对的排序一致和不一致情况衡量秩关联。 |
| 类别关联 | 校正 Cramér’s V | `cramers_v` | `配置`（相关性方法） | ⭐⭐⭐ | 为两个类别列或布尔列构造列联表，计算经偏差校正的关联强度。 |
| Phi-K 关联 | Phi-K 关联度 | `phi_k` | `配置`（相关性方法） | ⭐⭐ | 为适用的列对构造分箱后的列联表，计算关联强度。 |
| URL 部件 | URL 协议频数<br>URL 网络位置频数<br>URL 路径频数<br>URL 查询串频数<br>URL 片段频数 | `url_scheme_counts`<br>`url_netloc_counts`<br>`url_path_counts`<br>`url_query_counts`<br>`url_fragment_counts` | `配置`（URL 画像）<br>`配置`（URL 画像）<br>`配置`（URL 画像）<br>`配置`（URL 画像）<br>`配置`（URL 画像） | ⭐⭐ | 拆分 URL 后，分别统计协议、主机等网络位置、路径、查询串和片段的频数。 |
| 路径部件 | 路径公共前缀<br>无扩展名路径频数<br>扩展名频数<br>文件名频数<br>父目录频数<br>驱动器前缀频数 | `path_common_prefix`<br>`path_stem_counts`<br>`path_suffix_counts`<br>`path_basename_counts`<br>`path_parent_counts`<br>`path_drive_counts` | `配置`（路径画像）<br>`配置`（路径画像）<br>`配置`（路径画像）<br>`配置`（路径画像）<br>`配置`（路径画像）<br>`配置`（路径画像） | ⭐⭐ | 找出共有的字符串前缀，分别统计去掉扩展名的路径、扩展名、文件名、父目录和驱动器前缀的频数。 |
| 路径部件基数 | 不同的无扩展名路径数<br>不同扩展名数<br>不同文件名数<br>不同父目录数<br>不同驱动器前缀数 | `path_stem_distinct_count`<br>`path_suffix_distinct_count`<br>`path_basename_distinct_count`<br>`path_parent_distinct_count`<br>`path_drive_distinct_count` | `配置`（路径画像）<br>`配置`（路径画像）<br>`配置`（路径画像）<br>`配置`（路径画像）<br>`配置`（路径画像） | ⭐⭐ | 分别统计每种路径部件的不同值数。 |
| 文件大小 | 文件大小<br>文件大小直方图 | `file_size_bytes`<br>`file_size_histogram` | `配置`（文件元数据）<br>`配置`（文件元数据） | ⭐⭐ | 读取每个文件的字节数，再对这些大小分箱计数。 |
| 文件时间 | 修改时间频数<br>访问时间频数<br>元数据变更时间频数 | `file_modified_time_counts`<br>`file_access_time_counts`<br>`file_metadata_change_time_counts` | `配置`（文件元数据）<br>`配置`（文件元数据）<br>`配置`（文件元数据） | ⭐ | 根据文件元数据，分别统计修改、访问和元数据变更时间的频数。 |
| 图像完整性与尺寸 | 截断图像数<br>图像尺寸频数 | `truncated_image_count`<br>`image_dimension_counts` | `配置`（图像画像）<br>`配置`（图像画像） | ⭐ | 统计能打开但加载失败的图像数，并按成功加载的图像宽高组合计频。 |
| 图像宽高与面积 | 最小宽度<br>最大宽度<br>平均宽度<br>中位宽度<br>最小高度<br>最大高度<br>平均高度<br>中位高度<br>最小面积<br>最大面积<br>平均面积<br>中位面积 | `min_image_width`<br>`max_image_width`<br>`mean_image_width`<br>`median_image_width`<br>`min_image_height`<br>`max_image_height`<br>`mean_image_height`<br>`median_image_height`<br>`min_image_area`<br>`max_image_area`<br>`mean_image_area`<br>`median_image_area` | `配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像）<br>`配置`（图像画像） | ⭐ | 分别计算宽度、高度和像素面积的最小值、最大值、均值和中位数。 |
| 图像 EXIF | EXIF 标签频数<br>各 EXIF 标签的取值频数 | `exif_tag_counts`<br>`exif_value_counts` | `配置`（EXIF 元数据）<br>`配置`（EXIF 元数据） | ⭐ | 统计每个 EXIF 标签出现的次数，以及标签下各种取值的频数。 |
| 时序索引 | 时序列数<br>时序观测数<br>索引起点<br>索引终点<br>索引平均间隔 | `time_series_count`<br>`time_index_observation_count`<br>`time_index_start`<br>`time_index_end`<br>`mean_time_index_step` | `配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析） | ⭐⭐⭐ | 统计时序列数和观测数，取索引最小值、最大值，以及相邻索引差绝对值的均值。 |
| 平稳性与季节性 | ADF 检验 p 值<br>是否平稳<br>是否有季节性 | `adf_p_value`<br>`is_stationary`<br>`is_seasonal` | `配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析） | ⭐⭐ | 用 ADF 检验并返回 p 值，通过频谱峰判断是否有季节性。平稳性判定也考虑季节性。 |
| 时序缺口 | 缺口数<br>缺口两端索引<br>最短缺口长度<br>最长缺口长度<br>平均缺口长度<br>缺口长度的样本标准差 | `gap_count`<br>`gap_endpoints`<br>`min_gap`<br>`max_gap`<br>`mean_gap`<br>`stddev_gap_samp` | `配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析）<br>`配置`（时序分析） | ⭐⭐⭐⭐ | 剔除缺失观测后，用相邻索引间隔定位缺口，统计缺口数及两端索引，并计算长度的最小值、最大值、均值和样本标准差。 |
| 时序自相关 | 自相关<br>偏自相关 | `acf`<br>`pacf` | `配置`（时序分析）<br>`配置`（时序分析） | ⭐⭐ | 按滞后阶数计算自相关、偏自相关系数和置信区间。 |

</details>
