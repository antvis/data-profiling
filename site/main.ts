import * as duckdb from '@duckdb/duckdb-wasm';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import { renderReport, type ReportOptions } from '../src/report.js';
import { kind, type ProfileColumn } from '../src/plan.js';
import type { ProfilingConnection } from '../src/profile.js';
import type { ProfileResult } from '../src/types.js';
import { fileFormat, plainValue, profileDataset, type PlaygroundOptions } from './profiling.js';
import sampleSQL from './sample.sql?raw';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const report = element<HTMLIFrameElement>('report');
const fileInput = element<HTMLInputElement>('file');
const errorBox = element('error');
const languageInput = element<HTMLSelectElement>('language');
const themeInput = element<HTMLSelectElement>('theme');
const modeInput = element<HTMLSelectElement>('mode');
const binsInput = element<HTMLSelectElement>('bins');
const correlationsInput = element<HTMLInputElement>('correlations');
const status = element('execution-status');
const reportState = element('report-state');
const download = element<HTMLButtonElement>('download');
const loading = element('report-loading');
const pageSize = 25;
let database: duckdb.AsyncDuckDB | undefined;
let connection: duckdb.AsyncDuckDBConnection | undefined;
let columns: ProfileColumn[] = [];
let results: ProfileResult[] = [];
let total = 0;
let page = 0;
let busy = false;
let sourceName = '电商订单 · 预设数据';
let currentReport = '';

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const adapter: ProfilingConnection = {
  run: async (sql) => connection!.query(sql),
  runAndReadAll: async (sql) => {
    const rows = (await connection!.query(sql)).toArray().map((row) => plainValue(row) as Record<string, unknown>);
    return { getRowObjectsJson: () => rows };
  },
};

function options(): PlaygroundOptions {
  return { mode: modeInput.value as PlaygroundOptions['mode'], bins: Number(binsInput.value), correlations: correlationsInput.checked };
}

function setBusy(value: boolean) {
  busy = value;
  document.querySelector('.workspace')!.setAttribute('aria-busy', String(value));
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('[data-query-control]')) control.disabled = value;
  element('upload-label').classList.toggle('disabled', value);
  download.disabled = value || !currentReport;
  element<HTMLButtonElement>('previous').disabled = value || page === 0;
  element<HTMLButtonElement>('next').disabled = value || (page + 1) * pageSize >= total;
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message.split('\n')[0] : '处理失败，请重试。';
  errorBox.textContent = message.includes('Malformed JSON') ? 'JSON 格式无效，请检查文件后重试。' : message;
  errorBox.hidden = false;
}

async function run(operation: () => Promise<void>) {
  if (busy) return;
  setBusy(true);
  errorBox.hidden = true;
  loading.hidden = false;
  reportState.textContent = '生成中';
  reportState.classList.remove('ready');
  const started = performance.now();
  try {
    await operation();
    render();
    status.textContent = `全量计算 · ${Math.round(performance.now() - started).toLocaleString()} ms`;
  } catch (error) {
    showError(error);
    reportState.textContent = currentReport ? '未更新' : '生成失败';
    status.textContent = '本次处理未完成';
    loading.hidden = Boolean(currentReport);
    if (!currentReport) {
      element('loading-message').textContent = '请检查文件或网络连接，再点击重新生成。';
    }
  } finally {
    setBusy(false);
  }
}

async function connect() {
  if (connection) return;
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: bundles.mvp.mainModule, mainWorker: mvpWorker },
    eh: bundles.eh ? { mainModule: bundles.eh.mainModule, mainWorker: ehWorker } : undefined,
  });
  const worker = new Worker(bundle.mainWorker!);
  const instance = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  try {
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await instance.open({ query: { castBigIntToDouble: false, castDecimalToDouble: false, castTimestampToDate: false } });
    connection = await instance.connect();
    database = instance;
  } catch {
    await instance.terminate();
    throw new Error('计算引擎加载失败，请检查网络连接后点击重新生成。');
  }
}

