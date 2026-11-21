[English](./README.md) | **简体中文**

# Data Profiling

面向数据平台、分析工具和应用的数据画像计算库。输入 DuckDB 连接、表名和已知 schema，输出统一的结构化统计结果。

支持 149 个指标 ID，覆盖表与列质量、数值分布、类别与文本、相关性、日期时间、文件、图像和时序。按字段类型批量执行适用指标，原生聚合复用计算状态，只将统计结果返回 JavaScript。详见[指标目录与计算口径](./docs/metrics.md)。

## 计算画像

```ts
import { profile } from 'data_profiling';
import type { ProfileColumn } from 'data_profiling';

const columns = (await connection.runAndReadAll(
  'SELECT name, type FROM pragma_table_info(?)', ['orders'],
)).getRowObjectsJson() as ProfileColumn[];

const results = await profile(connection, 'orders', columns, {
  metrics: ['row_count', 'missing_rate', 'distinct_count',
    'min', 'max', 'mean', 'stddev_samp'],
});
```

复用调用方连接；已有 schema 时直接传入。`metrics` 决定所需统计，省略时使用完整的 `ALL_METRICS` 目录，`[]` 返回空结果。重复 ID 以最后一项配置为准。列列表可以是子集；类型来自 schema 或显式角色。

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

`renderReport` 同步接收 `readonly ProfileResult[]`，展示表概览、基于已有指标的质量观察、可展开的列详情、分布与频数、列对矩阵、缺失覆盖，以及已提供的 ACF/PACF。全部精确值和指标参数保留在详情表中。未提供的指标标为“未提供”，已计算但无定义的 null 标为“未定义”。图表坐标使用近似数值，详情保留原始整数、小数和时间字符串。频数图预览前 12 个已提供的值，表格保留全部已有数据。

渲染不查询数据、不读取文件，也不依赖 Python 或 DuckDB；支持多表并校验协议 v1 输入，对表名、列名、值和选项进行 HTML 转义。报告可离线打开，使用原生展开/折叠交互。样本、散点和缺失模式矩阵需要当前结果协议尚未提供的额外数据。

报告默认使用简体中文，`language` 控制标题、指标名、参数名、类型名、图表文案和空状态，同时设置 HTML 的 `lang` 属性。原始表名、列名、数据值和自定义标题保持原样。指标 ID 可在悬浮提示中查看，未知的自定义指标沿用原名。

运行 `npm run build && node examples/report.mjs` 可生成使用原生画像指标的示例报告。

## 结果与精度

每条 `ProfileResult` 包含 `protocol_version`、`table_name`、`columns`、`metric`、`parameters` 和带 `type` / `value` 标签的 `value`。表级目标为 `[]`，单列为 `[name]`，列对为 `[a, b]`。

整数和小数以带类型的字符串保留精度；浮点结果使用数字或 `NaN`、`Infinity`、`-Infinity` 字符串。日期时间保留原生精度，带时区时间转为 UTC；时长使用纳秒。未定义结果使用带类型的 `null`，不适用或跳过的指标不返回记录。

`profile` 将浮点 NaN 计为缺失，数值边界保留无穷值。编译入口默认 `semantics: 'finite'`，缺失只计 SQL NULL，数值聚合排除非有限值；设置 `'extended'` 可使用前述 NaN 和无穷值口径。小数中位数及离散度沿用 DuckDB 原生精度。

完整频数、分位点、分箱、相关性和时序结果的结构与配置见[指标目录](./docs/metrics.md)。未知指标、参数和重复列名会在执行前被拒绝。

## 执行与资源

原生聚合由调用方连接控制并行度和内存。精确去重、完整频数和中位数需要相应状态；通过 `metrics` 选择所需指标，可控制计算与输出成本。

专项算法只导出分组后的值或必需的原始列，通过临时 Parquet 交换。同一路径在单次请求中复用读取结果。Python worker 复用已加载算法，空闲 30 秒后退出；每次请求重新计算统计和文件元数据。成功和失败都会清理临时文件。需要各阶段共享一致快照时，使用调用方事务。

## 开发

Node.js 22.13 或以上：

```sh
npm install
npm test
node examples/node.mjs
node examples/profile.mjs
PROFILING_PYTHON=.venv/bin/python npm test
node examples/profile.mjs .venv/bin/python
npm run bench -- 200000
PROFILING_PYTHON=.venv/bin/python npm run bench:algorithms -- 200000
npm pack
```

测试覆盖各指标族、精度、空表、参数、预编译复用和受限内存。基准覆盖混合表、唯一字符串、宽数值表、专项组合，以及 16 MB 限制下的 500 万行求和。测量基于本机内存表。

0.4.0 使用 `profile`、`ALL_METRICS`、`ProfileOptions` 作为通用执行 API；编译入口使用 `semantics: 'finite' | 'extended'`。
