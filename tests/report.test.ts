import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_METRICS, profile, type MetricValue, type ProfileColumn, type ProfileResult } from 'data_profiling';
import { renderReport, type ReportOptions } from 'data_profiling/report';
import { openFixture } from './fixture.js';

const integer = (value: string): MetricValue => ({ type: 'integer', value });
const number = (value: number): MetricValue => ({ type: 'number', value });
const string = (value: string): MetricValue => ({ type: 'string', value });
const list = (...value: MetricValue[]): MetricValue => ({ type: 'list', value });
const object = (value: Record<string, MetricValue>): MetricValue => ({ type: 'object', value });
const english = { language: 'en-US' } as const;
const row = (metric: string, value: MetricValue, columns: string[] = [], table_name = 'orders'): ProfileResult => ({
  protocol_version: 1, table_name, columns, metric, parameters: {}, value,
});

test('report subpath renders actual native results without changing or recomputing them', async (t) => {
  const connection = await openFixture(t);
  const columns = (await connection.runAndReadAll("SELECT name,type FROM pragma_table_info('sample')")).getRowObjectsJson() as ProfileColumn[];
  const results = await profile(connection, 'sample', columns, {
    python: '/does/not/exist',
    metrics: ['row_count', 'column_count', 'profiling_type', 'missing_count', 'missing_rate',
      'missing_cell_rate', 'distinct_count', 'mean', 'min', 'max', 'numeric_histogram', 'value_counts', 'pearson_r'],
  });
  const before = structuredClone(results);
  const html = renderReport(results, { title: '订单画像', theme: 'auto', ...english });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>订单画像<\/title>/);
  assert.match(html, /data-theme="auto"/);
  assert.match(html, /class="histogram-plot"/);
  assert.match(html, /Missing values by column/);
  assert.match(html, /Pearson r/);
  assert.match(html, /Data quality observations/);
  assert.match(html, /class="bars"/);
  assert.deepEqual(results, before);
  assert.equal(html, renderReport(results, { title: '订单画像', theme: 'auto', ...english }));
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b|(?:src|href)="(?:https?:|\/\/)/i);
});

test('all scalar types and nested structures preserve exact values and typed nulls', () => {
  const values: MetricValue[] = [
    integer('90071992547409931234567890'),
    { type: 'decimal', value: '1234567890.1234567890123456789' },
    { type: 'timestamp', value: '2026-11-21T01:02:03.123456789' },
    { type: 'timestamptz', value: '2026-11-21T01:02:03.123456Z' },
    { type: 'date', value: '2026-11-21' },
    { type: 'duration', value: { amount: '9007199254740993', unit: 'nanosecond' } },
    { type: 'number', value: 'NaN' }, { type: 'number', value: 'Infinity' },
    { type: 'number', value: '-Infinity' }, number(0),
    { type: 'boolean', value: false }, string(''), { type: 'null', value: null },
    object({ a: list(integer('7'), string('中文 😀')), empty: object({}) }),
  ];
  const html = renderReport(values.map((value, i) => row(`metric_${i}`, value, ['value'])), english);
  for (const value of values.slice(0, 5)) assert.ok(html.includes(String(value.value)));
  for (const value of ['9007199254740993 ns', 'NaN', 'Infinity', '-Infinity', '(empty string)',
    'Undefined', 'Not supplied', 'No values', '中文 😀', 'false']) assert.ok(html.includes(value), value);
});

