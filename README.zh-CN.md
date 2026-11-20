[English](./README.md) | **简体中文**

# Data Profiling

按已知 schema 编译 DuckDB 原生画像计划。复用调用方连接，批量计算所需指标，只将统计结果传回 JavaScript。

唯一运行时入口是 `createProfilingPlan`。没有宏注册、SQL 文件加载或运行时 npm 依赖。

## 使用

```ts
import { createProfilingPlan } from 'data_profiling';
import type { ProfileColumn } from 'data_profiling';

const columns = (await connection.runAndReadAll(
  'SELECT name, type FROM pragma_table_info(?)', ['orders'],
)).getRowObjectsJson() as ProfileColumn[];

const plan = createProfilingPlan('orders', columns);
const reader = await connection.runAndReadAll(plan.sql);
const results = plan.decode(reader.getRowObjectsJson()[0]);
```

已有 schema 时直接传入，省去元数据查询。列列表可以是子集。表引用使用 DuckDB 的完整表名，如 `sales.orders`；特殊名称分别加双引号。

通过 `options.metrics` 选择指标。省略时计算全部 15 个指标，`[]` 表示无统计。重复 ID 以最后一项配置为准。

```ts
const plan = createProfilingPlan('orders', columns, {
  metrics: ['row_count', 'null_count', 'min', 'max', 'mean', 'sum',
    { id: 'top_values', limit: 3, maxDistinctRatio: 0.5 }],
});
```

`plan.sql` 返回一行原生聚合值，`plan.decode` 将 `getRowObjectsJson()` 的行转换为 `ProfileResult[]`。需要自定义结果格式的调用方可直接根据 `plan.metrics` 读取原生值，避免额外封装。

## 指标与精度

| 指标 | 范围与口径 |
| --- | --- |
| `row_count`、`column_count` | 总行数、输入表的实际列数。 |
| `null_count`、`missing_count` | 各列 SQL NULL 数量；两个名称共用聚合。 |
| `distinct_count` | 数值、字符串、布尔、日期时间列的非 NULL 精确不同值数。 |
| `duplicate_count` | 各列非 NULL 数量减去不同值数。 |
| `min`、`max` | 数值和日期时间列的有限值边界。 |
| `mean`、`sum`、`stddev`、`median` | 数值列的原生聚合；排除非有限浮点值。标准差为样本标准差；小数中位数沿用 DuckDB 的位数和舍入。 |
| `min_length`、`max_length` | 字符串的 Unicode 字符数，包含空字符串和末尾空格。 |
| `top_values` | 字符串和布尔的非 NULL 高频值，按频数降序、原生值升序；默认最多 3 项，不同值数 / 总行数大于 0.5 时省略。 |

整数和小数结果使用带类型的字符串保留精度；浮点结果使用 `number`，特殊值使用 `NaN`、`Infinity`、`-Infinity` 字符串。日期时间保留精度，带时区时间转为 UTC。未定义的结果为带类型的 `null`；不适用或被跳过的指标不返回记录。

每条结果包含 `protocol_version`、`table_name`、`columns`、`metric`、`parameters` 和 `value`。表级 `columns` 为 `[]`，列级为 `[列名]`；`value` 使用 `type`、`value` 标签。`top_values` 为带类型的 `entries` 列表和 `truncated` 布尔值。详见导出的 `ProfileResult`、`MetricValue` 类型。

`top_values.limit` 须为非负的 JavaScript 安全整数，`maxDistinctRatio` 须在 0 到 1 之间。未知指标、参数和重复列名会在执行前被拒绝。

## 执行与内存

类型判断和参数验证只在编译计划时进行。DuckDB 直接执行原生聚合，重复聚合复用状态；高频查询使用分组和 Top-N。求和不物化整列列表。需要轻量画像时，显式选择计数、边界、均值、求和、标准差和长度等流式指标。

计划不缓存统计结果。schema 不变时可复用计划，并用 `connection.prepare(plan.sql)` 复用预编译语句，用完后调用 `destroySync()`。每次执行读取当前数据；schema 变化后重新生成计划。

资源限制和并行度由调用方的 DuckDB 连接控制。精确去重、高频分组和中位数仍需要相应内存。

## 开发

Node.js 22.13 或以上：

```sh
npm install
npm test
node examples/node.mjs
npm run bench -- 200000
npm pack
```

源码仅有原生计划编译、结果类型及公共导出；测试覆盖计算口径、精度、空表、参数、预编译复用和受限内存。基准覆盖混合表、唯一字符串、宽数值表，以及 16 MB 限制下的 500 万行求和。基准是本机内存表测量，不包含文件或网络 I/O。

0.2.0 仅提供原生计划入口。旧的 SQL 宏、SQL 内 JSON 输出及原子指标函数已移除。
