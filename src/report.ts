import type { MetricValue, ProfileResult } from './types';
import { chinese, type Translate } from './report-language';

export interface ReportOptions {
  title?: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: 'zh-CN' | 'en-US';
}

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => entities[char]);
const label = (value: string, t: Translate) => t(value) !== value ? t(value) : value.replaceAll('_', ' ').replace(/^./, (char) => char.toUpperCase());
const absent = (t: Translate) => `<span class="muted">${t('Not supplied')}</span>`;
const percentage = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 2 });
const shortNumber = new Intl.NumberFormat('en', { maximumSignificantDigits: 5 });
const correlations = new Set(['pearson_r', 'spearman_rho', 'kendall_tau', 'cramers_v', 'phi_k', 'auto_correlation']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function barChart(items: { name: string; amount: number; detail: string }[], caption: string, note: string, t: Translate): string {
  const peak = items.reduce((max, item) => Math.max(max, item.amount), 0);
  const bars = items.map((item) => `<li>
    <span class="bar-label" title="${escape(item.name)}">${escape(item.name)}</span>
    <span class="track" title="${escape(item.detail)}"><span style="width:${peak ? item.amount / peak * 100 : 0}%"></span></span>
    <span class="bar-value">${escape(item.detail)}</span>
  </li>`).join('');
  return `<figure class="chart"><figcaption>${escape(caption)}</figcaption>${bars ? `<ul class="bars">${bars}</ul>` : `<p class="muted">${t('No supplied values to plot.')}</p>`}${note}</figure>`;
}

function chart(row: ProfileResult, t: Translate): string {
  const value = row.value;
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
    return amount === undefined || amount < 0 ? [] : [{ name: text(entry.value.value, t), amount, detail: text(entry.value.count, t) }];
  });
  if (items.length !== entries.value.length) return '';
  const note = items.length > 12 ? `<p class="muted">${t('Showing the first 12 of {count} supplied values. Full data below.').replace('{count}', String(items.length))}</p>` : '';
  const truncated = value.type === 'object' && value.value.truncated?.type === 'boolean' && value.value.truncated.value;
  return barChart(items.slice(0, 12), label(row.metric, t), note + (truncated ? `<p class="muted">${t('Source frequencies are truncated.')}</p>` : ''), t);
}

function observations(columns: Map<string, ProfileResult[]>, t: Translate): string {
  const rows: string[][] = [];
  for (const [name, metrics] of columns) {
    const values = new Map(metrics.map((row) => [row.metric, row.value]));
    for (const [metric, description] of [
      ['missing_count', 'Missing values'], ['infinity_count', 'Infinite values'],
      ['invalid_date_count', 'Invalid dates'], ['truncated_image_count', 'Truncated images'],
    ]) {
      const value = values.get(metric) ?? (metric === 'missing_count' ? values.get('null_count') : undefined);
      if ((numeric(value) ?? 0) > 0) rows.push([escape(name), t(description), markup(value, t)]);
    }
    if (numeric(values.get('distinct_count')) === 1) rows.push([escape(name), t('One distinct non-missing value'), markup(values.get('distinct_count'), t)]);
  }
  return `<p class="section-note">${t('Facts from the supplied metrics. No additional quality checks are run.')}</p>${rows.length ? table([t('Column'), t('Observation'), t('Count')], rows) : `<p class="muted">${t('No quality observations available from the supplied metrics.')}</p>`}`;
}