async function updatePreview() {
  const head = document.createElement('tr');
  const indexHeading = document.createElement('th');
  indexHeading.textContent = '#';
  indexHeading.className = 'row-number';
  head.append(indexHeading);
  const typeNames = { numeric: '数值', string: '文本', boolean: '布尔', date: '日期时间', unknown: '其他类型' };
  for (const column of columns) {
    const heading = document.createElement('th');
    heading.textContent = column.name;
    heading.title = `${column.name} · ${column.type}`;
    const type = document.createElement('small');
    type.textContent = typeNames[kind(column.type)];
    heading.append(type);
    head.append(heading);
  }
  const data = (await adapter.runAndReadAll(`SELECT ${columns.map((column) => `${quote(column.name)}::VARCHAR AS ${quote(column.name)}`).join(', ')} FROM input LIMIT ${pageSize} OFFSET ${page * pageSize}`)).getRowObjectsJson();
  const body = document.createDocumentFragment();
  data.forEach((row, index) => {
    const tr = document.createElement('tr');
    const rowNumber = document.createElement('td');
    rowNumber.className = 'row-number';
    rowNumber.textContent = String(page * pageSize + index + 1);
    tr.append(rowNumber);
    for (const column of columns) {
      const cell = document.createElement('td');
      const value = row[column.name];
      cell.textContent = value === null ? '空值' : String(value);
      cell.title = value === null ? '缺失值' : String(value);
      cell.classList.toggle('null-cell', value === null);
      tr.append(cell);
    }
    body.append(tr);
  });
  element<HTMLTableElement>('preview').tHead!.replaceChildren(head);
  element<HTMLTableElement>('preview').tBodies[0].replaceChildren(body);
  element('data-empty').hidden = true;
  element('row-range').textContent = total ? `第 ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} 行，共 ${total.toLocaleString()} 行` : '数据为空表';
  element('page').textContent = `${page + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
}

async function compute() {
  element('loading-message').textContent = '正在计算已有数据，报告即将更新。';
  results = (await profileDataset(adapter, 'input', columns, options())).map((row) => ({ ...row, table_name: sourceName }));
}

async function updateDataset(name: string, format: string) {
  sourceName = name;
  currentReport = '';
  report.hidden = true;
  page = 0;
  columns = (await adapter.runAndReadAll("SELECT name,type FROM pragma_table_info('input')")).getRowObjectsJson() as ProfileColumn[];
  total = Number((await adapter.runAndReadAll('SELECT count(*)::VARCHAR AS n FROM input')).getRowObjectsJson()[0].n);
  element('dataset-name').textContent = sourceName;
  element('dataset-meta').textContent = `${total.toLocaleString()} 行 · ${columns.length} 列 · 完整数据参与计算`;
  document.querySelector('.file-mark')!.textContent = format;
  await updatePreview();
  await compute();
}

function render() {
  if (!results.length) return;
  const language = languageInput.value as ReportOptions['language'];
  const theme = themeInput.value as ReportOptions['theme'];
  const previous = currentReport ? report.contentDocument : null;
  const expanded = [...(previous?.querySelectorAll<HTMLDetailsElement>('details[id][open]') ?? [])].map((detail) => detail.id);
  const scroll = previous?.scrollingElement?.scrollTop ?? 0;
  currentReport = renderReport(results, { language, theme, title: language === 'en-US' ? 'Data profile' : '数据画像报告' });
  report.onload = () => {
    for (const id of expanded) {
      const detail = report.contentDocument?.getElementById(id) as HTMLDetailsElement | null;
      if (detail) detail.open = true;
    }
    report.contentWindow?.scrollTo(0, scroll);
  };
  report.srcdoc = currentReport.replace('<head>', '<head><base href="about:srcdoc">');
  report.hidden = false;
  loading.hidden = true;
  reportState.textContent = `${results.length} 项指标`;
  reportState.classList.add('ready');
  download.disabled = busy;
}

async function restore() {
  await connect();
  await connection!.query(sampleSQL);
  await updateDataset('电商订单 · 预设数据', 'CSV');
}

async function upload(file: File) {
  if (busy) return;
  let format: ReturnType<typeof fileFormat>;
  try { format = fileFormat(file); } catch (error) { showError(error); return; }
  await run(async () => {
    await connect();
    const name = `upload.${format}`;
    await database!.registerFileBuffer(name, new Uint8Array(await file.arrayBuffer()));
    let transaction = false;
    try {
      await connection!.query('BEGIN TRANSACTION');
      transaction = true;
      const reader = format === 'csv' ? "read_csv_auto('upload.csv', header = true)" : format === 'json' ? "read_json_auto('upload.json')" : "read_parquet('upload.parquet')";
      await connection!.query(`CREATE OR REPLACE TABLE input AS SELECT * FROM ${reader}`);
      const schema = (await adapter.runAndReadAll("SELECT name,type FROM pragma_table_info('input')")).getRowObjectsJson();
      if (!schema.length || schema.length > 200) throw new Error('请提供包含 1–200 列的数据。');
      await connection!.query('COMMIT');
      transaction = false;
    } finally {
      if (transaction) await connection!.query('ROLLBACK');
      await database!.dropFile(name);
    }
    await updateDataset(file.name, format.toUpperCase());
  });
}

for (const input of [modeInput, binsInput, correlationsInput]) input.addEventListener('change', () => void run(compute));
languageInput.addEventListener('change', render);
themeInput.addEventListener('change', () => { document.documentElement.dataset.theme = themeInput.value; render(); });
element('restore').addEventListener('click', () => void run(restore));
element('recompute').addEventListener('click', () => void run(connection ? compute : restore));
fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) void upload(fileInput.files[0]); fileInput.value = ''; });
for (const [id, direction] of [['previous', -1], ['next', 1]] as const) {
  element(id).addEventListener('click', async () => {
    if (busy) return;
    const previous = page;
    page += direction;
    setBusy(true);
    try { await updatePreview(); } catch (error) { page = previous; showError(error); } finally { setBusy(false); }
  });
}
const dropZone = element('drop-zone');
let dragDepth = 0;
dropZone.addEventListener('dragenter', (event) => { event.preventDefault(); if (!busy) { dragDepth++; dropZone.classList.add('dragging'); } });
dropZone.addEventListener('dragover', (event) => event.preventDefault());
dropZone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('dragging'); } });
dropZone.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; dropZone.classList.remove('dragging'); if (event.dataTransfer?.files[0]) void upload(event.dataTransfer.files[0]); });
download.addEventListener('click', () => {
  if (!currentReport) return;
  const url = URL.createObjectURL(new Blob([currentReport], { type: 'text/html;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${sourceName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-数据画像.html`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
void run(restore);
