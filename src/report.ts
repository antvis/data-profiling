import type { MetricValue, ProfileResult } from './types.js';
import type { ReportRow, ReportTableData } from './report-data.js';
import { chinese, type Translate } from './report-language.js';
export type { ReportRow, ReportTableData } from './report-data.js';

export interface ReportOptions {
  title?: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: 'zh-CN' | 'en-US';
  tableData?: readonly ReportTableData[];
  run?: ReportRun;
}

export interface ReportRun {
  generatedAt: string;
  libraryVersion: string;
  durationMs?: number;
  configuration?: Record<string, unknown>;
}

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => entities[char]);
const label = (value: string, t: Translate) => t(value) !== value ? t(value) : value.replaceAll('_', ' ').replace(/^./, (char) => char.toUpperCase());
const absent = (t: Translate) => `<span class="muted">${t('Not supplied')}</span>`;
const percentage = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 2 });
const shortNumber = new Intl.NumberFormat('en', { maximumSignificantDigits: 5 });
const correlations = new Set(['pearson_r', 'spearman_rho', 'kendall_tau', 'cramers_v', 'phi_k', 'auto_correlation']);
const firstCharts = ['numeric_histogram', 'datetime_histogram', 'value_counts', 'top_values', 'length_histogram'];
const chartsByRole = new Map([
  ['Text', ['word_counts', 'length_histogram']],
  ['Image', ['image_dimension_counts', 'file_size_histogram']],
  ['File', ['file_size_histogram', 'value_counts']],
  ['TimeSeries', ['acf', 'pacf', 'numeric_histogram']],
]);
const summariesByRole = new Map([
  ['Text', ['mean_length', 'max_length']],
  ['Image', ['mean_image_width', 'mean_image_height', 'truncated_image_count']],
  ['File', ['path_suffix_distinct_count']],
  ['DateTime', ['min_timestamp', 'max_timestamp', 'invalid_date_count']],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate nested values from callers. Track ancestors so shared objects can appear in separate branches. */
function validateValue(value: unknown, parents = new Set<object>()): asserts value is MetricValue {
  if (!isRecord(value) || parents.has(value) || parents.size > 100) throw new TypeError('Invalid or cyclic MetricValue');
  const raw = value.value;
  switch (value.type) {
    case 'null':
      if (raw === null) return;
      break;
    case 'number':
      if (typeof raw === 'number' || raw === 'NaN' || raw === 'Infinity' || raw === '-Infinity') return;
      break;
    case 'boolean':
      if (typeof raw === 'boolean') return;
      break;
    case 'integer':
    case 'decimal':
    case 'string':
    case 'date':
    case 'timestamp':
    case 'timestamptz':
      if (typeof raw === 'string') return;
      break;
    case 'duration':
      if (isRecord(raw) && typeof raw.amount === 'string' && raw.unit === 'nanosecond') return;
      break;
    case 'list':
    case 'object':
      if (value.type === 'list' ? Array.isArray(raw) : isRecord(raw)) {
        parents.add(value);
        for (const item of Object.values(raw as object)) validateValue(item, parents);
        parents.delete(value);
        return;
      }
  }
  throw new TypeError('Invalid MetricValue');
}

function validateResult(row: unknown): asserts row is ProfileResult {
  if (!isRecord(row) || row.protocol_version !== 1 || typeof row.table_name !== 'string' ||
      !Array.isArray(row.columns) || row.columns.length > 2 || !row.columns.every((name) => typeof name === 'string') ||
      typeof row.metric !== 'string' || !isRecord(row.parameters)) throw new TypeError('Invalid protocol-v1 ProfileResult');
  validateValue(row.value);
}

/** Validate row context before charts use the column positions and matrix dimensions. */
function indexTableData(input: unknown): Map<string, ReportTableData> {
  if (!Array.isArray(input)) throw new TypeError('Invalid report table data');
  const result = new Map<string, ReportTableData>();
  for (const data of input as readonly ReportTableData[]) {
    if (!data || typeof data.tableName !== 'string' || !data.tableName || result.has(data.tableName) ||
        !Array.isArray(data.columns) || !data.columns.every((name) => typeof name === 'string') ||
        new Set(data.columns).size !== data.columns.length || !Number.isSafeInteger(data.rowCount) || data.rowCount < 0 ||
        !Array.isArray(data.numericColumns) || !data.numericColumns.every((name) => data.columns.includes(name))) {
      throw new TypeError('Invalid report table data');
    }
    const cells = (values: unknown): boolean => Array.isArray(values) && values.length === data.columns.length &&
      values.every((value) => value === null || typeof value === 'string');
    for (const rows of [data.head, data.tail, data.plotRows]) {
      if (!Array.isArray(rows) || !rows.every((row: ReportRow) => row && Number.isSafeInteger(row.position) &&
          row.position >= 1 && row.position <= data.rowCount && cells(row.values))) throw new TypeError('Invalid report rows');
    }
    if (!Array.isArray(data.duplicates) || !data.duplicates.every((row) => row && typeof row.count === 'string' &&
        /^\d+$/.test(row.count) && cells(row.values))) throw new TypeError('Invalid report duplicate groups');
    const heatmap = data.missingCorrelation;
    if (!heatmap || !Array.isArray(heatmap.columns) || !heatmap.columns.every((name) => data.columns.includes(name)) ||
        !Number.isSafeInteger(heatmap.columnCount) || heatmap.columnCount < heatmap.columns.length ||
        !Array.isArray(heatmap.coefficients) || heatmap.coefficients.length !== heatmap.columns.length ||
        !heatmap.coefficients.every((row) => Array.isArray(row) && row.length === heatmap.columns.length &&
          row.every((value) => value === null || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1)))) {
      throw new TypeError('Invalid report missingness correlations');
    }
    if (data.timeIndex !== undefined && (!data.timeIndex || !data.columns.includes(data.timeIndex.column) ||
        !['numeric', 'date'].includes(data.timeIndex.kind))) throw new TypeError('Invalid report time index');
    result.set(data.tableName, data);
  }
  return result;
}

function validateRun(run: unknown): asserts run is ReportRun {
  if (!isRecord(run) || typeof run.generatedAt !== 'string' || !Number.isFinite(Date.parse(run.generatedAt)) ||
      typeof run.libraryVersion !== 'string' || !run.libraryVersion ||
      (run.durationMs !== undefined && (typeof run.durationMs !== 'number' || !Number.isFinite(run.durationMs) || run.durationMs < 0)) ||
      (run.configuration !== undefined && !isRecord(run.configuration))) throw new TypeError('Invalid report run');
}

function text(value: MetricValue, t: Translate): string {
  if (value.type === 'null') return t('Undefined');
  if (value.type === 'duration') return `${value.value.amount} ${t('ns')}`;
  if (value.type === 'object') return `{${Object.entries(value.value).map(([key, item]) => `${key}: ${text(item, t)}`).join(', ')}}`;
  if (value.type === 'list') return `[${value.value.map((item) => text(item, t)).join(', ')}]`;
  if (value.type === 'boolean') return t(String(value.value));
  return value.value === '' ? t('(empty string)') : String(value.value);
}

function table(headers: string[], rows: string[][]): string {
  const head = headers.map((item) => `<th scope="col">${escape(item)}</th>`).join('');
  const body = rows.map(([first, ...rest]) =>
    `<tr><th scope="row">${first}</th>${rest.map((item) => `<td>${item}</td>`).join('')}</tr>`
  ).join('');
  return `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Keep absent metrics distinct from computed nulls and retain exact values in detail tables. */
function markup(value: MetricValue | undefined, t: Translate): string {
  if (!value) return absent(t);
  if (value.type === 'null') return `<span class="muted" title="${t('Computed result is undefined')}">${t('Undefined')}</span>`;
  if (value.type === 'object') {
    const items = Object.entries(value.value);
    return items.length ? table([t('Field'), t('Value')], items.map(([key, item]) => [escape(t(key)), markup(item, t)])) : `<span class="muted">${t('No values')}</span>`;
  }
  if (value.type === 'list') {
    if (!value.value.length) return `<span class="muted">${t('No values')}</span>`;
    if (value.value.every((item) => item.type === 'object')) {
      const keys = [...new Set(value.value.flatMap((item) => Object.keys(item.value)))];
      if (keys.length) return table(keys.map(t), value.value.map((item) => keys.map((key) => markup(Object.hasOwn(item.value, key) ? item.value[key] : undefined, t))));
    }
    return `<ol class="value-list">${value.value.map((item) => `<li>${markup(item, t)}</li>`).join('')}</ol>`;
  }
  return `<span class="value" title="${t(value.type)}">${escape(text(value, t))}</span>`;
}

/** Use finite approximations for chart geometry while retaining the original metric values. */
function numeric(value: MetricValue | undefined): number | undefined {
  if (!value || !['integer', 'decimal', 'number'].includes(value.type)) return undefined;
  const number = Number(value.value);
  return Number.isFinite(number) ? number : undefined;
}

function parametersMarkup(parameters: Record<string, unknown>, t: Translate): string {
  return Object.entries(parameters).map(([key, value]) =>
    `<span title="${escape(key)}">${escape(t(key))}</span>: <code>${escape(typeof value === 'boolean' ? t(String(value)) : JSON.stringify(value) ?? String(value))}</code>`
  ).join('<br>') || '—';
}

function metricTable(rows: readonly ProfileResult[], t: Translate): string {
  return table([t('Metric'), t('Value'), t('Parameters')], rows.map((row) => [
    `<span title="${escape(row.metric)}">${escape(label(row.metric, t))}</span>`,
    row.metric === 'profiling_type' && row.value.type === 'string' ? escape(t(row.value.value)) : markup(row.value, t),
    parametersMarkup(row.parameters, t),
  ]));
}

interface FrequencyItem { name: string; amount: number; detail: string }

function barChart(items: FrequencyItem[], caption: string, note: string, t: Translate): string {
  const peak = items.reduce((max, item) => Math.max(max, item.amount), 0);
  const bars = items.map((item) => `<li>
    <span class="bar-label" title="${escape(item.name)}">${escape(item.name)}</span>
    <span class="track" title="${escape(item.detail)}"><span style="width:${peak ? item.amount / peak * 100 : 0}%"></span></span>
    <span class="bar-value">${escape(item.detail)}</span>
  </li>`).join('');
  return `<figure class="chart"><figcaption>${escape(caption)}</figcaption>${bars ? `<ul class="bars">${bars}</ul>` : `<p class="muted">${t('No supplied values to plot.')}</p>`}${note}</figure>`;
}

function wordCloud(items: FrequencyItem[], t: Translate): string {
  const words = items.filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount);
  const visible = words.slice(0, 24);
  if (!visible.length) return '';
  const peak = visible[0].amount;
  const cloud = visible.map(({ name, amount, detail }) =>
    `<li style="--word-size:${(0.8 + 1.8 * Math.sqrt(amount / peak)).toFixed(2)}rem" title="${escape(`${name} · ${detail}`)}"><span>${escape(name)}</span></li>`
  ).join('');
  const note = visible.length === words.length ? t('Text size shows frequency.') :
    t('Text size shows frequency. {shown} of {count} words.').replace('{shown}', String(visible.length)).replace('{count}', String(words.length));
  return `<figure class="chart word-cloud"><figcaption>${t('Word cloud')}</figcaption>
    <ul class="cloud-words">${cloud}</ul><p class="chart-note">${note}</p></figure>`;
}

function imageSizePlot(items: (FrequencyItem & { value: MetricValue })[], t: Translate): string {
  const points = items.flatMap((item) => {
    if (item.value.type !== 'list' || item.value.value.length !== 2 || item.amount <= 0) return [];
    const [width, height] = item.value.value.map(numeric);
    return width !== undefined && height !== undefined && width > 0 && height > 0 ? [{ ...item, width, height }] : [];
  });
  if (!points.length) return '';
  const maxWidth = points.reduce((max, point) => Math.max(max, point.width), 0);
  const maxHeight = points.reduce((max, point) => Math.max(max, point.height), 0);
  const maxCount = points.reduce((max, point) => Math.max(max, point.amount), 0);
  const dots = points.map(({ width, height, amount, detail }) => {
    const size = 7 + 17 * Math.sqrt(amount / maxCount);
    const title = `${shortNumber.format(width)} × ${shortNumber.format(height)} · ${detail}`;
    return `<span class="size-dot" style="left:${width / maxWidth * 100}%;bottom:${height / maxHeight * 100}%;--dot-size:${size}px" title="${escape(title)}"></span>`;
  }).join('');
  return `<figure class="chart image-sizes"><figcaption>${t('Image sizes')}</figcaption>
    <div class="size-axis-label">${t('Height (px)')}</div>
    <div class="histogram-layout size-layout"><div class="scale"><span>${shortNumber.format(maxHeight)}</span><span>0</span></div>
      <div class="size-plot" role="img" aria-label="${t('Image width and height by frequency')}">${dots}</div></div>
    <div class="axis"><span>${t('Width (px)')}</span><span>${shortNumber.format(maxWidth)}</span></div>
    <p class="chart-note">${t('Dot size shows frequency.')}</p></figure>`;
}

function chart(row: ProfileResult, t: Translate, role?: string): string {
  const value = row.value;
  if (row.metric === 'gap_endpoints') return gapChart(value, t);
  if (row.metric.endsWith('_histogram') && value.type === 'object') {
    const counts = value.value.counts, edges = value.value.edges;
    if (counts?.type !== 'list' || edges?.type !== 'list') return '';
    if (!counts.value.length && !edges.value.length) return `<p class="muted">${t('No observations to plot.')}</p>`;
    const heights = counts.value.map(numeric);
    const positions = edges.value.map((edge) => ['date', 'timestamp', 'timestamptz'].includes(edge.type) ? Date.parse(String(edge.value)) : numeric(edge));
    if (positions.length !== heights.length + 1 || heights.some((n) => n === undefined || n < 0) ||
        positions.some((n, i) => n === undefined || !Number.isFinite(n) || (i > 0 && n <= positions[i - 1]!))) return '';
    const peak = heights.reduce<number>((max, n) => Math.max(max, n!), 0);
    const low = positions[0]!, high = positions[positions.length - 1]!;
    const scale = Math.max(Math.abs(low), Math.abs(high), Number.MIN_VALUE);
    const span = high / scale - low / scale;
    const density = row.parameters.density === true;
    const bins = heights.map((height, i) => {
      const width = (positions[i + 1]! / scale - positions[i]! / scale) / span * 100;
      const detail = `${text(edges.value[i], t)} ${t('to')} ${text(edges.value[i + 1], t)}: ${text(counts.value[i], t)}`;
      return `<span style="height:${peak ? height! / peak * 100 : 0}%;width:${width}%" title="${escape(detail)}"></span>`;
    }).join('');
    return `<figure class="chart histogram">
      <figcaption>${escape(label(row.metric, t))}${density ? ` · ${t('Density')}` : ''}</figcaption>
      <div class="histogram-layout">
        <div class="scale"><span>${shortNumber.format(peak)}</span><span>0</span></div>
        <div class="histogram-plot" role="img" aria-label="${escape(label(row.metric, t))} · ${heights.length} ${t('histogram bins')}">${bins}</div>
      </div>
      <div class="axis"><span>${escape(text(edges.value[0], t))}</span><span>${escape(text(edges.value[edges.value.length - 1], t))}</span></div>
    </figure>`;
  }
  if ((row.metric === 'acf' || row.metric === 'pacf') && value.type === 'list') {
    const points = value.value.flatMap((item) => {
      if (item.type !== 'object') return [];
      const lag = numeric(item.value.lag), coefficient = numeric(item.value.coefficient);
      return lag === undefined || coefficient === undefined ? [] : [{ lag, coefficient }];
    });
    if (!points.length) return '';
    const maxLag = points.reduce((max, point) => Math.max(max, point.lag), 1);
    const scale = points.reduce((max, point) => Math.max(max, Math.abs(point.coefficient)), 1);
    const stems = points.map(({ lag, coefficient }) =>
      `<path class="stem" d="M${15 + lag / maxLag * 570} 100v${-coefficient / scale * 85}"><title>${escape(`${t('Lag')} ${lag}: ${coefficient}`)}</title></path>`
    ).join('');
    const caption = t(row.metric) === row.metric ? row.metric.toUpperCase() : t(row.metric);
    return `<figure class="chart"><figcaption>${caption}</figcaption>
      <svg class="lag-chart" viewBox="0 0 600 200" role="img" aria-label="${caption} ${t('by lag')}">
        <path class="baseline" d="M15 100H585"/>${stems}
      </svg>
      <div class="axis"><span>${t('Lag')} 0</span><span>${t('Lag')} ${maxLag}</span></div>
    </figure>`;
  }
  const entries = value.type === 'object' && row.metric === 'top_values' ? value.value.entries : value;
  if (!entries || entries.type !== 'list' ||
      (!entries.value.length && !/(?:counts|frequencies|top_values)$/.test(row.metric)) ||
      !entries.value.every((item) => item.type === 'object' && item.value.value && item.value.count)) return '';
  const items = entries.value.flatMap((entry) => {
    if (entry.type !== 'object') return [];
    const amount = numeric(entry.value.count);
    return amount === undefined || amount < 0 ? [] : [{ value: entry.value.value, name: text(entry.value.value, t), amount, detail: text(entry.value.count, t) }];
  });
  if (items.length !== entries.value.length) return '';
  if (row.metric === 'image_dimension_counts') return imageSizePlot(items, t);
  if (row.metric === 'word_counts' && (role === undefined || role === 'Text')) {
    const words = items.filter((item) => item.value.type === 'string' && item.value.value.trim());
    return wordCloud(words, t);
  }
  const note = items.length > 12 ? `<p class="muted">${t('Showing the first 12 of {count} supplied values. Full data below.').replace('{count}', String(items.length))}</p>` : '';
  const truncated = value.type === 'object' && value.value.truncated?.type === 'boolean' && value.value.truncated.value;
  return barChart(items.slice(0, 12), label(row.metric, t), note + (truncated ? `<p class="muted">${t('Source frequencies are truncated.')}</p>` : ''), t);
}

function columnCharts(metrics: ProfileResult[], stats: ReadonlyMap<string, MetricValue>, role: string | undefined,
    anchor: string, t: Translate): string {
  const order = new Map([...new Set([...(chartsByRole.get(role ?? '') ?? []), ...firstCharts])].map((key, index) => [key, index]));
  const cards = metrics
    .filter((row) => !(['top_values', 'value_counts_by_value'].includes(row.metric) && stats.has('value_counts')))
    .sort((a, b) => (order.get(a.metric) ?? order.size) - (order.get(b.metric) ?? order.size))
    .map((row) => chart(row, t, role)).filter(Boolean);
  if (!cards.length) return '';
  const limit = role === 'TimeSeries' ? 3 : 2;
  const more = cards.slice(limit);
  return `<div class="grid">${cards.slice(0, limit).join('')}</div>${more.length ?
    `<details class="raw more-charts" id="${anchor}-charts"><summary>${t('More charts ({count})').replace('{count}', String(more.length))}</summary><div class="grid">${more.join('')}</div></details>` : ''}`;
}

function typeDistribution(value: MetricValue | undefined, columns: Map<string, ProfileResult[]>, t: Translate): string {
  const inferred = new Map<string, number>();
  if (value?.type !== 'object') {
    for (const metrics of columns.values()) {
      const role = metrics.find((row) => row.metric === 'profiling_type')?.value;
      if (role?.type === 'string') inferred.set(role.value, (inferred.get(role.value) ?? 0) + 1);
    }
  }
  const counts = value?.type === 'object' ? Object.entries(value.value) :
    [...inferred].map(([role, count]): [string, MetricValue] => [role, { type: 'number', value: count }]);
  const types = counts.flatMap(([role, count], index) => {
    const size = numeric(count);
    const hue = (206 + index * 137) % 360;
    return size !== undefined && size > 0 ? [{ role, count, size, hue }] : [];
  });
  if (!types.length) return '';
  const peak = types.reduce((max, type) => Math.max(max, type.size), 0);
  return `<div class="type-distribution"><span class="type-heading">${t('Column types')}</span>
    <div class="type-track" aria-hidden="true">${types.map(({ size, hue }) => `<span style="--share:${size / peak};--type-hue:${hue}"></span>`).join('')}</div>
    <ul class="type-legend">${types.map(({ role, count, hue }) => `<li style="--type-hue:${hue}"><span>${escape(t(role))}</span> ${markup(count, t)}</li>`).join('')}</ul></div>`;
}

function duplicateSizes(value: MetricValue | undefined, t: Translate): string {
  if (value?.type !== 'list') return '';
  const counts = new Map<string, number>();
  for (const size of value.value) {
    if ((numeric(size) ?? 0) < 2) continue;
    const key = text(size, t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return '';
  const items = [...counts].map(([size, amount]) => ({
    name: t('{count} rows').replace('{count}', size), amount, detail: String(amount),
  }));
  const note = items.length > 12 ? t('Row counts per group are in the table details.') : t('Bar length shows the number of groups.');
  return barChart(items.slice(0, 12), t('Duplicate groups by size'), `<p class="chart-note">${note}</p>`, t);
}

/** Surface statistical observations only when the supplied metrics support them. */
function observations(columns: Map<string, ProfileResult[]>, duplicates: MetricValue | undefined,
    pairs: readonly RankedPair[], columnLink: (name: string) => string, t: Translate): string {
  const rows: string[][] = [];
  if ((numeric(duplicates) ?? 0) > 0) rows.push([t('Whole table'), label('duplicate_group_count', t), markup(duplicates, t)]);
  for (const [name, metrics] of columns) {
    const values = new Map(metrics.map((row) => [row.metric, row.value]));
    const link = columnLink(name);
    for (const [metric, description] of [
      ['missing_count', 'Missing values'], ['infinity_count', 'Infinite values'],
      ['invalid_date_count', 'Invalid dates'], ['truncated_image_count', 'Truncated images'],
    ]) {
      const value = values.get(metric) ?? (metric === 'missing_count' ? values.get('null_count') : undefined);
      if ((numeric(value) ?? 0) > 0) rows.push([link, t(description), markup(value, t)]);
    }
    if (numeric(values.get('distinct_count')) === 1) rows.push([link, t('One distinct non-missing value'), markup(values.get('distinct_count'), t)]);
    const type = values.get('profiling_type');
    if (type?.type === 'string' && ['Categorical', 'Text'].includes(type.value) && (numeric(values.get('distinct_count')) ?? 0) > 50) {
      rows.push([link, t('High cardinality (>50 distinct values)'), markup(values.get('distinct_count'), t)]);
    }
    const skew = numeric(values.get('skewness'));
    if (skew !== undefined && Math.abs(skew) >= 1) rows.push([link, t('Skewed distribution (absolute skewness ≥1)'), shortNumber.format(skew)]);
    const imbalance = numeric(values.get('category_imbalance_score'));
    if (imbalance !== undefined && imbalance >= 0.5) rows.push([link, t('Category imbalance (score ≥0.5)'), shortNumber.format(imbalance)]);
  }
  for (const { row, amount } of pairs.slice(0, 8)) {
    if (Math.abs(amount) < 0.9) break;
    rows.push([row.columns.map(columnLink).join(' × '),
      `${t('Strong association (absolute coefficient ≥0.9)')} · ${escape(label(row.metric, t))}`,
      coefficient(row.value, amount, t)]);
  }
  return rows.length ? table([t('Target'), t('Observation'), t('Value')], rows) : `<p class="muted">${t('No quality observations available from the supplied metrics.')}</p>`;
}

function missingValues(columns: Map<string, ProfileResult[]>, rowCount: MetricValue | undefined,
    columnLink: (name: string) => string, t: Translate): string {
  const data: { name: string; count?: MetricValue; rate?: number }[] = [];
  for (const [name, metrics] of columns) {
    const values = new Map(metrics.map((row) => [row.metric, row.value]));
    const count = values.get('missing_count') ?? values.get('null_count');
    const total = numeric(values.get('observation_count') ?? rowCount);
    const missing = numeric(count);
    const rate = numeric(values.get('missing_rate')) ?? (missing !== undefined && total !== undefined && total > 0 ? missing / total : undefined);
    if (count || rate !== undefined) data.push({ name, count, rate });
  }
  if (!data.length) return `<p class="muted">${t('Missing-value metrics were not supplied.')}</p>`;
  data.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const rows = data.map(({ name, count, rate }) => [columnLink(name), markup(count, t), rate === undefined ? absent(t) : percentage.format(rate)]);
  const bars = data.flatMap(({ name, rate }) => rate !== undefined && rate >= 0 && rate <= 1 ?
    [`<li><span class="bar-label" title="${escape(name)}">${columnLink(name)}</span><span class="track"><span style="width:${rate * 100}%"></span></span><span>${percentage.format(rate)}</span></li>`] : []);
  return `${bars.length ? `<figure class="chart coverage"><figcaption>${t('Missing values by column')}</figcaption><ul class="bars">${bars.join('')}</ul></figure>` : ''}<details class="raw"><summary>${t('Column counts')}</summary>${table([t('Column'), t('Missing'), t('Missing rate')], rows)}</details>`;
}

function coefficient(value: MetricValue, amount: number, t: Translate): string {
  return `<span class="coefficient${amount < 0 ? ' negative' : ''}" style="--strength:${Math.min(1, Math.abs(amount))}" title="${escape(text(value, t))}">${shortNumber.format(amount)}</span>`;
}

interface RankedPair { row: ProfileResult; amount: number }

function rankPairs(rows: readonly ProfileResult[]): RankedPair[] {
  const pairs = new Map<string, RankedPair>();
  for (const row of rows) {
    const amount = numeric(row.value);
    if (!correlations.has(row.metric) || row.columns[0] === row.columns[1] || amount === undefined) continue;
    const key = JSON.stringify([...row.columns].sort());
    const previous = pairs.get(key);
    if (!previous || Math.abs(amount) > Math.abs(previous.amount)) pairs.set(key, { row, amount });
  }
  return [...pairs.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

function pairwise(rows: ProfileResult[], ranked: readonly RankedPair[], prefix: string, columnLink: (name: string) => string, t: Translate): string {
  if (!rows.length) return `<p class="muted">${t('Pairwise metrics were not supplied.')}</p>`;
  const methods = new Map<string, ProfileResult[]>();
  for (const row of rows) {
    if (!methods.has(row.metric)) methods.set(row.metric, []);
    methods.get(row.metric)!.push(row);
  }
  const strongest = ranked.slice(0, 8);
  const ranking = strongest.length ? `<div class="strongest-pairs"><h4>${t('Strongest pairs')}</h4>${table([t('Column pair'), t('Method'), t('Value')], strongest.map(({ row, amount }) => [
    row.columns.map(columnLink).join(' × '), escape(label(row.metric, t)), coefficient(row.value, amount, t),
  ]))}<p class="chart-note">${t('Each pair shows its highest absolute coefficient among the reported methods.')}</p></div>` : '';
  const ordered = [...methods].sort(([a], [b]) => Number(b === 'auto_correlation') - Number(a === 'auto_correlation'));
  const matrices = ordered.map(([method, metrics], index) => {
    const name = escape(label(method, t));
    const names = [...new Set(metrics.flatMap((row) => row.columns))];
    const cells = new Map<string, MetricValue>();
    for (const row of metrics) {
      cells.set(JSON.stringify(row.columns), row.value);
      cells.set(JSON.stringify([...row.columns].reverse()), row.value);
    }
    const matrix = table([t('Column'), ...names], names.map((name) => [columnLink(name), ...names.map((other) => {
      const value = cells.get(JSON.stringify([name, other]));
      const number = numeric(value);
      return value && number !== undefined && correlations.has(method)
        ? coefficient(value, number, t)
        : markup(value, t);
    })]));
    return `<details class="correlation-method" id="${prefix}-correlation-${index}" name="${prefix}-correlation"${index === 0 ? ' open' : ''}><summary title="${escape(method)}">${name}</summary>
      <figure class="chart matrix" aria-label="${name}">${matrix}<details class="raw" id="${prefix}-correlation-${index}-exact"><summary>${t('Exact pairwise values')}</summary>${table([t('Column pair'), t('Value'), t('Parameters')], metrics.map((row) => [escape(row.columns.join(' / ')), markup(row.value, t), parametersMarkup(row.parameters, t)]))}</details></figure></details>`;
  }).join('');
  return `${ranking}<div class="correlation-methods">${matrices}</div>`;
}

function previewCells(values: readonly (string | null)[], t: Translate): string[] {
  return values.map((value) => value === null ? `<span class="muted">${t('Missing cell')}</span>` :
    `<span class="value">${escape(value || t('(empty string)'))}</span>`);
}

function rowSamples(data: ReportTableData, prefix: string, t: Translate): string {
  if (!data.head.length) return `<p class="muted">${t('No rows to preview.')}</p>`;
  const headers = [t('Row'), ...data.columns];
  const rows = (sample: readonly ReportRow[]) => table(headers, sample.map(({ position, values }) =>
    [String(position), ...previewCells(values, t)]));
  return `<details class="sample-rows" id="${prefix}-sample-head" open><summary>${t('First {count} rows').replace('{count}', String(data.head.length))}</summary>${rows(data.head)}</details>
    ${data.tail.length ? `<details class="sample-rows" id="${prefix}-sample-tail"><summary>${t('Last {count} rows').replace('{count}', String(data.tail.length))}</summary>${rows(data.tail)}</details>` : ''}
    <p class="chart-note">${t('Long cell values are shortened to 240 characters.')}</p>`;
}

function duplicateRows(data: ReportTableData, t: Translate): string {
  if (!data.duplicates.length) return `<p class="muted">${t('No duplicate rows.')}</p>`;
  return `<h4>${t('Most frequent duplicate groups')}</h4>
    ${table([t('Occurrences'), ...data.columns], data.duplicates.map(({ count, values }) => [escape(count), ...previewCells(values, t)]))}
    <p class="chart-note">${t('Up to 10 groups, ordered by occurrence count. Long cell values are shortened to 240 characters.')}</p>`;
}

function plottedRows(data: ReportTableData, t: Translate): string {
  if (data.plotRows.length === data.rowCount) return t('Plot sample includes all {count} rows.').replace('{count}', String(data.rowCount));
  return t('{shown} of {count} rows plotted.').replace('{shown}', String(data.plotRows.length)).replace('{count}', String(data.rowCount));
}

function missingPatterns(data: ReportTableData, t: Translate): string {
  if (!data.plotRows.length || !data.columns.length) return '';
  const marks = data.plotRows.map(({ position, values }, i) => {
    const path = values.flatMap((value, col) => value === null ? [`M${col} ${i}h1v1h-1z`] : []).join('');
    return `<g><title>${t('Row')} ${position}</title><rect width="${data.columns.length}" height="1" y="${i}" fill="transparent"/><path d="${path}"/></g>`;
  }).join('');
  const names = data.columns.map((column) => `<span title="${escape(column)}">${escape(column)}</span>`).join('');
  const mask = `<figure class="chart missing-pattern"><figcaption>${t('Missing locations')}</figcaption>
    <div class="mask-scroll" tabindex="0" aria-label="${t('Missing locations')}">
      <div class="mask-grid" style="--mask-columns:${data.columns.length}"><div class="mask-names">${names}</div>
        <svg class="mask-rows" viewBox="0 0 ${data.columns.length} ${data.plotRows.length}" preserveAspectRatio="none" role="img" aria-label="${t('Missing cells by row and column')}">${marks}</svg>
      </div>
    </div>
    <p class="chart-note">${plottedRows(data, t)} <span class="missing-key">${t('Missing cell')}</span></p></figure>`;
  const heatmap = data.missingCorrelation;
  const values = heatmap.columns.length < 2 ? `<p class="muted">${t('At least two columns must contain both present and missing values.')}</p>` :
    `${table([t('Column'), ...heatmap.columns], heatmap.columns.map((name, i) => [
      escape(name), ...heatmap.coefficients[i].map((value) => value === null ? markup({ type: 'null', value }, t) : coefficient({ type: 'number', value }, value, t)),
    ]))}
    <p class="chart-note">${t('Calculated from all rows. Positive values indicate that columns tend to be missing together.')}</p>
    ${heatmap.columnCount > heatmap.columns.length ? `<p class="chart-note">${t('Showing {shown} of {count} columns with both present and missing values.').replace('{shown}', String(heatmap.columns.length)).replace('{count}', String(heatmap.columnCount))}</p>` : ''}`;
  return `${mask}<figure class="chart missing-correlation"><figcaption>${t('Missingness correlation')}</figcaption>${values}</figure>`;
}

interface PlotPoint { x: number; xLabel: string; y?: number; yLabel?: string; position?: number }
interface PlotGap { from: number; to: number; fromLabel: string; toLabel: string }

function coordinate(value: string | null | undefined, temporal = false): number | undefined {
  if (!value?.trim()) return undefined;
  if (!temporal) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  const date = value.trim();
  if (/^[+-]?\d+$/.test(date)) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}/.test(date);
  let utc = iso ? date.replace(' ', 'T') : `${date} UTC`;
  if (iso && utc.includes('T') && !/Z$|[+-]\d{2}:\d{2}$/.test(utc)) utc += /[+-]\d{2}$/.test(utc) ? ':00' : 'Z';
  const parsed = Date.parse(utc);
  const number = Number.isFinite(parsed) ? parsed : Date.parse(date);
  return Number.isFinite(number) ? number : undefined;
}

function axisRatio(value: number, min: number, max: number): number {
  if (min === max) return 0.5;
  // Scale endpoints before subtracting so a range spanning extreme values can stay finite.
  const scale = Math.max(Math.abs(min), Math.abs(max), Number.MIN_VALUE);
  const fraction = (value / scale - min / scale) / (max / scale - min / scale);
  return Math.min(1, Math.max(0, fraction));
}

function gapsFor(value: MetricValue | undefined, t: Translate): PlotGap[] {
  if (value?.type !== 'list') return [];
  return value.value.flatMap((pair) => {
    if (pair.type !== 'list' || pair.value.length !== 2) return [];
    const [a, b] = pair.value;
    const from = numeric(a) ?? coordinate(text(a, t), true);
    const to = numeric(b) ?? coordinate(text(b, t), true);
    if (from === undefined || to === undefined || from === to) return [];
    return from < to
      ? [{ from, to, fromLabel: text(a, t), toLabel: text(b, t) }]
      : [{ from: to, to: from, fromLabel: text(b, t), toLabel: text(a, t) }];
  }).sort((a, b) => a.from - b.from);
}

function gapChart(value: MetricValue, t: Translate): string {
  const gaps = gapsFor(value, t);
  if (!gaps.length) return '';
  const first = gaps[0], last = gaps.reduce((end, gap) => gap.to > end.to ? gap : end);
  const bands = gaps.map((gap) => {
    const x = axisRatio(gap.from, first.from, last.to) * 620;
    const end = axisRatio(gap.to, first.from, last.to) * 620;
    return `<rect class="series-gap" x="${10 + x}" width="${Math.max(1, end - x)}" y="6" height="22"><title>${escape(`${gap.fromLabel} – ${gap.toLabel}`)}</title></rect>`;
  }).join('');
  return `<figure class="chart time-gaps"><figcaption>${t('Time gaps')}</figcaption>
    <svg viewBox="0 0 640 34" preserveAspectRatio="none" role="img" aria-label="${t('Time gaps')}"><path class="plot-grid" d="M10 28H630"/>${bands}</svg>
    <div class="axis"><span>${escape(first.fromLabel)}</span><span>${escape(last.toLabel)}</span></div></figure>`;
}

function xyChart(points: readonly PlotPoint[], xName: string, yName: string, t: Translate, gaps?: readonly PlotGap[]): string {
  const measured = points.filter((point) => point.y !== undefined);
  if (!measured.length) return '';
  const lowY = measured.reduce((low, point) => point.y! < low.y! ? point : low);
  const highY = measured.reduce((high, point) => point.y! > high.y! ? point : high);
  const lowX = points.reduce((low, point) => point.x < low.x ? point : low);
  const highX = points.reduce((high, point) => point.x > high.x ? point : high);
  const x = (value: number) => (10 + axisRatio(value, lowX.x, highX.x) * 620).toFixed(2);
  const y = (value: number) => (175 - axisRatio(value, lowY.y!, highY.y!) * 165).toFixed(2);
  const grid = '<path class="plot-grid" d="M10 10V175H630M10 51H630M10 92H630M10 133H630"/>';
  let drawings = '';
  if (gaps) {
    const shading = gaps.flatMap((gap) => {
      if (gap.to < lowX.x || gap.from > highX.x) return [];
      const begin = x(gap.from), end = x(gap.to);
      return [`<rect class="series-gap" x="${begin}" y="10" width="${Math.max(1, Number(end) - Number(begin))}" height="165"><title>${escape(`${gap.fromLabel} – ${gap.toLabel}`)}</title></rect>`];
    }).join('');
    let previous: PlotPoint | undefined;
    let gapIndex = 0;
    const path: string[] = [];
    for (const point of points) {
      if (point.y === undefined) { previous = undefined; continue; }
      while (previous && gapIndex < gaps.length && gaps[gapIndex].to <= previous.x) gapIndex++;
      const gap = gaps[gapIndex];
      const connects = previous && !(gap && gap.from >= previous.x && gap.to <= point.x);
      path.push(`${connects ? 'L' : 'M'}${x(point.x)} ${y(point.y)}`);
      previous = point;
    }
    drawings = `${shading}<path class="series-line" d="${path.join(' ')}"/>`;
    if (measured.length === 1) drawings += `<circle class="scatter-dot" cx="${x(measured[0].x)}" cy="${y(measured[0].y!)}" r="3.5"/>`;
  } else {
    drawings = measured.map((point) => `<circle class="scatter-dot" cx="${x(point.x)}" cy="${y(point.y!)}" r="3.5"><title>${escape(`${t('Row')} ${point.position} · ${xName} ${point.xLabel} · ${yName} ${point.yLabel}`)}</title></circle>`).join('');
  }
  const caption = gaps ? yName : `${xName} × ${yName}`;
  return `<figure class="chart ${gaps ? 'series-chart' : 'scatter-chart'}">
    <div class="plot-axis-name">${escape(yName)}</div>
    <div class="plot-layout">
      <div class="scale"><span title="${escape(highY.yLabel!)}">${shortNumber.format(highY.y!)}</span><span title="${escape(lowY.yLabel!)}">${shortNumber.format(lowY.y!)}</span></div>
      <svg class="xy-plot" viewBox="0 0 640 185" preserveAspectRatio="none" role="img" aria-label="${escape(caption)}">${grid}${drawings}</svg>
      <div class="axis plot-range"><span>${escape(lowX.xLabel)}</span><span>${escape(highX.xLabel)}</span></div>
      <div class="plot-axis-name plot-x-name">${escape(xName)}</div>
    </div>
    ${gaps?.length ? `<p class="chart-note"><span class="missing-key">${t('Time gaps')}</span></p>` : ''}</figure>`;
}

function interactions(data: ReportTableData, ranked: readonly RankedPair[], prefix: string, t: Translate): string {
  const numeric = new Set(data.numericColumns);
  const indices = new Map(data.columns.map((name, i) => [name, i]));
  const seen = new Set<string>();
  const charts: { caption: string; chart: string }[] = [];
  const plot = (a: string, b: string) => {
    const key = JSON.stringify([a, b].sort());
    if (seen.has(key)) return;
    seen.add(key);
    const i = indices.get(a)!, j = indices.get(b)!;
    const points = data.plotRows.flatMap(({ position, values }) => {
      const x = coordinate(values[i]), y = coordinate(values[j]);
      return x === undefined || y === undefined ? [] : [{ x, y, xLabel: values[i]!, yLabel: values[j]!, position }];
    });
    const chart = xyChart(points, a, b, t);
    if (chart) charts.push({ caption: `${a} × ${b}`, chart });
  };
  for (const { row } of ranked) {
    if (charts.length >= 12) break;
    if (row.columns.every((name) => numeric.has(name))) plot(row.columns[0], row.columns[1]);
  }
  for (let i = 0; i < data.numericColumns.length && charts.length < 12; i++) {
    for (let j = i + 1; j < data.numericColumns.length && charts.length < 12; j++) plot(data.numericColumns[i], data.numericColumns[j]);
  }
  if (!charts.length) return '';
  return `<p class="section-note">${plottedRows(data, t)} ${t('Only rows with two finite values appear in each plot.')}</p>
    ${charts.map(({ caption, chart }, i) => `<details class="row-plot" id="${prefix}-interaction-${i}" name="${prefix}-interactions"${i === 0 ? ' open' : ''}><summary>${escape(caption)}</summary>${chart}</details>`).join('')}
    ${charts.length === 12 ? `<p class="chart-note">${t('Up to 12 pairs are shown, prioritizing stronger correlations.')}</p>` : ''}`;
}

function timeSeries(data: ReportTableData, columns: Map<string, ProfileResult[]>, prefix: string, t: Translate): string {
  if (!data.timeIndex) return '';
  const index = data.columns.indexOf(data.timeIndex.column);
  const candidates = data.numericColumns.filter((name) => name !== data.timeIndex!.column);
  const assigned = candidates.filter((name) => columns.get(name)?.some((row) => row.metric === 'profiling_type' && row.value.value === 'TimeSeries'));
  const charts = (assigned.length ? assigned : candidates).flatMap((name, i) => {
    const field = data.columns.indexOf(name);
    const points = data.plotRows.flatMap(({ values }) => {
      const x = coordinate(values[index], data.timeIndex!.kind === 'date');
      const y = coordinate(values[field]);
      return x === undefined ? [] : [{ x, y, xLabel: values[index]!, yLabel: values[field] ?? undefined }];
    }).sort((a, b) => a.x - b.x);
    const gaps = gapsFor(columns.get(name)?.find((row) => row.metric === 'gap_endpoints')?.value, t);
    const chart = xyChart(points, data.timeIndex!.column, name, t, gaps);
    return chart ? [{ name, chart, i }] : [];
  });
  if (!charts.length) return '';
  return `<p class="section-note">${plottedRows(data, t)}</p>${charts.map(({ name, chart, i }, index) => `<details class="row-plot" id="${prefix}-series-${i}" name="${prefix}-series"${index === 0 ? ' open' : ''}><summary>${escape(name)}</summary>${chart}</details>`).join('')}`;
}

function reproduce(run: ReportRun, t: Translate): string {
  const fields = [
    [t('Generated at'), `<time datetime="${escape(run.generatedAt)}">${escape(run.generatedAt)}</time>`],
    [t('Library version'), escape(run.libraryVersion)],
  ];
  if (run.durationMs !== undefined) fields.push([t('Duration'), `${shortNumber.format(run.durationMs)} ms`]);
  const configuration = run.configuration && JSON.stringify(run.configuration, null, 2);
  return `<section class="report-section reproduction" id="reproduction"><h2>${t('Reproduction')}</h2>
    ${table([t('Field'), t('Value')], fields)}
    ${configuration ? `<details class="raw" id="reproduction-config"><summary>${t('Profiling configuration')}</summary><pre>${escape(configuration)}</pre></details>` : ''}</section>`;
}

const darkTheme = 'color-scheme:dark;--paper:#181a1c;--ink:#efefef;--muted:#b1b4b8;--line:#3a3e43;--accent:#92b7f1;--alert:#f2a48e;--wash:#202225;--head:#2a2e33;--type-lightness:64%;';
const css = `
:root{color-scheme:light;--paper:#fff;--ink:#202020;--muted:#62666a;--line:#e8e8e8;--accent:#2c5792;--alert:#a4442d;--wash:#fafafa;--head:#f1f3f5;--type-lightness:46%}
:root[data-theme=dark]{${darkTheme}}
@media(prefers-color-scheme:dark){:root[data-theme=auto]{${darkTheme}}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 "Avenir Next","PingFang SC",sans-serif}header,main,footer{max-width:74rem;margin:auto;padding:2rem clamp(1rem,4vw,2.75rem)}header{padding-bottom:.5rem}main{padding-top:1rem}footer{border-top:1px solid var(--line);font-size:.78rem;color:var(--muted)}
h1,h2,h3{font-weight:600;letter-spacing:-.025em;overflow-wrap:anywhere}h1{font-size:clamp(1.8rem,4vw,2.4rem);line-height:1.25;margin:.25rem 0 .75rem}h2{font-size:1.3rem;margin:0 0 .7rem}h3{font-size:1.05rem;margin:0 0 .8rem}.eyebrow{color:var(--muted);font-size:.7rem;letter-spacing:.18em;text-transform:uppercase}.subtitle,.section-note,.muted{color:var(--muted)}.subtitle{margin:0;font-size:.85rem}.section-note{font-size:.8rem;margin:0 0 1rem}
a{color:inherit;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}nav{display:flex;flex-wrap:wrap;gap:.4rem 1.15rem;font-size:.8rem;margin:.9rem 0}nav a{text-decoration:none}nav a:hover{text-decoration:underline}.index{padding:.4rem 0 1rem;border-bottom:1px solid var(--line);color:var(--muted)}section+section{margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--line)}.report-section{padding:1.5rem 0;border-bottom:1px solid var(--line);scroll-margin-top:1rem}
.overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin:1rem 0}
.overview:has(>div:nth-child(5)){grid-template-columns:repeat(3,minmax(0,1fr))}
.overview>div{padding:.75rem .9rem;background:var(--wash);border:1px solid var(--line);border-radius:.75rem;min-width:0}
.overview-note{display:block;margin-top:.25rem;color:var(--muted);font-size:.8rem;letter-spacing:0}
dt{font-size:.74rem;color:var(--muted)}dd{margin:.25rem 0 0;font-size:1.65rem;line-height:1.25;font-weight:500;letter-spacing:-.035em;overflow-wrap:anywhere}dd .muted{font-size:.85rem;letter-spacing:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));gap:1rem;align-items:start}.grid>*{min-width:0}
.type-distribution{padding:.4rem 0}
.type-heading{font-size:.8rem;font-weight:600}
.type-track{display:flex;gap:2px;height:.45rem;margin:.5rem 0;border-radius:1rem;overflow:hidden}
.type-track>span,.type-legend>li::before{background:hsl(var(--type-hue) 38% var(--type-lightness))}
.type-track>span{flex:var(--share)}
.type-legend{display:flex;flex-wrap:wrap;gap:.35rem 1rem;padding:0;margin:.65rem 0 0;list-style:none;font-size:.76rem}
.type-legend>li{display:inline-flex;align-items:center;gap:.35rem;max-width:100%;overflow-wrap:anywhere}
.type-legend>li::before{content:"";flex:none;width:.55rem;height:.55rem;border-radius:2px}
.type-legend .value{color:var(--muted)}
.column{border-top:1px solid var(--line);padding:.9rem 0;scroll-margin-top:1rem}.column>summary{font-size:.95rem;font-weight:600;overflow-wrap:anywhere}.column>summary .type{margin-left:.5rem;font-size:.72rem;font-weight:400;color:var(--muted)}summary{cursor:pointer}.column[open]>summary{margin-bottom:1rem}.column:target{border-color:var(--accent)}.column-stats{display:flex;flex-wrap:wrap;gap:.6rem 1.8rem;margin:.6rem 0 1.2rem}.column-stats dd{font-size:1rem;letter-spacing:0}.raw{margin-top:1rem;font-size:.8rem}.raw>summary{color:var(--muted);margin-bottom:.6rem}.table-scroll{overflow:auto;max-width:100%;max-height:32rem}table{border-collapse:collapse;width:100%;font-size:.78rem;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:.5rem .7rem;text-align:left;vertical-align:top;overflow-wrap:anywhere;min-width:5rem}th{font-weight:500}thead{background:var(--head);position:sticky;top:0}tbody tr:hover{background:var(--wash)}td table{min-width:15rem}code,.value{font-family:"SFMono-Regular",Consolas,monospace;font-size:.9em;white-space:pre-wrap;overflow-wrap:anywhere}.value-list{padding-left:1.5rem;margin:0}.value-list li+li{margin-top:.3rem}
.chart{margin:0;padding:1rem;border:1px solid var(--line);border-radius:1rem;background:var(--paper);min-width:0}.chart figcaption{font-size:.85rem;font-weight:600;margin-bottom:.9rem}.chart p{font-size:.76rem}.bars{list-style:none;padding:0;margin:0}.bars li{display:grid;grid-template-columns:minmax(4rem,28%) 1fr minmax(2rem,max-content);gap:.65rem;align-items:center;min-height:1.8rem;font-size:.78rem}.bar-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.bar-value{max-width:12rem;overflow-wrap:anywhere}.track{height:.55rem;background:var(--head);border-radius:2px;overflow:hidden}.track>span{height:100%;display:block;background:var(--accent)}.coverage .track>span{background:var(--alert)}
.histogram-layout{display:grid;grid-template-columns:minmax(2.5rem,max-content) 1fr;gap:.5rem}.scale{display:flex;flex-direction:column;justify-content:space-between;align-items:end;font-size:.7rem;color:var(--muted)}.histogram-plot{display:flex;align-items:end;min-width:0;height:10rem;border:solid var(--line);border-width:0 0 1px 1px;background:repeating-linear-gradient(to top,transparent 0 calc(25% - 1px),var(--line) calc(25% - 1px) 25%)}.histogram-plot>span{background:var(--accent);box-shadow:inset -1px 0 var(--paper)}.histogram-plot>span:hover{background:var(--alert)}.axis{display:flex;justify-content:space-between;gap:1rem;color:var(--muted);font-size:.7rem;margin-top:.4rem;overflow-wrap:anywhere}.axis>span{max-width:49%}.axis>span:last-child{text-align:right}.histogram .axis{padding-left:3rem}.lag-chart{width:100%;height:auto;display:block}.baseline{stroke:var(--line);stroke-width:1}.stem{stroke:var(--accent);stroke-width:2}
.column-link{color:var(--accent);text-decoration-color:color-mix(in srgb,var(--accent) 40%,transparent)}
.column-link:hover{text-decoration-color:currentColor}
.chart-note{color:var(--muted);font-size:.75rem;margin:.65rem 0 0}
.cloud-words{display:flex;align-content:center;align-items:baseline;justify-content:center;flex-wrap:wrap;gap:.15rem .75rem;min-height:9rem;padding:.65rem;margin:0;background:var(--wash);border-radius:.5rem;list-style:none}
.cloud-words>li{max-width:100%;color:var(--accent);font-size:var(--word-size);font-weight:600;line-height:1.2;overflow-wrap:anywhere}
.cloud-words>li:nth-child(3n){color:var(--ink)}
.size-axis-label{color:var(--muted);font-size:.7rem}
.size-layout{margin:.65rem .75rem 0 0}
.size-plot{position:relative;height:9rem;border:solid var(--line);border-width:0 0 1px 1px;background:repeating-linear-gradient(to top,transparent 0 calc(25% - 1px),var(--line) calc(25% - 1px) 25%)}
.size-dot{position:absolute;translate:-50% 50%;width:var(--dot-size);height:var(--dot-size);border:1px solid var(--accent);border-radius:50%;background:color-mix(in srgb,var(--accent) 50%,transparent)}
.size-dot:hover{background:var(--accent)}
.image-sizes .axis{margin-inline:3rem .75rem}
.strongest-pairs{margin:0 0 1.25rem}
.strongest-pairs h4{margin:0 0 .55rem;font-size:.88rem;font-weight:600}
.correlation-method{border-top:1px solid var(--line);padding:.65rem 0}
.correlation-method>summary{font-weight:600}
.correlation-method[open]>summary{margin-bottom:.6rem}
.coefficient{display:block;min-width:4rem;padding:.2rem .35rem;border-radius:.2rem;font-variant-numeric:tabular-nums;background:color-mix(in srgb,var(--accent) calc(var(--strength)*34%),transparent)}
.coefficient.negative{background:color-mix(in srgb,var(--alert) calc(var(--strength)*34%),transparent)}
.sample-rows,.row-plot{border-top:1px solid var(--line);padding:.65rem 0}
.sample-rows>summary,.row-plot>summary{font-weight:600}
.sample-rows[open]>summary,.row-plot[open]>summary{margin-bottom:.65rem}
.sample-rows .table-scroll th,.sample-rows .table-scroll td{max-width:17rem}
.report-section h4{margin:1rem 0 .55rem;font-size:.88rem;font-weight:600}
.report-section .strongest-pairs h4{margin-top:0}
.missing-pattern,.missing-correlation{margin-top:1rem}
.mask-scroll{overflow:auto;max-height:26rem;border:1px solid var(--line);border-radius:.45rem}
.mask-grid{min-width:calc(var(--mask-columns)*3.9rem);background:var(--wash)}
.mask-names{position:sticky;top:0;display:grid;grid-template-columns:repeat(var(--mask-columns),minmax(0,1fr));background:var(--head)}
.mask-names span{padding:.35rem .45rem;border-right:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.72rem}
.mask-rows{display:block;width:100%;height:clamp(5rem,26vw,14rem);background:linear-gradient(to right,var(--line) 1px,transparent 1px);background-size:calc(100% / var(--mask-columns)) 100%}
.mask-rows path{fill:var(--alert)}
.missing-key{display:inline-flex;align-items:center;gap:.35rem;margin-inline-start:.45rem}
.missing-key::before{content:"";width:.65rem;height:.65rem;border-radius:2px;background:var(--alert)}
.plot-layout{display:grid;grid-template-columns:minmax(2rem,max-content) minmax(0,1fr);column-gap:.35rem}
.plot-layout .scale>span{max-width:clamp(2rem,11vw,6rem);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.plot-axis-name{color:var(--muted);font-size:.72rem;overflow-wrap:anywhere}
.plot-x-name,.plot-range{grid-column:2;padding-inline:1.5625%}
.plot-x-name{text-align:right}
.xy-plot{display:block;width:100%;height:clamp(8rem,18vw,12rem)}
.time-gaps svg{display:block;width:100%;height:2.35rem}
.plot-grid{fill:none;stroke:var(--line);vector-effect:non-scaling-stroke}
.scatter-dot{fill:var(--accent);opacity:.62}
.scatter-dot:hover{opacity:1}
.series-line{fill:none;stroke:var(--accent);stroke-width:1.6;vector-effect:non-scaling-stroke}
.series-gap{fill:var(--alert);opacity:.3}
.reproduction pre{margin:0;padding:.8rem;border:1px solid var(--line);border-radius:.45rem;background:var(--wash);white-space:pre-wrap;overflow-wrap:anywhere}
@media(min-width:52rem){
  .overview:has(>div:nth-child(5)){grid-template-columns:repeat(5,minmax(0,1fr))}
  .overview:has(>div:nth-child(6)){grid-template-columns:repeat(6,minmax(0,1fr))}
}
@media(max-width:40rem){
  header{padding-top:1.5rem}
  .overview,.overview:has(>div:nth-child(5)){grid-template-columns:repeat(2,minmax(0,1fr))}
  dd{font-size:1.4rem}th,td{padding:.4rem}.bars li{gap:.4rem}.bar-value{max-width:6rem}
  .cloud-words>li{font-size:min(var(--word-size),2rem)}
}
@media print{header,main,footer{max-width:none;padding:1rem 0}nav{display:none}.table-scroll{max-height:none;overflow:visible}.chart{break-inside:avoid}.column::details-content{content-visibility:visible}.column>summary{margin-bottom:1rem}}
`;

/** Render one table from validated records and optional row context. */
function renderTable(
  name: string, rows: readonly ProfileResult[], index: number, data: ReportTableData | undefined,
  run: ReportRun | undefined, t: Translate,
): string {
  const pairs = rows.filter((row) => row.columns.length === 2);
  const ranked = rankPairs(pairs);
  const tableRows = rows.filter((row) => !row.columns.length);
  const values = new Map(tableRows.map((row) => [row.metric, row.value]));
  const columns = new Map<string, ProfileResult[]>();
  for (const row of rows.filter((row) => row.columns.length === 1)) {
    if (!columns.has(row.columns[0])) columns.set(row.columns[0], []);
    columns.get(row.columns[0])!.push(row);
  }
  // Positional anchors are safe and unique even when source names contain punctuation or markup.
  const prefix = `table-${index}`;
  const columnIndexes = new Map([...columns.keys()].map((column, i) => [column, i]));
  const columnLink = (column: string) => {
    const i = columnIndexes.get(column);
    return i === undefined ? escape(column) : `<a class="column-link" href="#${prefix}-column-${i}">${escape(column)}</a>`;
  };
  const missingCount = values.get('missing_cell_count');
  const missingRate = numeric(values.get('missing_cell_rate'));
  const missingPercent = missingRate === undefined ? undefined : percentage.format(missingRate);
  const overview: [key: string, value: string, note?: string][] = [
    ['Rows', markup(values.get('row_count'), t)], ['Columns', markup(values.get('column_count'), t)],
    missingCount || !missingPercent
      ? ['Missing cells', markup(missingCount, t), missingPercent]
      : ['Missing-cell rate', missingPercent],
    ['Duplicate groups', markup(values.get('duplicate_group_count'), t)],
  ];
  const columnsWithMissing = values.get('columns_with_missing_count');
  if (columnsWithMissing) overview.push(['Columns with missing values', markup(columnsWithMissing, t)]);
  const memory = values.get('table_memory_bytes');
  if (memory) overview.push(['Table memory (bytes)', markup(memory, t)]);
  const duplicates = duplicateSizes(values.get('duplicate_group_row_count'), t) + (data ? duplicateRows(data, t) : '');
  // Row-based views require the optional context collected separately from the metric records.
  const scatter = data ? interactions(data, ranked, prefix, t) : '';
  const trends = data ? timeSeries(data, columns, prefix, t) : '';
  const variables = [...columns].map(([columnName, metrics], columnIndex) => {
    const anchor = `${prefix}-column-${columnIndex}`;
    const stats = new Map(metrics.map((row) => [row.metric, row.value]));
    const profilingType = stats.get('profiling_type');
    const role = profilingType?.type === 'string' ? profilingType.value : undefined;
    const missingKey = stats.has('missing_count') ? 'missing_count' : 'null_count';
    const specific = summariesByRole.get(role ?? '') ?? ['min', 'max', 'mean', 'median'];
    const summary = ['observation_count', 'present_count', missingKey, 'missing_rate', 'distinct_count', ...specific]
      .filter((key) => stats.has(key))
      .map((key) => {
        const value = stats.get(key);
        const rate = key === 'missing_rate' ? numeric(value) : undefined;
        return `<div><dt>${escape(label(key, t))}</dt><dd>${rate === undefined ? markup(value, t) : percentage.format(rate)}</dd></div>`;
      }).join('');
    const type = profilingType ?? stats.get('declared_type');
    return `<details class="column" id="${anchor}">
        <summary>${escape(columnName)} <span class="type">${type ? escape(t(text(type, t))) : t('Type not supplied')}</span></summary>
        ${summary ? `<dl class="column-stats">${summary}</dl>` : ''}
        ${columnCharts(metrics, stats, role, anchor, t)}
        <details class="raw" id="${anchor}-exact"><summary>${t('All {count} column metrics · exact values and parameters').replace('{count}', String(metrics.length))}</summary>${metricTable(metrics, t)}</details>
      </details>`;
  }).join('');
  const sectionIndex = [
    ['Observations', `${prefix}-section-0`], ['Variables', `${prefix}-section-1`],
    ...(scatter ? [['Interactions', `${prefix}-interactions`]] : []),
    ['Correlations', `${prefix}-section-2`],
    ...(trends ? [['Time series', `${prefix}-time-series`]] : []),
    ['Missing values', `${prefix}-section-3`],
    ...(data ? [['Sample rows', `${prefix}-samples`]] : []),
    ...(duplicates ? [['Duplicate data', `${prefix}-duplicates`]] : []),
    ['Table details', `${prefix}-section-4`], ...(run ? [['Reproduction', 'reproduction']] : []),
  ].map(([heading, id]) => `<a href="#${id}">${t(heading)}</a>`);
  return `<section id="${prefix}"><h2>${escape(name)}</h2>
<dl class="overview">${overview.map(([key, value, note]) => `<div><dt>${t(key)}</dt><dd>${value}${note ? `<span class="overview-note">${note}</span>` : ''}</dd></div>`).join('')}</dl>
${typeDistribution(values.get('column_type_counts'), columns, t)}
<nav class="index" aria-label="${escape(name)} ${t('report sections')}">${sectionIndex.join('')}</nav>
<div class="report-section" id="${prefix}-section-0"><h3>${t('Data quality observations')}</h3>${observations(columns, values.get('duplicate_group_count'), ranked, columnLink, t)}</div>
<div class="report-section" id="${prefix}-section-1"><h3>${t('Variables')} <span class="muted">· ${columns.size} ${t('profiled')}</span></h3>${columns.size ? `<nav aria-label="${escape(name)} ${t('columns')}">${[...columns.keys()].map((key, i) => `<a href="#${prefix}-column-${i}">${escape(key)}</a>`).join('')}</nav>${variables}` : `<p class="muted">${t('Single-column metrics were not supplied.')}</p>`}</div>
${scatter ? `<div class="report-section" id="${prefix}-interactions"><h3>${t('Interactions')}</h3>${scatter}</div>` : ''}
<div class="report-section" id="${prefix}-section-2"><h3>${t('Correlations and pairwise metrics')}</h3>${pairwise(pairs, ranked, prefix, columnLink, t)}</div>
${trends ? `<div class="report-section" id="${prefix}-time-series"><h3>${t('Time series')}</h3>${trends}</div>` : ''}
<div class="report-section" id="${prefix}-section-3"><h3>${t('Missing values')}</h3>${missingValues(columns, values.get('row_count'), columnLink, t)}${data ? missingPatterns(data, t) : ''}</div>
${data ? `<div class="report-section" id="${prefix}-samples"><h3>${t('Sample rows')}</h3>${rowSamples(data, prefix, t)}</div>` : ''}
${duplicates ? `<div class="report-section" id="${prefix}-duplicates"><h3>${t('Duplicate data')}</h3>${duplicates}</div>` : ''}
<div class="report-section" id="${prefix}-section-4"><h3>${t('Table details')}</h3>${tableRows.length ? metricTable(tableRows, t) : `<p class="muted">${t('Table-level metrics were not supplied.')}</p>`}</div></section>`;
}

/** Render protocol-v1 profiling results as a standalone, offline HTML document. */
export function renderReport(results: readonly ProfileResult[], options: ReportOptions = {}): string {
  // Validate the document inputs once before composing the table sections.
  if (!Array.isArray(results)) throw new TypeError('results must be an array of ProfileResult');
  if (!isRecord(options) || Object.keys(options).some((key) => !['title', 'theme', 'language', 'tableData', 'run'].includes(key)) ||
      (options.title !== undefined && typeof options.title !== 'string') ||
      (options.theme !== undefined && (typeof options.theme !== 'string' || !['light', 'dark', 'auto'].includes(options.theme))) ||
      (options.language !== undefined && (typeof options.language !== 'string' || !['zh-CN', 'en-US'].includes(options.language)))) throw new TypeError('Invalid report options');
  const run = options.run;
  if (run !== undefined) validateRun(run);
  const tableData = indexTableData(options.tableData === undefined ? [] : options.tableData);
  const language = options.language ?? 'zh-CN';
  const t: Translate = (value) => language === 'zh-CN' && Object.hasOwn(chinese, value) ? chinese[value as keyof typeof chinese] : value;
  const tables = new Map<string, ProfileResult[]>();
  for (const row of results) {
    validateResult(row);
    if (!tables.has(row.table_name)) tables.set(row.table_name, []);
    tables.get(row.table_name)!.push(row);
  }
  const sections = [...tables].map(([name, rows], index) => renderTable(name, rows, index, tableData.get(name), run, t)).join('');
  const title = options.title ?? t('Data profile');
  return `<!doctype html><html lang="${language}" data-theme="${options.theme ?? 'light'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${css}</style></head>
<body><header>${title === t('Data profiling report') ? '' : `<div class="eyebrow">${t('Data profiling report')}</div>`}<h1>${escape(title)}</h1>
<p class="subtitle">${tables.size} ${t(tables.size === 1 ? 'table' : 'tables')} · ${new Set(results.map((row) => row.metric)).size} ${t('metric IDs')} · ${results.length} ${t('result records')} · ${t('Protocol v1')}</p>
${tables.size > 1 ? `<nav aria-label="${t('Tables')}">${[...tables.keys()].map((name, i) => `<a href="#table-${i}">${escape(name)}</a>`).join('')}</nav>` : ''}
</header><main>${sections || `<p class="muted">${t('No profiling results were supplied.')}</p>`}${run ? reproduce(run, t) : ''}</main>
<footer>${t('Rendered from supplied profiling results. “Not supplied” indicates an absent metric; “Undefined” indicates a computed null.')}
${t('Chart geometry uses approximate numbers; exact values and parameters are available in the detail tables.')}</footer>
</body></html>`;
}