function missingValues(columns: Map<string, ProfileResult[]>, rowCount: MetricValue | undefined, t: Translate): string {
  const rows: string[][] = [];
  const bars: string[] = [];
  for (const [name, metrics] of columns) {
    const values = new Map(metrics.map((row) => [row.metric, row.value]));
    const count = values.get('missing_count') ?? values.get('null_count');
    const total = numeric(values.get('observation_count') ?? rowCount);
    const missing = numeric(count);
    const rate = numeric(values.get('missing_rate')) ?? (missing !== undefined && total !== undefined && total > 0 ? missing / total : undefined);
    if (!count && rate === undefined) continue;
    rows.push([escape(name), markup(count, t), rate === undefined ? absent(t) : escape(percentage.format(rate))]);
    if (rate !== undefined && rate >= 0 && rate <= 1) bars.push(`<li><span class="bar-label">${escape(name)}</span><span class="track"><span style="width:${rate * 100}%"></span></span><span>${escape(percentage.format(rate))}</span></li>`);
  }
  if (!rows.length) return `<p class="muted">${t('Missing-value metrics were not supplied.')}</p>`;
  return `${bars.length ? `<figure class="chart coverage"><figcaption>${t('Missing values by column')}</figcaption><ul class="bars">${bars.join('')}</ul></figure>` : ''}<details class="raw"><summary>${t('Column counts')}</summary>${table([t('Column'), t('Missing'), t('Missing rate')], rows)}</details>`;
}

function pairwise(rows: ProfileResult[], t: Translate): string {
  if (!rows.length) return `<p class="muted">${t('Pairwise metrics were not supplied.')}</p>`;
  const methods = new Map<string, ProfileResult[]>();
  for (const row of rows) {
    if (!methods.has(row.metric)) methods.set(row.metric, []);
    methods.get(row.metric)!.push(row);
  }
  return [...methods].map(([method, metrics]) => {
    const names = [...new Set(metrics.flatMap((row) => row.columns))];
    const cells = new Map<string, MetricValue>();
    for (const row of metrics) {
      cells.set(JSON.stringify(row.columns), row.value);
      cells.set(JSON.stringify([...row.columns].reverse()), row.value);
    }
    const matrix = table([t('Column'), ...names], names.map((name) => [escape(name), ...names.map((other) => {
      const value = cells.get(JSON.stringify([name, other]));
      const number = numeric(value);
      return number !== undefined && correlations.has(method)
        ? `<span class="coefficient${number < 0 ? ' negative' : ''}" style="--strength:${Math.min(1, Math.abs(number))}" title="${escape(text(value!, t))}">${shortNumber.format(number)}</span>`
        : markup(value, t);
    })]));
    return `<figure class="chart matrix"><figcaption>${escape(label(method, t))}</figcaption>${matrix}<details class="raw"><summary>${t('Exact pairwise values')}</summary>${table([t('Column pair'), t('Value'), t('Parameters')], metrics.map((row) => [escape(row.columns.join(' / ')), markup(row.value, t), parametersMarkup(row.parameters, t)]))}</details></figure>`;
  }).join('');
}

