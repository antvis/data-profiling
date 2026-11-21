# 为 AVA 提供画像计算能力

本库接收 AVA 已有的 DuckDB 连接、数据对象、schema 和指标选择，返回统计结果。数据源接入、会话、调度、结果保存、业务阈值和解释由 AVA 或其调用方负责。本库不创建 AVA 实例，也不依赖 AVA 包。

## 选择计算范围

```ts
import { BASIC_METRICS, profile } from 'data_profiling';

const results = await profile(connection, tableName, columns, {
  metrics: BASIC_METRICS,
});
```

`BASIC_METRICS` 是只读的原生指标集，对应 AVA 的默认指标 ID。`columns` 可以是 schema 的子集；指标只作用于这些列，表级 `row_count` 仍统计整个数据对象。分区或过滤范围由 AVA 提供的表、视图和事务确定，库不创建额外的数据副本。

基础指标不依赖 Python，但精确不同值数和高频值的计算状态仍随基数增长。只需要规模、缺失和边界时，可传入更小的指标列表。`profile` 省略指标时仍使用完整目录；`createProfilingPlan` 的默认 15 项也保持不变。

## 明确哪些原生指标产生了结果

```ts
import { BASIC_METRICS, createProfilingPlan } from 'data_profiling';

const plan = createProfilingPlan(tableName, columns, {
  metrics: BASIC_METRICS,
  semantics: 'finite',
});
const row = plan.metrics.length
  ? (await connection.runAndReadAll(plan.sql)).getRowObjectsJson()[0]
  : {};
const { results, skipped } = plan.decodeWithDiagnostics(row);
```

| 情况 | 表达方式 |
| --- | --- |
| 已计算且有值 | `results` 中的带类型值 |
| 已计算但无定义，例如空列的均值 | `results` 中的 `{ type: 'null', value: null }` |
| 字段类型不适用，例如文本列的均值 | `skipped` 中的 `unsupported_type` |
| 高频值因不同值比例超过限制而跳过 | `skipped` 中的 `cardinality_limit` |
| 未请求的指标 | 不出现在两个列表中 |
| 参数、传输或执行错误 | 抛错，调用方处理失败；不会转为跳过或零值 |

诊断来自同一次原生聚合，不追加查询。`decodeWithDiagnostics` 目前仅用于原生计划；完整目录的异步 `profile` 仍返回原有的 `ProfileResult[]`，不宣称所有专项算法都有逐目标诊断。

`semantics: 'finite'` 对应 AVA 当前原生聚合口径：缺失只计 SQL NULL，数值聚合排除非有限值。需要 NaN 计入缺失及支持的聚合保留无穷值时，显式选择 `extended`。异步 `profile` 沿用 `extended` 口径。

## 将结果交给 AVA

[消费端示例](../examples/ava.mjs)提供 `profileForAva(connection, schema, metrics)`，它根据 AVA 原始 schema 的 `models[].tableReference` 定位物理表，按 `models[].name` 返回逻辑对象，并复用现有连接。

```js
import { profileForAva } from '../examples/ava.mjs';

const { profile, skipped } = await profileForAva(connection, schema);
await ava.profile({}, () => profile);
```

该函数是消费端示例，不是新增的基础库 API。业务接入方负责记录、展示或处理 `skipped`。

示例的 AVA 输出形态是 `{ models: [{ name, metrics, columns }] }`，其中列包含 `name`、`properties.logicalType` 和 `metrics`。AVA 当前允许指标为 JSON 值，因此示例在每项指标中保留完整的 `MetricValue` 对象：大整数和小数保持字符串，日期保持带类型的原生字符串，浮点特殊值保留标签。它不把精确值强制转为 JavaScript Number，也不改变 AVA 自身原生画像的输出形态。需要保留每个指标的计算参数时，调用方应同时保存原始 `ProfileResult`。

仓库内可直接运行以下命令，生成带自检的示例画像：

```sh
npm run build
node examples/ava.mjs > /tmp/orders-profile.json
```

示例将物理表 `orders` 映射到逻辑模型 `data`。输出可通过 `ava profile <dataset-id> --file /tmp/orders-profile.json` 导入具有相同模型与字段的 AVA 会话；接入时以 `ava schema` 返回的名称为准。生产接入应在 AVA 的适配层使用已有连接，避免重复加载数据。当前 AVA 的通用画像契约按表、列组织；列对等额外结果需要接入方明确映射，本示例只选择原生表列指标。
