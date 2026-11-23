import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { profile } from 'data_profiling';

const siteOrigin = 'https://data-profiling.antv.vision';
const sampleFileRoot = fileURLToPath(new URL('./sample-files/', import.meta.url));
const maxFileBytes = 20 * 1024 * 1024;
const maxRequestBytes = maxFileBytes + 256 * 1024;
const readers = {
  csv: 'read_csv_auto(?, header = true)',
  json: 'read_json_auto(?)',
  parquet: 'read_parquet(?)',
};

function respond(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readForm(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxRequestBytes) return null;
    chunks.push(chunk);
  }
  return new Request('http://127.0.0.1', {
    method: 'POST',
    headers: { 'Content-Type': request.headers['content-type'] },
    body: Buffer.concat(chunks, size),
  }).formData();
}

async function profileForm(form, { python, fileRoot: uploadedFileRoot }) {
  const config = form.get('options');
  if (typeof config !== 'string') throw new Error('缺少统计配置。');
  const { bins, types, timeIndex, orderBy } = JSON.parse(config);
  if (![0, 10, 20, 30, 50].includes(bins) || (types !== undefined &&
      (!types || typeof types !== 'object' || Array.isArray(types)))) throw new Error('无效的统计配置。');
  const dataset = form.get('dataset');
  const fileRoot = dataset === null ? sampleFileRoot : uploadedFileRoot;
  if (!fileRoot && Object.values(types ?? {}).some((role) => role === 'file' || role === 'image')) {
    throw new Error('文件与图像统计需要指定允许读取的目录。请运行 npm run full:site -- /路径/到/文件目录。');
  }

  const format = dataset instanceof File ? dataset.name.split('.').at(-1)?.toLowerCase() : undefined;
  if (dataset !== null && (!(dataset instanceof File) || !format || !Object.hasOwn(readers, format) ||
      !dataset.size || dataset.size > maxFileBytes)) throw new Error('请选择 20 MB 以内的 CSV、JSON 或 Parquet 数据。');

  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  let connection;
  let directory;
  try {
    connection = await instance.connect();
    if (dataset) {
      directory = await mkdtemp(join(tmpdir(), 'data-profiling-site-'));
      const input = join(directory, `input.${format}`);
      await writeFile(input, new Uint8Array(await dataset.arrayBuffer()));
      await connection.run(`CREATE TABLE input AS SELECT * FROM ${readers[format]}`, [input]);
    } else {
      await connection.run(await readFile(new URL('./sample.sql', import.meta.url), 'utf8'));
    }
    const columns = (await connection.runAndReadAll("SELECT name,type FROM pragma_table_info('input')")).getRowObjectsJson();
    if (!columns.length || columns.length > 200) throw new Error('请提供包含 1–200 列的数据。');
    return await profile(connection, 'input', columns, { bins, maxBins: 50, types, timeIndex, orderBy, python, fileRoot });
  } finally {
    connection?.closeSync();
    instance.closeSync();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function createFullProfileHandler(settings = {}) {
  let running = false;
  return async (request, response) => {
    const host = `127.0.0.1:${request.socket.localPort}`;
    const origin = request.headers.origin;
    if (request.headers.host !== host ||
        ![siteOrigin, `http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin)) {
      return respond(response, 403, { error: '来源不受本机引擎信任。' });
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] === 'POST') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, X-Data-Profiling',
      });
      return response.end();
    }
    if (request.method !== 'POST' || request.headers['x-data-profiling'] !== '1' ||
        !request.headers['content-type']?.startsWith('multipart/form-data;')) {
      return respond(response, 400, { error: '无效的全量统计请求。' });
    }
    if (running) return respond(response, 409, { error: '本机引擎正在计算，请稍后重试。' });
    running = true;
    try {
      const form = await readForm(request);
      if (!form) {
        response.setHeader('Connection', 'close');
        request.resume();
        return respond(response, 413, { error: '全量统计请求超过大小限制。' });
      }
      respond(response, 200, { results: await profileForm(form, settings) });
    } catch (error) {
      const message = error instanceof Error ? error.message.trim().split(/\r?\n/).at(-1) : '本机画像失败。';
      respond(response, 400, {
        error: message?.includes('ModuleNotFoundError') || message?.includes('spawn')
          ? '本机 Python 或依赖不可用。请安装 python-requirements.txt 中的依赖，并检查 PROFILING_PYTHON。'
          : message,
      });
    } finally {
      running = false;
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fileRoot = process.argv[2] ? await realpath(process.argv[2]) : undefined;
  if (fileRoot && !(await stat(fileRoot)).isDirectory()) throw new Error('请指定一个文件目录。');
  const { preview } = await import('vite');
  const server = await preview({
    configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
    preview: { host: '127.0.0.1', port: 5174, strictPort: true, cors: false, allowedHosts: [] },
    plugins: [{
      name: 'local-full-profiling',
      configurePreviewServer(server) {
        server.middlewares.use('/api/full-profile', createFullProfileHandler({ fileRoot, python: process.env.PROFILING_PYTHON }));
      },
    }],
  });
  server.printUrls();
}