const darkTheme = 'color-scheme:dark;--paper:#181a1c;--ink:#efefef;--muted:#b1b4b8;--line:#3a3e43;--accent:#92b7f1;--alert:#f2a48e;--wash:#202225;--head:#2a2e33;';
const css = `
:root{color-scheme:light;--paper:#fff;--ink:#202020;--muted:#62666a;--line:#e8e8e8;--accent:#2c5792;--alert:#a4442d;--wash:#fafafa;--head:#f1f3f5}
:root[data-theme=dark]{${darkTheme}}
@media(prefers-color-scheme:dark){:root[data-theme=auto]{${darkTheme}}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 "Avenir Next","PingFang SC",sans-serif}header,main,footer{max-width:74rem;margin:auto;padding:2rem clamp(1rem,4vw,2.75rem)}header{padding-bottom:.5rem}main{padding-top:1rem}footer{border-top:1px solid var(--line);font-size:.78rem;color:var(--muted)}
h1,h2,h3{font-weight:600;letter-spacing:-.025em;overflow-wrap:anywhere}h1{font-size:clamp(1.8rem,4vw,2.4rem);line-height:1.25;margin:.25rem 0 .75rem}h2{font-size:1.3rem;margin:0 0 .7rem}h3{font-size:1.05rem;margin:0 0 .8rem}.eyebrow{color:var(--muted);font-size:.7rem;letter-spacing:.18em;text-transform:uppercase}.subtitle,.section-note,.muted{color:var(--muted)}.subtitle{margin:0;font-size:.85rem}.section-note{font-size:.8rem;margin:0 0 1rem}
a{color:inherit;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}nav{display:flex;flex-wrap:wrap;gap:.4rem 1.15rem;font-size:.8rem;margin:.9rem 0}nav a{text-decoration:none}nav a:hover{text-decoration:underline}.index{padding:.4rem 0 1rem;border-bottom:1px solid var(--line);color:var(--muted)}section+section{margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--line)}.report-section{padding:1.5rem 0;border-bottom:1px solid var(--line);scroll-margin-top:1rem}
.overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));padding:1.1rem .25rem;background:var(--wash);border:1px solid var(--line);border-radius:1rem;margin:1rem 0}.overview>div{padding:.2rem 1rem;border-inline-end:1px solid var(--line);min-width:0}.overview>div:last-child{border:0}dt{font-size:.74rem;color:var(--muted)}dd{margin:.25rem 0 0;font-size:1.65rem;line-height:1.25;font-weight:500;letter-spacing:-.035em;overflow-wrap:anywhere}dd .muted{font-size:.85rem;letter-spacing:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,21rem),1fr));gap:1rem;align-items:start}.grid>*{min-width:0}
.column{border-top:1px solid var(--line);padding:.9rem 0;scroll-margin-top:1rem}.column>summary{font-size:.95rem;font-weight:600;overflow-wrap:anywhere}.column>summary .type{margin-left:.5rem;font-size:.72rem;font-weight:400;color:var(--muted)}summary{cursor:pointer}.column[open]>summary{margin-bottom:1rem}.column:target{border-color:var(--accent)}.column-stats{display:flex;flex-wrap:wrap;gap:.6rem 1.8rem;margin:.6rem 0 1.2rem}.column-stats dd{font-size:1rem;letter-spacing:0}.raw{margin-top:1rem;font-size:.8rem}.raw>summary{color:var(--muted);margin-bottom:.6rem}.table-scroll{overflow:auto;max-width:100%;max-height:32rem}table{border-collapse:collapse;width:100%;font-size:.78rem;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:.5rem .7rem;text-align:left;vertical-align:top;overflow-wrap:anywhere;min-width:5rem}th{font-weight:500}thead{background:var(--head);position:sticky;top:0}tbody tr:hover{background:var(--wash)}td table{min-width:15rem}code,.value{font-family:"SFMono-Regular",Consolas,monospace;font-size:.9em;white-space:pre-wrap;overflow-wrap:anywhere}.value-list{padding-left:1.5rem;margin:0}.value-list li+li{margin-top:.3rem}
.chart{margin:0;padding:1rem;border:1px solid var(--line);border-radius:1rem;background:var(--paper);min-width:0}.chart figcaption{font-size:.85rem;font-weight:600;margin-bottom:.9rem}.chart p{font-size:.76rem}.bars{list-style:none;padding:0;margin:0}.bars li{display:grid;grid-template-columns:minmax(4rem,28%) 1fr minmax(2rem,max-content);gap:.65rem;align-items:center;min-height:1.8rem;font-size:.78rem}.bar-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.bar-value{max-width:12rem;overflow-wrap:anywhere}.track{height:.55rem;background:var(--head);border-radius:2px;overflow:hidden}.track>span{height:100%;display:block;background:var(--accent)}.coverage .track>span{background:var(--alert)}
.histogram-layout{display:grid;grid-template-columns:minmax(2.5rem,max-content) 1fr;gap:.5rem}.scale{display:flex;flex-direction:column;justify-content:space-between;align-items:end;font-size:.7rem;color:var(--muted)}.histogram-plot{display:flex;align-items:end;min-width:0;height:10rem;border:solid var(--line);border-width:0 0 1px 1px;background:repeating-linear-gradient(to top,transparent 0 calc(25% - 1px),var(--line) calc(25% - 1px) 25%)}.histogram-plot>span{background:var(--accent);box-shadow:inset -1px 0 var(--paper)}.histogram-plot>span:hover{background:var(--alert)}.axis{display:flex;justify-content:space-between;gap:1rem;color:var(--muted);font-size:.7rem;margin-top:.4rem;overflow-wrap:anywhere}.axis>span{max-width:49%}.axis>span:last-child{text-align:right}.histogram .axis{padding-left:3rem}.lag-chart{width:100%;height:auto;display:block}.baseline{stroke:var(--line);stroke-width:1}.stem{stroke:var(--accent);stroke-width:2}.coefficient{display:block;min-width:4rem;padding:.25rem .4rem;font-variant-numeric:tabular-nums;background:color-mix(in srgb,var(--accent) calc(var(--strength)*65%),transparent)}.coefficient.negative{background:color-mix(in srgb,var(--alert) calc(var(--strength)*65%),transparent)}.matrix+.matrix{margin-top:1rem}
@media(max-width:40rem){header{padding-top:1.5rem}.overview{grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem 0}.overview>div{border:0}dd{font-size:1.4rem}th,td{padding:.4rem}.bars li{gap:.4rem}.bar-value{max-width:6rem}}@media print{header,main,footer{max-width:none;padding:1rem 0}nav{display:none}.table-scroll{max-height:none;overflow:visible}.chart{break-inside:avoid}.column::details-content{content-visibility:visible}.column>summary{margin-bottom:1rem}}
`;

