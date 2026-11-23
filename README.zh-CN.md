[English](./README.md) | **简体中文**

# Data Profiling

[在线体验](https://data-profiling.antv.vision/)

为 AVA 提供数据画像计算能力的 ES Modules 基础库。输入调用方的 DuckDB 连接、表名和已知 schema，输出统一的结构化统计结果。AVA 负责数据接入、会话和结果消费；业务规则和结果解释由应用或 Agent 负责。

支持 149 个指标 ID，覆盖表与列质量、数值分布、类别与文本、相关性、日期时间、文件、图像和时序。按字段类型批量执行适用指标，原生聚合复用计算状态，只将统计结果返回 JavaScript。详见[指标支持矩阵](#指标支持矩阵)和[指标目录与计算口径](./docs/metrics.md)。

## 计算画像

```ts
import { BASIC_METRICS, profile } from 'data_profiling';
import type { ProfileColumn } from 'data_profiling';

const columns = (await connection.runAndReadAll(
  'SELECT name, type FROM pragma_table_info(?)', ['orders'],
)).getRowObjectsJson() as ProfileColumn[];

const results = await profile(connection, 'orders', columns, {
  metrics: BASIC_METRICS,
});
```

复用调用方连接；已有 schema 时直接传入。`metrics` 决定所需统计，省略时使用完整的 `ALL_METRICS` 目录，`[]` 返回空结果。重复 ID 以最后一项配置为准。列列表可以是子集；类型来自 schema 或显式角色。

`BASIC_METRICS` 对应 AVA 默认的七个指标 ID：`row_count`、`null_count`、`distinct_count`、`top_values`、`min`、`max`、`mean`。它们使用原生 SQL，不启动 Python、不导出原始数据。精确去重和高频值仍需要随数据基数增长的状态，可进一步缩减指标。现有两个入口的默认行为不变。详见 [AVA 接入说明](./docs/ava.md)和[消费端示例](./examples/ava.mjs)。

计数、边界、求和、方差、长度、频数、普通数值分位与直方图等直接在 DuckDB 内执行。字符分析、高精度分位、部分检验、文件和时序等专项算法使用可选 Python 环境：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r python-requirements.txt
```

按字段角色启用专项计算：

```ts
const results = await profile(connection, 'events', eventColumns, {
  python: '.venv/bin/python',
  types: { message: 'text', link: 'url', attachment: 'file',
    picture: 'image', measurement: 'timeseries' },
  timeIndex: 'observed_at',
});
```

文件、图像、URL 和路径角色须显式指定。有序指标需要 `orderBy` 或 `timeIndex`，时序指标需要 `timeIndex`；未配置的可选角色会跳过。

## 编译原生计划

需要自行执行 SQL、预编译或适配其他结果格式时，使用 `createProfilingPlan`：

```ts
import { createProfilingPlan } from 'data_profiling';

const plan = createProfilingPlan('orders', columns, {
  metrics: ['row_count', 'min', 'max', 'mean'],
});
const reader = await connection.runAndReadAll(plan.sql);
const results = plan.decode(reader.getRowObjectsJson()[0]);
```

此入口接受可直接编译的指标，默认计算 15 项基础统计。`plan.sql` 返回一行原生统计；`plan.decode` 转为 `ProfileResult[]`，也可根据 `plan.metrics` 读取原生值。完整目录及需要额外阶段的统计通过 `profile` 执行。

需要明确原生指标的计算覆盖时，使用 `plan.decodeWithDiagnostics(row)`，返回 `{ results, skipped }`。跳过项包含表、目标字段、指标及 `unsupported_type` 或 `cardinality_limit` 原因。已计算但无定义的结果仍以带类型的 `null` 留在 `results`；未请求的指标不出现在两个列表中。请求无效、传输异常和执行失败仍会抛错。

schema 不变时可复用计划，通过 `connection.prepare(plan.sql)` 复用预编译语句，用完后调用 `destroySync()`。每次执行读取当前数据；schema 变化后重新生成计划。表引用采用 DuckDB 完整表名，如 `sales.orders`，特殊名称分别加双引号。

## 渲染离线报告

独立入口 `data_profiling/report` 将已有结果渲染为单文件 HTML，样式与图表全部内联：

```ts
import { writeFile } from 'node:fs/promises';
import { renderReport } from 'data_profiling/report';

const html = renderReport(results, {
  title: '订单数据画像',
  theme: 'light', // 'light'（默认）、'dark' 或 'auto'
  language: 'zh-CN', // 默认中文，可选 'en-US'
});
await writeFile('orders-report.html', html, 'utf8');
```

`renderReport` 同步接收 `readonly ProfileResult[]`。报告分别显示指标种类和结果条数，并按已有结果展示列类型、可跳转到对应列的质量观察、各列缺失率和重复组大小分布。列详情按类型优先展示相应的图表，例如文本词云、图像尺寸分布，以及时间序列的 ACF/PACF。相关性部分列出关联最强的列对，各方法的矩阵可展开查看。

详情表保留所有已提供的精确值和指标参数，包括原始整数、小数和时间字符串。“未提供”表示缺少该指标，“未定义”表示计算结果无定义。图表使用近似坐标，部分图表只预览高频值。

渲染器仅使用已有的画像结果，支持多表，校验协议 v1 输入，并对表名、列名、值和选项做 HTML 转义。报告可离线打开，使用原生展开和折叠交互。样本行、逐行散点图和缺失模式矩阵需要协议 v1 之外的逐行数据。

报告默认使用简体中文，`language` 控制标题、指标名、参数名、类型名、图表文案和空状态，同时设置 HTML 的 `lang` 属性。原始表名、列名、数据值和自定义标题保持原样。指标 ID 可在悬浮提示中查看，未知的自定义指标沿用原名。

运行 `npm run build && node examples/report.mjs` 可生成使用原生画像指标的示例报告。

## 结果与精度

每条 `ProfileResult` 包含 `protocol_version`、`table_name`、`columns`、`metric`、`parameters` 和带 `type` / `value` 标签的 `value`。表级目标为 `[]`，单列为 `[name]`，列对为 `[a, b]`。

整数和小数以带类型的字符串保留精度；有损整数传输及格式错误的标量会被拒绝，包括频数及直方图计数。浮点结果使用数字或 `NaN`、`Infinity`、`-Infinity` 字符串。日期时间保留原生精度，带时区时间转为 UTC；时长使用纳秒。未定义结果使用带类型的 `null`，不适用或跳过的指标不返回记录。

`profile` 将浮点 NaN 计为缺失，数值边界保留无穷值。编译入口默认 `semantics: 'finite'`，缺失只计 SQL NULL，数值聚合排除非有限值；设置 `'extended'` 可使用前述 NaN 和无穷值口径。小数中位数及离散度沿用 DuckDB 原生精度。

完整频数、分位点、分箱、相关性和时序结果的结构与配置见[指标目录](./docs/metrics.md)。未知指标、参数和重复列名会在执行前被拒绝。

## 执行与资源

原生聚合由调用方连接控制并行度和内存。精确去重、完整频数和中位数需要相应状态；通过 `metrics` 选择所需指标，可控制计算与输出成本。

专项算法只导出分组后的值或必需的原始列，通过临时 Parquet 交换。列对指标不足两个适用字段时不启动 Python；秩相关只导出数值列。同一路径在单次请求中复用读取结果。Python worker 复用已加载算法，空闲 30 秒后退出；每次请求重新计算统计和文件元数据。成功和失败都会清理临时文件。需要各阶段共享一致快照时，使用调用方事务。

## 开发

### 官网在线体验

```sh
npm install
npm run dev:site
npm run build:site
```

`site/` 是静态体验界面，构建到 `build/`，与库的 `dist/` 输出分开。默认载入 128 条中文订单，左侧分页预览数据，右侧复用 `renderReport`。支持上传 CSV（含表头）、JSON、Parquet，最大 20 MB、200 列。可以切换常用统计、详细统计或本机全量统计，调整分箱数、语言和主题，并导出 HTML 报告。

常用和详细统计由浏览器内的 DuckDB-Wasm 计算，相关性覆盖前 20 个数值列。Wasm 引擎首次从固定版本的 CDN 载入。预览每页 25 行，统计使用完整数据。上传解析失败会回滚并保留当前数据。

推送到 `main` 后，[GitHub Actions](https://github.com/antvis/data-profiling/actions/workflows/deploy-pages.yml) 自动安装依赖、运行测试、构建并部署到 GitHub Pages，也支持手动触发。资源使用相对路径，支持自定义域名。仓库的 Settings → Pages 需要启用 GitHub Actions 发布来源；组织 Free 套餐下，Pages 需要公开仓库。

### 本机全量统计

安装仓库依赖后，在仓库目录配置 Python 并启动本机引擎。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r python-requirements.txt
PROFILING_PYTHON=.venv/bin/python npm run full:site
```

打开 [本机体验页](http://127.0.0.1:5174/)，或在官网允许浏览器连接本机引擎。选择「全量统计（本机）」，设置需要的列角色、时间索引和排序列，再点击「重新生成」。引擎调用 `profile()` 的完整指标目录，报告显示适用于当前数据的指标及其数量。数据留在设备上，本机引擎只监听回环地址。

预设订单已设置列角色和时间索引，并自带附件和图片。选择全量统计后点击「重新生成」即可看到 149/149。

上传的数据使用文件和图像角色时需要授权目录。在上述启动命令末尾加 `-- "/文件目录的绝对路径"`。数据里的路径可以是目录内的相对路径或绝对路径。引擎会从实际文件读取大小、时间和图像元数据。

### 测试与基准

Node.js 22.13 或以上：

```sh
npm install
npm test
node examples/node.js
node examples/profile.mjs
node examples/ava.mjs
PROFILING_PYTHON=.venv/bin/python npm test
node examples/profile.mjs .venv/bin/python
npm run bench -- 200000
PROFILING_PYTHON=.venv/bin/python npm run bench:algorithms -- 200000
npm pack
```

测试覆盖各指标族、精度、空表、参数、预编译复用和受限内存。基准覆盖混合表、唯一字符串、宽数值表、专项组合，以及 16 MB 限制下的 500 万行求和。测量基于本机内存表。

0.5.0 新增 `BASIC_METRICS` 和原生指标跳过诊断。包格式切换为 ES Modules；保留现有 `profile`、`createProfilingPlan`、结果协议 v1 及其默认行为。

## 指标支持矩阵

`profile()` 的 149 个指标 ID（含别名）按计算对象分为[单列指标（126 项）](#单列指标)、[整表指标（17 项）](#整表指标)和[列对指标（6 项）](#列对指标)。✅ 表示满足计算条件时支持，空白表示不适用。统计量无定义时，结果可以是带类型的 `null`。

### 单列指标

字符串默认归为类别。文本、URL、路径、文件和图像通过 `types` 显式指定。原生日期时间包括 DuckDB 的 `DATE` 和各类 `TIMESTAMP`。日期字符串指指定为 `date` 的字符串列，时序数值指指定为 `timeseries` 的数值列。未识别类型包括 `LIST`、`STRUCT` 等，这些列的 `is_orderable` 返回 `false`。

- `top_values` 默认取前 3 项。不同非缺失值数超过总行数的 50% 时跳过该列，可通过 `maxDistinctRatio` 调整阈值。日期字符串的高频值和长度按原文计算，时间边界按成功解析的日期计算。
- 四项单调性指标需要 `orderBy` 或 `timeIndex`。平稳性、季节性、缺口指标以及 `acf`、`pacf` 需要无缺失的数值或日期时间索引 `timeIndex`。指定 `timeseries` 角色时，只对这些列计算时序指标。省略该角色时，使用索引以外的数值列。
- 文件元数据和图像内容统计需要运行画像的机器能读取相应路径。文件和图像列的字符、词频等文本指标分析的是路径字符串。

| 指标 | 数值 | 类别 | 布尔 | 原生日期时间 | 文本 | 日期字符串 | URL | 路径 | 文件 | 图像 | 时序数值 | 未识别类型 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `observation_count` 观测数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `present_count` 非缺失数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `missing_count` 缺失数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `null_count` 空值数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `missing_rate` 缺失率 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `distinct_count` 不同值数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `distinct_rate` 不同值比例 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `duplicate_count` 重复值数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `is_unique` 是否唯一 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `profiling_type` 画像类型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `declared_type` 数据库类型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `is_groupable` 是否支持分组 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `is_orderable` 是否支持排序 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `column_memory_bytes` 列内存（字节） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `top_values` 高频值 |  | ✅ | ✅ |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `value_counts` 取值频数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `value_counts_by_value` 按值排序的频数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `singleton_count` 仅出现一次的值数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `singleton_rate` 仅出现一次的值比例 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `boolean_mode` 布尔众数 |  |  | ✅ |  |  |  |  |  |  |  |  |  |
| `boolean_mode_count` 布尔众数频次 |  |  | ✅ |  |  |  |  |  |  |  |  |  |
| `category_imbalance_score` 类别不均衡度 |  | ✅ | ✅ |  | ✅ |  |  |  |  |  |  |  |
| `min` 最小值 | ✅ |  |  | ✅ |  | ✅ |  |  |  |  | ✅ |  |
| `max` 最大值 | ✅ |  |  | ✅ |  | ✅ |  |  |  |  | ✅ |  |
| `mean` 均值 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `sum` 总和 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `median` 中位数 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `range` 极差 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `stddev` 样本标准差 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `stddev_samp` 样本标准差 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `variance_samp` 样本方差 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `cv` 变异系数 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `iqr` 四分位距 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `mad` 中位绝对偏差 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `skewness` 偏度 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `excess_kurtosis` 超额峰度 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `negative_count` 负值数 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `negative_rate` 负值比例 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `zero_count` 零值数 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `zero_rate` 零值比例 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `infinity_count` 无穷值数 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `infinity_rate` 无穷值比例 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `quantiles` 分位数 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `numeric_histogram` 数值直方图 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `chi_squared_statistic` 卡方统计量 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |  |  | ✅ |  |
| `chi_squared_p_value` 卡方检验 p 值 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |  |  | ✅ |  |
| `min_timestamp` 最早时间 |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `max_timestamp` 最晚时间 |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `time_span` 时间跨度 |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `datetime_histogram` 日期时间直方图 |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `invalid_date_distinct_count` 不同无效日期数 |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `invalid_date_count` 无效日期数 |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `invalid_date_rate` 无效日期比例 |  |  |  | ✅ |  | ✅ |  |  |  |  |  |  |
| `min_length` 最短长度 |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `max_length` 最长长度 |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `mean_length` 平均长度 |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `median_length` 长度中位数 |  | ✅ |  |  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |
| `length_counts` 长度频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `length_histogram` 长度直方图 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `character_count` 字符总数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `distinct_character_count` 不同字符数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `character_counts` 字符频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_category_distinct_count` 字符类别数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_category_frequencies` 字符类别频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_category_character_counts` 各字符类别的字符频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_block_distinct_count` 字符区块数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_block_frequencies` 字符区块频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_block_character_counts` 各字符区块的字符频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_script_distinct_count` 书写系统数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_script_frequencies` 书写系统频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `unicode_script_character_counts` 各书写系统的字符频数 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `word_counts` 词频 |  | ✅ |  |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |  |  |
| `url_scheme_counts` 网址协议频数 |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_netloc_counts` 网址主机频数 |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_path_counts` 网址路径频数 |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_query_counts` 网址查询参数频数 |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `url_fragment_counts` 网址片段频数 |  |  |  |  |  |  | ✅ |  |  |  |  |  |
| `path_common_prefix` 路径公共前缀 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_stem_counts` 文件主名频数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_suffix_counts` 文件后缀频数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_basename_counts` 文件名频数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_parent_counts` 父路径频数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_drive_counts` 驱动器频数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_stem_distinct_count` 不同文件主名数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_suffix_distinct_count` 不同文件后缀数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_basename_distinct_count` 不同文件名数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_parent_distinct_count` 不同父路径数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `path_drive_distinct_count` 不同驱动器数 |  |  |  |  |  |  |  | ✅ | ✅ | ✅ |  |  |
| `file_size_bytes` 文件大小（字节） |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_size_histogram` 文件大小直方图 |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_modified_time_counts` 文件修改时间频数 |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_access_time_counts` 文件访问时间频数 |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `file_metadata_change_time_counts` 文件元数据变更时间频数 |  |  |  |  |  |  |  |  | ✅ | ✅ |  |  |
| `truncated_image_count` 截断图像数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `image_dimension_counts` 图像尺寸频数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `min_image_width` 最小图像宽度 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `max_image_width` 最大图像宽度 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `mean_image_width` 平均图像宽度 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `median_image_width` 图像宽度中位数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `min_image_height` 最小图像高度 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `max_image_height` 最大图像高度 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `mean_image_height` 平均图像高度 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `median_image_height` 图像高度中位数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `min_image_area` 最小图像面积 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `max_image_area` 最大图像面积 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `mean_image_area` 平均图像面积 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `median_image_area` 图像面积中位数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `exif_tag_counts` 图像元数据标签频数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `exif_value_counts` 图像元数据取值频数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `duplicate_image_hash_count` 重复图像哈希数 |  |  |  |  |  |  |  |  |  | ✅ |  |  |
| `is_nondecreasing` 是否单调不减 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_nonincreasing` 是否单调不增 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_strictly_increasing` 是否严格递增 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_strictly_decreasing` 是否严格递减 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `adf_p_value` 平稳性检验 p 值 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_stationary` 是否平稳 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `is_seasonal` 是否有季节性 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `seasonal_periods` 季节性周期 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `gap_count` 时间缺口数 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `gap_endpoints` 时间缺口端点 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `min_gap` 最短时间缺口 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `max_gap` 最长时间缺口 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `mean_gap` 平均时间缺口 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `stddev_gap_samp` 时间缺口样本标准差 | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `acf` 自相关（ACF） | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |
| `pacf` 偏自相关（PACF） | ✅ |  |  |  |  |  |  |  |  |  | ✅ |  |

### 整表指标

整表指标的结果中，`columns` 为空数组。两项内存指标要求至少选择一列。五项时序和索引指标需要指定 `timeIndex`。

| 指标 ID | 整表 | 计算口径 |
| --- | :---: | --- |
| `row_count` | ✅ | 原表的总行数。 |
| `column_count` | ✅ | 原表的实际列数，包括未选入画像的列。 |
| `column_type_counts` | ✅ | 按推断或指定的画像类型统计所选列数。 |
| `missing_cell_count` | ✅ | 所选列中的缺失单元格数。 |
| `missing_cell_rate` | ✅ | 缺失单元格数占所选列全部单元格的比例。 |
| `columns_with_missing_count` | ✅ | 至少有一个缺失值的所选列数。 |
| `all_missing_column_count` | ✅ | 所有值都缺失的所选列数。空表返回 0。 |
| `duplicate_group_count` | ✅ | 按所选列分组后，包含至少两行的组数。 |
| `duplicate_group_rate` | ✅ | 重复组数除以总行数。 |
| `duplicate_group_row_count` | ✅ | 各重复组的行数，按行数降序排列。 |
| `table_memory_bytes` | ✅ | 所选列在 Pandas 中占用的总字节数，含索引。 |
| `mean_row_memory_bytes` | ✅ | Pandas 内存字节数除以总行数。空表返回 0。 |
| `time_series_count` | ✅ | 指定 `timeIndex` 后，参与时序分析的列数。 |
| `time_index_observation_count` | ✅ | `timeIndex` 的观测数。 |
| `time_index_start` | ✅ | `timeIndex` 的最小值。 |
| `time_index_end` | ✅ | `timeIndex` 的最大值。 |
| `mean_time_index_step` | ✅ | 按画像顺序计算相邻 `timeIndex` 值之差的绝对值，再取均值。 |

### 列对指标

每个无序列对只计算一次。下表的“数值”包括普通数值和时序数值，“类别”包括 `categorical` 和 `boolean`。“其他”包括文本、日期时间、日期字符串、URL、路径、文件和图像。列对指标只接受已识别的类型。

| 指标 | 数值 × 数值 | 数值 × 类别 | 类别 × 类别 | 数值 × 其他 | 类别 × 其他 | 其他 × 其他 | 计算条件 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | --- |
| `pearson_r` 皮尔逊相关系数 | ✅ |  |  |  |  |  | 使用两列均为有限数值的行。 |
| `spearman_rho` 斯皮尔曼相关系数 | ✅ |  |  |  |  |  | 按两列的秩计算相关系数。 |
| `kendall_tau` 肯德尔秩相关系数 | ✅ |  |  |  |  |  | 按两列取值的相对次序计算 Kendall τ。 |
| `cramers_v` 克拉默 V 系数 |  |  | ✅ |  |  |  | 每列须有 2–100 个不同的非缺失值，结果经过偏差校正。 |
| `phi_k` Phi-K 相关系数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 数值列至少有 2 个不同的非缺失值，其余适用列须有 2–100 个。 |
| `auto_correlation` 自动关联度 | ✅ | ✅ | ✅ |  |  |  | 每列至少有 2 个不同的非缺失值，类别列最多 100 个。数值对用 Spearman，类别对和混合对用 Cramér V。混合对的数值列分为 10 个等宽箱。 |
