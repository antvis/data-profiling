import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALL_METRICS } from 'data_profiling';
import { createFullProfileHandler } from '../site/full-server.mjs';
import sampleOptions from '../site/sample-options.json' with { type: 'json' };

const officialSite = 'https://data-profiling.antv.vision';
const python = process.env.PROFILING_PYTHON;

async function startEngine(t, settings) {
  const server = createServer(createFullProfileHandler(settings));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}/api/full-profile`;
}

function request(endpoint, options = {}, dataset, headers = {}) {
  const form = new FormData();
  form.set('options', JSON.stringify({ bins: 20, ...options }));
  if (dataset) form.set('dataset', dataset);
  return fetch(endpoint, {
    method: 'POST', body: form, headers: { Origin: officialSite, 'X-Data-Profiling': '1', ...headers },
  });
}

test('local engine accepts the official origin and validates request and file boundaries', async (t) => {
  const endpoint = await startEngine(t);
  const preflight = await fetch(endpoint, {
    method: 'OPTIONS', headers: { Origin: officialSite, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), officialSite);
  const unknownOrigin = await request(endpoint, {}, undefined, { Origin: 'https://unrelated.example' });
  assert.equal(unknownOrigin.status, 403);
  assert.equal(unknownOrigin.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await request(endpoint, {}, undefined, { 'X-Data-Profiling': '0' })).status, 400);
  const noDirectory = await request(endpoint, { types: { p: 'file' } }, new File(['p\nreceipt.txt\n'], 'paths.csv'));
  assert.equal(noDirectory.status, 400);
  assert.match((await noDirectory.json()).error, /指定允许读取的目录/);
  const oversized = new File([new Uint8Array(21 * 1024 * 1024)], 'big.csv');
  assert.equal((await request(endpoint, {}, oversized)).status, 413);
});

test('the preset returns all metric IDs using its bundled files', { skip: !python }, async (t) => {
  const endpoint = await startEngine(t, { python });
  const response = await request(endpoint, sampleOptions);
  const { results, error } = await response.json();
  assert.equal(response.status, 200, error);
  assert.deepEqual(new Set(results.map(({ metric }) => metric)), new Set(ALL_METRICS));
  assert.equal(results.find(({ metric }) => metric === 'row_count').value.value, '128');
  const exif = results.find(({ metric }) => metric === 'exif_tag_counts');
  assert.ok(exif.value.value.length > 0);
});

test('the full endpoint returns all 149 metrics and confines file reads to the selected directory', { skip: !python }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'full-profile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileRoot = join(root, 'files');
  await mkdir(fileRoot);
  await writeFile(join(fileRoot, 'note.txt'), 'sample');
  execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB", (6, 4), "blue").save(sys.argv[1])', join(fileRoot, 'image.jpg')]);
  const endpoint = await startEngine(t, { python, fileRoot });
  const csv = ['idx,n,series,category,flag,day,date_string,text,url,path,file,image'];
  for (let i = 0; i < 96; i++) {
    csv.push([
      i, i === 1 ? Infinity : Math.sin(i * 0.43) + i % 5, Math.sin(i * 0.7) + i % 3, `类别${i % 3}`, i % 5 < 2,
      `2026-01-0${1 + i % 6}`, i % 4 === 0 ? 'bad' : `2026-01-0${1 + i % 2}`, `样本 text ${i % 5}`,
      `https://example.com/${i % 3}?q=t#f`, `/data/example${i % 5}.txt`, 'note.txt', 'image.jpg',
    ].join(','));
  }
  const response = await request(endpoint, {
    timeIndex: 'idx',
    types: { series: 'timeseries', date_string: 'date', text: 'text', url: 'url', path: 'path', file: 'file', image: 'image' },
  }, new File([csv.join('\n')], 'mixed.csv'));
  const { results, error } = await response.json();
  assert.equal(response.status, 200, error);
  assert.deepEqual(new Set(results.map(({ metric }) => metric)), new Set(ALL_METRICS));
  assert.equal(results.find(({ metric, columns }) => metric === 'infinity_count' && columns[0] === 'n').value.value, '1');
  const fileSize = results.find(({ metric, columns }) => metric === 'file_size_bytes' && columns[0] === 'file');
  assert.equal(fileSize.value.value[0].value.path.value, 'note.txt');
  assert.equal(fileSize.value.value[0].value.bytes.value, '6');

  await writeFile(join(root, 'outside.txt'), 'outside the allowed directory');
  await symlink(join(root, 'outside.txt'), join(fileRoot, 'escape.txt'));
  const rejected = await request(endpoint, { types: { file: 'file' } }, new File(['file\nescape.txt\n'], 'bad.csv'));
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /outside fileRoot/);
});