/** Render protocol-v1 profiling results as a standalone, offline HTML document. */
export function renderReport(results: readonly ProfileResult[], options: ReportOptions = {}): string {
  if (!Array.isArray(results)) throw new TypeError('results must be an array of ProfileResult');
  if (!isRecord(options) || Object.keys(options).some((key) => !['title', 'theme', 'language'].includes(key)) ||
      (options.title !== undefined && typeof options.title !== 'string') ||
      (options.theme !== undefined && (typeof options.theme !== 'string' || !['light', 'dark', 'auto'].includes(options.theme))) ||
      (options.language !== undefined && (typeof options.language !== 'string' || !['zh-CN', 'en-US'].includes(options.language)))) throw new TypeError('Invalid report options');
  const language = options.language ?? 'zh-CN';
  const t: Translate = (value) => language === 'zh-CN' && Object.hasOwn(chinese, value) ? chinese[value as keyof typeof chinese] : value;
  const tables = new Map<string, ProfileResult[]>();
  for (const row of results) {
    validateResult(row);
    if (!tables.has(row.table_name)) tables.set(row.table_name, []);
    tables.get(row.table_name)!.push(row);
  }
  const sections = [...tables].map(([name, rows], index) => {
    const tableRows = rows.filter((row) => !row.columns.length);
    const values = new Map(tableRows.map((row) => [row.metric, row.value]));
    const columns = new Map<string, ProfileResult[]>();
    for (const row of rows.filter((row) => row.columns.length === 1)) {
      if (!columns.has(row.columns[0])) columns.set(row.columns[0], []);
      columns.get(row.columns[0])!.push(row);
    }
    const prefix = `table-${index}`;
    const overview = [
      ['Rows', markup(values.get('row_count'), t)], ['Columns', markup(values.get('column_count'), t)],
      ['Missing cells', values.has('missing_cell_rate') && numeric(values.get('missing_cell_rate')) !== undefined ? escape(percentage.format(numeric(values.get('missing_cell_rate'))!)) : markup(values.get('missing_cell_count'), t)],
      ['Duplicate groups', markup(values.get('duplicate_group_count'), t)],
    ];
    const variables = [...columns].map(([columnName, metrics], columnIndex) => {
      const stats = new Map(metrics.map((row) => [row.metric, row.value]));
      const charts = metrics.filter((row) => !(['top_values', 'value_counts_by_value'].includes(row.metric) && stats.has('value_counts'))).map((row) => chart(row, t)).filter(Boolean).join('');
      const summary = ['observation_count', 'present_count', 'missing_count', 'distinct_count', 'min', 'max', 'mean', 'median'].filter((key) => stats.has(key));
      const type = stats.get('profiling_type') ?? stats.get('declared_type');
      return `<details class="column" id="${prefix}-column-${columnIndex}">
        <summary>${escape(columnName)} <span class="type">${type ? escape(t(text(type, t))) : t('Type not supplied')}</span></summary>
        ${summary.length ? `<dl class="column-stats">${summary.map((key) => `<div><dt>${escape(label(key, t))}</dt><dd>${markup(stats.get(key), t)}</dd></div>`).join('')}</dl>` : ''}
        ${charts ? `<div class="grid">${charts}</div>` : ''}
        <details class="raw"><summary>${t('All {count} column metrics · exact values and parameters').replace('{count}', String(metrics.length))}</summary>${metricTable(metrics, t)}</details>
      </details>`;
    }).join('');
    return `<section id="${prefix}"><h2>${escape(name)}</h2>
<dl class="overview">${overview.map(([key, value]) => `<div><dt>${t(key)}</dt><dd>${value}</dd></div>`).join('')}</dl>
<nav class="index" aria-label="${escape(name)} ${t('report sections')}">${['Observations', 'Variables', 'Correlations', 'Missing values', 'Table details'].map((heading, i) => `<a href="#${prefix}-section-${i}">${t(heading)}</a>`).join('')}</nav>
<div class="report-section" id="${prefix}-section-0"><h3>${t('Data quality observations')}</h3>${observations(columns, t)}</div>
<div class="report-section" id="${prefix}-section-1"><h3>${t('Variables')} <span class="muted">· ${columns.size} ${t('profiled')}</span></h3>${columns.size ? `<nav aria-label="${escape(name)} ${t('columns')}">${[...columns.keys()].map((key, i) => `<a href="#${prefix}-column-${i}">${escape(key)}</a>`).join('')}</nav>${variables}` : `<p class="muted">${t('Single-column metrics were not supplied.')}</p>`}</div>
<div class="report-section" id="${prefix}-section-2"><h3>${t('Correlations and pairwise metrics')}</h3>${pairwise(rows.filter((row) => row.columns.length === 2), t)}</div>
<div class="report-section" id="${prefix}-section-3"><h3>${t('Missing values')}</h3>${missingValues(columns, values.get('row_count'), t)}</div>
<div class="report-section" id="${prefix}-section-4"><h3>${t('Table details')}</h3>${tableRows.length ? metricTable(tableRows, t) : `<p class="muted">${t('Table-level metrics were not supplied.')}</p>`}</div></section>`;
  }).join('');
  const title = options.title ?? t('Data profile');
  return `<!doctype html><html lang="${language}" data-theme="${options.theme ?? 'light'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${css}</style></head>
<body><header><div class="eyebrow">${t('Data profiling report')}</div><h1>${escape(title)}</h1>
<p class="subtitle">${tables.size} ${t(tables.size === 1 ? 'table' : 'tables')} · ${results.length} ${t('supplied metrics')} · ${t('Protocol v1')}</p>
${tables.size > 1 ? `<nav aria-label="${t('Tables')}">${[...tables.keys()].map((name, i) => `<a href="#table-${i}">${escape(name)}</a>`).join('')}</nav>` : ''}
</header><main>${sections || `<p class="muted">${t('No profiling results were supplied.')}</p>`}</main>
<footer>${t('Rendered from supplied profiling results. “Not supplied” indicates an absent metric; “Undefined” indicates a computed null.')}
${t('Chart geometry uses approximate numbers; exact values and parameters are available in the detail tables.')}</footer>
</body></html>`;
}