test('all user strings are escaped and never become HTML, styles, links or identifiers', () => {
  const attack = '</title><img src=x onerror="alert(1)"><script>alert(2)</script>&\'';
  const result = row(attack, object({ [attack]: list(string(attack)) }), [attack], attack);
  result.parameters = { [attack]: attack };
  const html = renderReport([result], { title: attack });
  assert.doesNotMatch(html, /<img\b|<script\b|<\/title><img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /id="table-0-column-0"/);
  assert.doesNotMatch(html, /id="[^\"]*alert/);
  assert.throws(() => renderReport([], { theme: attack } as unknown as ReportOptions), /options/);
});

test('tables, prototype-like column names and pairwise targets remain separate', () => {
  const html = renderReport([
    row('row_count', integer('11'), [], 'one'), row('mean', number(1), ['__proto__'], 'one'),
    row('mean', number(2), ['constructor'], 'one'),
    row('pearson_r', number(-0.75), ['__proto__', 'constructor'], 'one'),
    row('pearson_r', { type: 'null', value: null }, ['constructor', 'other'], 'one'),
    row('row_count', integer('22'), [], 'two'), row('mean', number(9), ['__proto__'], 'two'),
  ], english);
  assert.match(html, /2 tables/);
  assert.match(html, /id="table-1-column-0"/);
  assert.match(html, /<h2>one<\/h2>/);
  assert.match(html, /<h2>two<\/h2>/);
  assert.match(html, /coefficient negative/);
  assert.match(html, /--strength:0.75/);
  assert.match(html, /Undefined/);
  assert.match(html, /Not supplied/);
  assert.match(html, /Exact pairwise values/);
  assert.match(html, /__proto__ \/ constructor/);
  const objects = renderReport([row('objects', list(
    object({ ['__proto__']: string('own value'), toString: string('own function name') }),
    object({ other: string('other value') }),
  ))], english);
  assert.doesNotMatch(objects, /title="undefined"/);
  assert.match(objects, /own value/);
  assert.match(objects, /Not supplied/);
});

test('histograms respect unequal bins, density, temporal labels and extreme ranges', () => {
  const histogram = (edges: MetricValue[], counts = [number(2), number(4)]) => object({ counts: list(...counts), edges: list(...edges) });
  const density = row('numeric_histogram', histogram([number(0), number(1), number(4)]), ['n']);
  density.parameters = { density: true };
  const html = renderReport([
    density,
    row('datetime_histogram', histogram([
      { type: 'timestamptz', value: '2026-11-20T00:00:00Z' },
      { type: 'timestamptz', value: '2026-11-21T00:00:00Z' },
      { type: 'timestamptz', value: '2026-11-22T00:00:00Z' },
    ]), ['day']),
    row('numeric_histogram', histogram([number(-1e308), number(0), number(1e308)]), ['huge']),
    row('numeric_histogram', histogram([number(0), number(Number.MIN_VALUE)], [number(1)]), ['tiny']),
  ], english);
  assert.match(html, /Density/);
  assert.match(html, /height:50%;width:25%/);
  assert.match(html, /height:100%;width:75%/);
  assert.match(html, /2026-11-20T00:00:00Z/);
  assert.doesNotMatch(html, /(?:height|width):(?:NaN|Infinity)/);
  assert.equal((html.match(/class="histogram-plot"/g) ?? []).length, 4);
  const invalid = renderReport([row('numeric_histogram', histogram([number(2), number(1), number(0)]), ['n'])]);
  assert.doesNotMatch(invalid, /class="histogram-plot"/);
  assert.match(invalid, /numeric_histogram/);
});

test('frequency previews stay bounded and complete supplied data stays accessible', () => {
  const entries = list(...Array.from({ length: 15 }, (_, i) => object({ value: string(`category-${i}`), count: integer(String(15 - i)) })));
  const html = renderReport([
    row('value_counts', entries, ['channel']),
    row('value_counts_by_value', entries, ['channel']),
    row('top_values', object({ entries, truncated: { type: 'boolean', value: true } }), ['channel']),
  ], english);
  assert.equal((html.match(/class="bars"/g) ?? []).length, 1);
  assert.match(html, /first 12 of 15/);
  assert.match(html, /category-14/);
  const truncated = renderReport([row('top_values', object({ entries, truncated: { type: 'boolean', value: true } }), ['channel'])], english);
  assert.match(truncated, /Source frequencies are truncated/);
  const emptyPreview = renderReport([row('top_values', object({ entries: list(), truncated: { type: 'boolean', value: true } }), ['channel'])], english);
  assert.match(emptyPreview, /No supplied values to plot/);
  assert.match(emptyPreview, /Source frequencies are truncated/);
  assert.doesNotThrow(() => renderReport([row('top_values', object({}), ['channel'])]));
  const hugeCount = '9'.repeat(400);
  const huge = renderReport([row('value_counts', list(object({ value: string('huge'), count: integer(hugeCount) })), ['n'])], english);
  assert.ok(huge.includes(hugeCount));
  assert.doesNotMatch(huge, /No observations to plot/);
});

test('ACF and PACF show lag charts while retaining confidence intervals and null results', () => {
  const coefficients = list(object({ lag: integer('0'), coefficient: number(1), confidence_interval: list(number(0.9), number(1.1)) }),
    object({ lag: integer('1'), coefficient: number(-0.4), confidence_interval: list(number(-0.5), number(-0.3)) }));
  const html = renderReport([row('acf', coefficients, ['measurement']), row('pacf', { type: 'null', value: null }, ['measurement'])], english);
  assert.match(html, /aria-label="ACF by lag"/);
  assert.match(html, /Lag 1: -0.4/);
  assert.match(html, /confidence_interval/);
  assert.match(html, /Undefined/);
});

test('partial and empty profiles do not invent counts, rates or quality conclusions', () => {
  assert.match(renderReport([], english), /No profiling results were supplied/);
  assert.match(renderReport([]), /data-theme="light"/);
  const partial = renderReport([row('mean', number(12), ['amount'])], english);
  assert.match(partial, /Missing-value metrics were not supplied/);
  assert.match(partial, /Pairwise metrics were not supplied/);
  assert.match(partial, /No quality observations available/);
  assert.doesNotMatch(partial.slice(partial.indexOf('<body>')), /No issues|0%/);
  const zero = renderReport([row('row_count', integer('0')), row('missing_count', integer('0'), ['n'])], english);
  assert.doesNotMatch(zero, /NaN%|Infinity%/);
  assert.match(zero, /title="integer">0</);
  assert.doesNotMatch(zero, /class="bars"/);
});

test('invalid protocols, options, malformed and cyclic metric values fail explicitly', () => {
  for (const input of [null, {}, [null], [{ ...row('x', number(1)), protocol_version: 2 }],
    [{ ...row('x', number(1)), columns: ['a', 'b', 'c'] }],
    [{ ...row('x', number(1)), parameters: null }], [row('x', { type: 'boolean', value: 'yes' } as unknown as MetricValue)]]) {
    assert.throws(() => renderReport(input as ProfileResult[]), TypeError);
  }
  for (const options of [null, { theme: 'other' }, { title: 1 }, { unknown: true },
    { language: 'fr-FR' }, { language: null }, { language: 1 }, { language: { toString: () => 'zh-CN' } }]) {
    assert.throws(() => renderReport([], options as ReportOptions), /options/);
  }
  const cyclic = object({});
  if (cyclic.type === 'object') cyclic.value.self = cyclic;
  assert.throws(() => renderReport([row('x', cyclic)]), /cyclic/);
});

test('Chinese is the default and English remains available without leaking language between reports', () => {
  const results = [
    row('row_count', integer('10')),
    row('profiling_type', string('Numeric'), ['amount']),
    row('missing_count', integer('2'), ['amount']),
    row('mean', { type: 'null', value: null }, ['amount']),
    row('column_type_counts', object({ Numeric: integer('1') })),
    row('value_counts', list(object({ value: string('Web'), count: integer('8') })), ['amount']),
  ];
  results[3].parameters = { bins: 12, density: false };
  const before = structuredClone(results);
  const zh = renderReport(results);
  assert.match(zh, /lang="zh-CN"/);
  assert.match(zh, /<title>数据画像<\/title>/);
  for (const value of ['数据画像报告', '行数', '列详情', '数据质量观察', '缺失值', '取值频数',
    '数值', '均值', '未提供', '未定义', '参数', '分箱数', '概率密度', '否', '精确值与参数']) assert.ok(zh.includes(value), value);
  assert.match(zh, /<h2>orders<\/h2>/);
  assert.match(zh, />amount /);
  assert.match(zh, />Web</);
  const en = renderReport(results, english);
  assert.match(en, /lang="en-US"/);
  assert.match(en, /<title>Data profile<\/title>/);
  assert.match(en, /Data quality observations/);
  assert.doesNotMatch(en, /数据质量观察/);
  assert.equal(renderReport(results, { language: 'zh-CN' }), zh);
  assert.equal(renderReport(results, english), en);
  assert.deepEqual(results, before);
  assert.match(renderReport([]), /未提供数据画像结果/);
});

test('every catalog metric has a Chinese display label and machine IDs remain available', () => {
  const html = renderReport(ALL_METRICS.map((metric) => row(metric, number(1))));
  for (const metric of ALL_METRICS) {
    const displayed = html.match(new RegExp(`title="${metric}">([^<]+)</span>`))?.[1];
    assert.ok(displayed && /[\u4e00-\u9fff]/.test(displayed), `Missing Chinese label: ${metric}`);
  }
});

test('Chinese chart labels, tooltips, nested fields and empty states are translated', () => {
  const top = row('top_values', object({ entries: list(), truncated: { type: 'boolean', value: true } }), ['渠道']);
  const histogram = row('numeric_histogram', object({ counts: list(integer('3')), edges: list(number(0), number(1)) }), ['金额']);
  histogram.parameters = { density: true };
  const html = renderReport([
    top, histogram,
    row('acf', list(object({ lag: integer('1'), coefficient: number(0.5), confidence_interval: list(number(0.3), number(0.7)) })), ['金额']),
    row('pearson_r', number(0.5), ['金额', '件数']),
  ]);
  for (const value of ['数值直方图', '概率密度', '个分箱', '自相关（ACF）', '滞后阶数 1',
    '置信区间', '皮尔逊相关系数', '未提供可绘制的数据', '原始频数结果已截断', '列对精确值']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, />Data quality observations<|>Not supplied<|>Undefined<|>Numeric histogram</);
  assert.throws(() => renderReport([], { language: 'zh-CN" onload="alert(1)' } as unknown as ReportOptions), /options/);
});
