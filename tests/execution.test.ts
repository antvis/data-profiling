import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  createProfilingPlan,
  profile,
  ALL_METRICS,
  type ProfileColumn,
  type ProfileResult,
  type MetricValue,
} from 'data_profiling';
import { openFixture } from './fixture';

const python = process.env.PROFILING_PYTHON;
const integer = (value: string): MetricValue => ({ type: 'integer', value });
const number = (value: number): MetricValue => ({ type: 'number', value });
const get = (rows: ProfileResult[], metric: string, column?: string) =>
  rows.find((row) => row.metric === metric && (column ? row.columns[0] === column : !row.columns.length))?.value;
const schema = async (connection: Awaited<ReturnType<typeof openFixture>>, table: string) =>
  (
    await connection.runAndReadAll('SELECT name,type FROM pragma_table_info(?)', [table])
  ).getRowObjectsJson() as ProfileColumn[];

test('frequency transports preserve exact values and reject lossy or malformed scalars', async () => {
  const read = (type: string, value: unknown, count: unknown = '2') =>
    profile(
      {
        run: async () => { throw new Error('Unexpected export'); },
        runAndReadAll: async () => ({ getRowObjectsJson: () => [{ value_counts: [{ value, count }] }] }),
      },
      'sample', [{ name: 'value', type }], { metrics: ['value_counts'] }
    );
  const exact = await read('BIGINT', '9007199254740993', '9007199254740995');
  assert.deepEqual(exact[0].value, {
    type: 'list', value: [{ type: 'object', value: {
      value: integer('9007199254740993'), count: integer('9007199254740995'),
    } }],
  });
  for (const [type, value, count] of [
    ['BIGINT', Number.MAX_SAFE_INTEGER + 1, '2'],
    ['BIGINT', '1', Number.MAX_SAFE_INTEGER + 1],
    ['DECIMAL(20,2)', 1.25, '2'],
    ['BOOLEAN', 'false', '2'],
    ['DOUBLE', 'invalid', '2'],
  ] as const) await assert.rejects(read(type, value, count), /Invalid|lossy/);
});

test('native histogram counts reject lossy integer transports', async () => {
  let reads = 0;
  await assert.rejects(profile({
    run: async () => { throw new Error('Unexpected export'); },
    runAndReadAll: async () => ({ getRowObjectsJson: () => [++reads === 1
      ? { lo0: 0, hi0: 2, n0: 4, d0: 2 }
      : { h0: [Number.MAX_SAFE_INTEGER + 1, '1'] }] }),
  }, 'sample', [{ name: 'value', type: 'DOUBLE' }], {
    metrics: ['numeric_histogram'], bins: 2,
  }), /lossy integer/);
});

test('profiling streaming metrics and Pearson use native aggregates without Python or export', async (t) => {
  const c = await openFixture(t);
  await c.run('CREATE TABLE profile_native AS SELECT i AS idx, i::DOUBLE - 2 AS x, i * 2 AS y FROM range(5) t(i)');
  const rows = await profile(
    {
      run: async () => {
        throw new Error('Unexpected export');
      },
      runAndReadAll: (sql) => c.runAndReadAll(sql),
    },
    'profile_native',
    await schema(c, 'profile_native'),
    {
      python: '/does/not/exist',
      metrics: [
        'observation_count',
        'present_count',
        'missing_rate',
        'distinct_rate',
        'is_unique',
        'negative_count',
        'negative_rate',
        'zero_count',
        'zero_rate',
        'infinity_count',
        'infinity_rate',
        'variance_samp',
        'stddev_samp',
        'cv',
        'range',
        'iqr',
        'mad',
        'skewness',
        'excess_kurtosis',
        'pearson_r',
        'column_type_counts',
      ],
    }
  );
  assert.deepEqual(get(rows, 'observation_count', 'x'), integer('5'));
  assert.deepEqual(get(rows, 'present_count', 'x'), integer('5'));
  assert.deepEqual(get(rows, 'missing_rate', 'x'), number(0));
  assert.deepEqual(get(rows, 'distinct_rate', 'x'), number(1));
  assert.deepEqual(get(rows, 'is_unique', 'x'), { type: 'boolean', value: true });
  assert.deepEqual(get(rows, 'negative_count', 'x'), integer('2'));
  assert.deepEqual(get(rows, 'negative_rate', 'x'), number(0.4));
  assert.deepEqual(get(rows, 'zero_count', 'x'), integer('1'));
  assert.deepEqual(get(rows, 'zero_rate', 'x'), number(0.2));
  assert.deepEqual(get(rows, 'infinity_count', 'x'), integer('0'));
  assert.deepEqual(get(rows, 'variance_samp', 'x'), number(2.5));
  assert.deepEqual(get(rows, 'stddev_samp', 'x'), number(Math.sqrt(2.5)));
  assert.deepEqual(get(rows, 'cv', 'x'), { type: 'null', value: null });
  assert.deepEqual(get(rows, 'range', 'x'), number(4));
  assert.deepEqual(get(rows, 'iqr', 'x'), number(2));
  assert.deepEqual(get(rows, 'mad', 'x'), number(1));
  assert.deepEqual(get(rows, 'skewness', 'x'), number(0));
  const kurtosis = get(rows, 'excess_kurtosis', 'x');
  assert.ok(kurtosis?.type === 'number' && Math.abs(Number(kurtosis.value) + 1.2) < 1e-14);
  assert.equal(rows.filter((row) => row.metric === 'pearson_r').length, 3);
  assert.ok(
    rows
      .filter((row) => row.metric === 'pearson_r')
      .every((row) => row.value.type === 'number' && Math.abs(Number(row.value.value) - 1) < 1e-14)
  );
});

test('profiling missingness includes NaN and retains infinities without changing finite-only defaults', async (t) => {
  const c = await openFixture(t);
  await c.run(
    `CREATE TABLE profile_special AS SELECT * FROM (VALUES (1::DOUBLE), (0), ('Infinity'), ('-Infinity'), ('NaN'), (NULL)) t(x)`
  );
  const columns = await schema(c, 'profile_special');
  const metrics = [
    'observation_count',
    'present_count',
    'null_count',
    'missing_count',
    'missing_rate',
    'distinct_count',
    'min',
    'max',
    'stddev',
    'variance_samp',
    'negative_count',
    'infinity_count',
    'infinity_rate',
  ];
  const rows = await profile(c, 'profile_special', columns, { metrics });
  assert.deepEqual(get(rows, 'present_count', 'x'), integer('4'));
  assert.deepEqual(get(rows, 'missing_count', 'x'), integer('2'));
  assert.deepEqual(get(rows, 'missing_rate', 'x'), number(1 / 3));
  assert.deepEqual(get(rows, 'distinct_count', 'x'), integer('4'));
  assert.deepEqual(get(rows, 'negative_count', 'x'), integer('1'));
  assert.deepEqual(get(rows, 'infinity_count', 'x'), integer('2'));
  assert.deepEqual(get(rows, 'infinity_rate', 'x'), number(1 / 3));
  assert.deepEqual(get(rows, 'min', 'x'), { type: 'number', value: '-Infinity' });
  assert.deepEqual(get(rows, 'max', 'x'), { type: 'number', value: 'Infinity' });
  assert.deepEqual(get(rows, 'variance_samp', 'x'), { type: 'number', value: 'NaN' });
  const finite = createProfilingPlan('profile_special', columns, { metrics: ['null_count', 'min', 'max'] });
  const original = finite.decode((await c.runAndReadAll(finite.sql)).getRowObjectsJson()[0]);
  assert.deepEqual(get(original, 'null_count', 'x'), integer('1'));
  assert.deepEqual(get(original, 'min', 'x'), number(0));
  assert.deepEqual(get(original, 'max', 'x'), number(1));
});

test('profiling table missingness and duplicate groups retain empty-table and group semantics', async (t) => {
  const c = await openFixture(t);
  await c.run(
    `CREATE TABLE profile_duplicates AS SELECT * FROM (VALUES (1,'a'),(1,'a'),(2,NULL),(2,NULL),(2,NULL),(3,'b')) t(n,s)`
  );
  const metrics = [
    'missing_cell_count',
    'missing_cell_rate',
    'columns_with_missing_count',
    'all_missing_column_count',
    'duplicate_group_count',
    'duplicate_group_rate',
    'duplicate_group_row_count',
  ];
  const rows = await profile(c, 'profile_duplicates', await schema(c, 'profile_duplicates'), { metrics });
  assert.deepEqual(get(rows, 'missing_cell_count'), integer('3'));
  assert.deepEqual(get(rows, 'missing_cell_rate'), number(0.25));
  assert.deepEqual(get(rows, 'columns_with_missing_count'), integer('1'));
  assert.deepEqual(get(rows, 'all_missing_column_count'), integer('0'));
  assert.deepEqual(get(rows, 'duplicate_group_count'), integer('2'));
  assert.deepEqual(get(rows, 'duplicate_group_rate'), number(1 / 3));
  assert.deepEqual(get(rows, 'duplicate_group_row_count'), { type: 'list', value: [integer('3'), integer('2')] });
  await c.run('DELETE FROM profile_duplicates');
  const empty = await profile(c, 'profile_duplicates', await schema(c, 'profile_duplicates'), { metrics });
  for (const metric of metrics)
    assert.deepEqual(
      get(empty, metric),
      metric === 'duplicate_group_row_count'
        ? { type: 'list', value: [] }
        : metric.endsWith('_rate')
        ? number(0)
        : integer('0')
    );
});

test(
  'all profiling metric families execute with weighted text, file/image I/O, correlations and time series',
  { skip: !python },
  async (t) => {
    const c = await openFixture(t);
    const directory = await mkdtemp(join(tmpdir(), 'profiling-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    execFileSync(python!, [
      '-c',
      `from pathlib import Path
from PIL import Image
import sys
p=Path(sys.argv[1]);(p/'file.txt').write_text('hello world')
im=Image.new('RGB',(6,4),(0,0,255));exif=Image.Exif();exif[271]='profiling test';im.save(p/'image.jpg',exif=exif)
`,
      directory,
    ]);
    await c.run(
      `CREATE TABLE profile_all AS SELECT i AS idx, sin(i*.7)+i%3 AS ts, i::DOUBLE AS x, i*2.0 AS y,
    i%2=0 AS b, 'a'||(i%3) AS cat, 'b'||(i%2) AS cat2, 'Hello 中文 😀 world!' AS s,
    'https://example.com/p?q=1#f' AS url, '/a/b.txt' AS path, ?::VARCHAR AS file, ?::VARCHAR AS image,
    DATE '2026-01-01' + i::INTEGER AS day FROM range(128) t(i)`,
      [join(directory, 'file.txt'), join(directory, 'image.jpg')]
    );
    const rows = await profile(c, 'profile_all', await schema(c, 'profile_all'), {
      python,
      timeIndex: 'idx',
      types: { ts: 'timeseries', s: 'text', url: 'url', path: 'path', file: 'file', image: 'image' },
      lags: 5,
    });
    const present = new Set(rows.map((row) => row.metric));
    assert.deepEqual(
      ALL_METRICS.filter((metric) => !present.has(metric)),
      []
    );
    assert.equal(new Set(rows.map((row) => JSON.stringify([row.columns, row.metric]))).size, rows.length);
    assert.deepEqual(get(rows, 'mean_image_width', 'image'), number(6));
    assert.deepEqual(get(rows, 'min_image_height', 'image'), integer('4'));
    assert.deepEqual(get(rows, 'median_image_area', 'image'), number(24));
    assert.deepEqual(get(rows, 'duplicate_image_hash_count', 'image'), integer('127'));
    assert.deepEqual(get(rows, 'path_common_prefix', 'path'), { type: 'string', value: '/a/b.txt' });
    assert.deepEqual(get(rows, 'singleton_count', 'x'), integer('128'));
    assert.deepEqual(get(rows, 'singleton_rate', 'x'), number(1));
    assert.deepEqual(get(rows, 'character_count', 's'), integer(String([...'Hello 中文 😀 world!'].length * 128)));
    const quantiles = get(rows, 'quantiles', 'x');
    assert.equal(quantiles?.type, 'object');
    if (quantiles?.type === 'object') assert.deepEqual(quantiles.value['0.5'], number(63.5));
    assert.deepEqual(get(rows, 'invalid_date_count', 'day'), integer('0'));
    assert.deepEqual(get(rows, 'gap_count', 'ts'), integer('0'));
    assert.deepEqual(get(rows, 'time_index_observation_count'), integer('128'));
    assert.equal(get(rows, 'acf', 'ts')?.type, 'list');
    assert.equal(get(rows, 'pacf', 'ts')?.type, 'list');
    assert.equal(get(rows, 'adf_p_value', 'ts')?.type, 'number');
    assert.doesNotThrow(() => JSON.stringify(rows));
  }
);

test(
  'profiling optional stages handle empty inputs, invalid dates and missing files explicitly',
  { skip: !python },
  async (t) => {
    const c = await openFixture(t);
    await c.run(`CREATE TABLE profile_dates AS SELECT * FROM (VALUES ('2026-01-01'),('bad'),('bad'),(NULL)) t(d)`);
    const rows = await profile(c, 'profile_dates', await schema(c, 'profile_dates'), {
      python,
      types: { d: 'date' },
      metrics: ['invalid_date_distinct_count', 'invalid_date_count', 'invalid_date_rate', 'datetime_histogram'],
    });
    assert.deepEqual(get(rows, 'invalid_date_distinct_count', 'd'), integer('1'));
    assert.deepEqual(get(rows, 'invalid_date_count', 'd'), integer('2'));
    assert.deepEqual(get(rows, 'invalid_date_rate', 'd'), number(0.5));
    await c.run('DELETE FROM profile_dates');
    const empty = await profile(c, 'profile_dates', await schema(c, 'profile_dates'), {
      python,
      types: { d: 'date' },
      metrics: ['invalid_date_count', 'value_counts', 'datetime_histogram'],
    });
    assert.deepEqual(get(empty, 'invalid_date_count', 'd'), integer('0'));
    assert.deepEqual(get(empty, 'value_counts', 'd'), { type: 'list', value: [] });
    await c.run(`INSERT INTO profile_dates VALUES ('/does/not/exist')`);
    await assert.rejects(
      profile(c, 'profile_dates', await schema(c, 'profile_dates'), {
        python,
        types: { d: 'file' },
        metrics: ['file_size_bytes'],
      }),
      /FileNotFoundError/
    );
  }
);

test('profiling classifies complex types and prototype-like column names from the shared native schema', async (t) => {
  const c = await openFixture(t);
  await c.run(`CREATE TABLE profile_names AS SELECT [1] AS "constructor", 2 AS "__proto__", 'x' AS s`);
  const rows = await profile(c, 'profile_names', await schema(c, 'profile_names'), {
    python: '/does/not/exist',
    types: { s: 'text' },
    metrics: ['profiling_type', 'present_count', 'singleton_count', 'pearson_r'],
  });
  assert.deepEqual(get(rows, 'profiling_type', 'constructor'), { type: 'string', value: 'Unsupported' });
  assert.deepEqual(get(rows, 'profiling_type', '__proto__'), { type: 'string', value: 'Numeric' });
  assert.equal(get(rows, 'singleton_count', 'constructor'), undefined);
  assert.equal(
    rows.some((row) => row.metric === 'pearson_r'),
    false
  );
  const metadata = createProfilingPlan('profile_names', await schema(c, 'profile_names'), {
    metrics: ['profiling_type', 'declared_type'],
  });
  assert.doesNotMatch(metadata.sql, /query_table/);
  await c.run('CREATE TABLE profile_constant AS SELECT 1.0 AS n FROM range(5)');
  const constant = await profile(c, 'profile_constant', await schema(c, 'profile_constant'), {
    metrics: ['skewness', 'excess_kurtosis'],
  });
  assert.deepEqual(get(constant, 'skewness', 'n'), number(0));
  assert.deepEqual(get(constant, 'excess_kurtosis', 'n'), number(0));
});

test('native profiling quantiles and histograms preserve NumPy boundary conventions without export', async (t) => {
  const c = await openFixture(t);
  await c.run(
    `CREATE TABLE profile_bins AS SELECT * FROM (VALUES (0::DOUBLE),(1),(2),(3),('Infinity'),('NaN'),(NULL))t(n)`
  );
  const columns = await schema(c, 'profile_bins');
  const connection = {
    run: async () => {
      throw Error('Unexpected export');
    },
    runAndReadAll: (sql: string) => c.runAndReadAll(sql),
  };
  const rows = await profile(connection, 'profile_bins', columns, {
    metrics: ['quantiles', 'numeric_histogram', 'chi_squared_statistic'],
    python: '/does/not/exist',
    bins: 3,
    quantiles: [0, 0.5, 1],
  });
  const histogram = get(rows, 'numeric_histogram', 'n');
  assert.deepEqual(histogram, {
    type: 'object',
    value: {
      counts: { type: 'list', value: [integer('1'), integer('1'), integer('2')] },
      edges: { type: 'list', value: [number(0), number(1), number(2), number(3)] },
    },
  });
  const quantiles = get(rows, 'quantiles', 'n');
  assert.deepEqual(quantiles, {
    type: 'object',
    value: { '0': number(0), '0.5': number(2), '1': { type: 'number', value: 'Infinity' } },
  });
  const density = await profile(connection, 'profile_bins', columns, {
    metrics: ['numeric_histogram'],
    bins: 3,
    density: true,
  });
  assert.deepEqual(get(density, 'numeric_histogram', 'n'), {
    type: 'object',
    value: {
      counts: { type: 'list', value: [number(0.25), number(0.25), number(0.5)] },
      edges: { type: 'list', value: [number(0), number(1), number(2), number(3)] },
    },
  });
  await c.run('DELETE FROM profile_bins');
  const empty = await profile(connection, 'profile_bins', columns, {
    metrics: ['quantiles', 'numeric_histogram', 'chi_squared_p_value'],
  });
  assert.deepEqual(get(empty, 'numeric_histogram', 'n'), {
    type: 'object',
    value: { counts: { type: 'list', value: [] }, edges: { type: 'list', value: [] } },
  });
  assert.deepEqual(get(empty, 'chi_squared_p_value', 'n'), number(0));
});

test('profiling validates requests before I/O and cleans exports when a worker fails', async (t) => {
  const c = await openFixture(t);
  const columns = await schema(c, 'sample');
  for (const options of [
    { metrics: ['unknown'] },
    { types: { unknown: 'text' } },
    { orderBy: ['unknown'] },
    { bins: -1 },
    { quantiles: [2] },
    { significance: 0 },
    { maxlag: 1.5 },
    { autolag: 'other' },
    { metrics: [{ id: 'mad', unknown: 1 }] },
  ]) {
    await assert.rejects(profile(c, 'sample', columns, options as never));
  }
  const paths: string[] = [];
  const connection = {
    runAndReadAll: (sql: string) => c.runAndReadAll(sql),
    run: (sql: string) => {
      const path = / TO '([^']+)'/.exec(sql)?.[1];
      if (path) paths.push(path);
      return c.run(sql);
    },
  };
  await assert.rejects(
    profile(connection, 'sample', columns, { metrics: ['word_counts'], python: '/does/not/exist' }),
    /ENOENT/
  );
  assert.ok(paths.length);
  for (const path of paths) await assert.rejects(access(dirname(path)));
});

test('native profiling frequencies preserve integer precision, ties and empty values without Python', async (t) => {
  const c = await openFixture(t);
  await c.run(`CREATE TABLE profile_frequency AS SELECT * FROM (VALUES
    ('9007199254740993'::BIGINT, true, 'a'), ('9007199254740993', false, 'a'),
    ('9007199254740994', false, ''), (NULL,NULL,NULL)) t(n,b,s)`);
  const metrics = [
    'value_counts',
    'value_counts_by_value',
    'singleton_count',
    'singleton_rate',
    'category_imbalance_score',
    'boolean_mode',
    'boolean_mode_count',
  ];
  const rows = await profile(c, 'profile_frequency', await schema(c, 'profile_frequency'), {
    metrics,
    python: '/does/not/exist',
  });
  assert.deepEqual(get(rows, 'boolean_mode', 'b'), { type: 'boolean', value: false });
  assert.deepEqual(get(rows, 'boolean_mode_count', 'b'), integer('2'));
  assert.deepEqual(get(rows, 'singleton_rate', 'n'), number(1 / 3));
  const values = get(rows, 'value_counts_by_value', 'n');
  assert.equal(values?.type, 'list');
  if (values?.type === 'list')
    assert.deepEqual(values.value[0], {
      type: 'object',
      value: { value: integer('9007199254740993'), count: integer('2') },
    });
  await c.run('DELETE FROM profile_frequency');
  const empty = await profile(c, 'profile_frequency', await schema(c, 'profile_frequency'), {
    metrics,
    python: '/does/not/exist',
  });
  assert.deepEqual(get(empty, 'boolean_mode', 'b'), { type: 'null', value: null });
  assert.deepEqual(get(empty, 'boolean_mode_count', 'b'), integer('0'));
  assert.deepEqual(get(empty, 'category_imbalance_score', 's'), number(0));
});

test(
  'profiling grouped quantiles preserve large integers and decimals and workers observe changes',
  { skip: !python },
  async (t) => {
    const c = await openFixture(t);
    await c.run(`CREATE TABLE profile_precise AS SELECT
    '1267650600228229401496703205376'::HUGEINT + i AS h,
    '12345678901234567890.123456780'::DECIMAL(38,9)+i*.000000001 AS d FROM range(5)t(i)`);
    const rows = await profile(c, 'profile_precise', await schema(c, 'profile_precise'), {
      python,
      metrics: ['quantiles'],
      quantiles: [0.5],
    });
    const h = get(rows, 'quantiles', 'h'),
      d = get(rows, 'quantiles', 'd');
    assert.equal(h?.type, 'object');
    assert.equal(d?.type, 'object');
    if (h?.type === 'object') assert.deepEqual(h.value['0.5'], integer('1267650600228229401496703205378'));
    if (d?.type === 'object')
      assert.deepEqual(d.value['0.5'], { type: 'decimal', value: '12345678901234567890.1234567820' });
    const directory = await mkdtemp(join(tmpdir(), 'profiling-file-cache-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'file');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'a');
    await c.run('CREATE TABLE profile_changed(p VARCHAR)');
    await c.run('INSERT INTO profile_changed VALUES (?)', [path]);
    const columns = await schema(c, 'profile_changed');
    const read = () =>
      profile(c, 'profile_changed', columns, { python, metrics: ['file_size_bytes'], types: { p: 'file' } });
    const first = get(await read(), 'file_size_bytes', 'p');
    await writeFile(path, 'longer');
    const second = get(await read(), 'file_size_bytes', 'p');
    assert.notDeepEqual(first, second);
    const concurrent = await Promise.all([read(), read()]);
    assert.deepEqual(concurrent[0], concurrent[1]);
  }
);

test(
  'profiling ordered stages detect gaps, parse date bounds and recover after a failed request',
  { skip: !python },
  async (t) => {
    const c = await openFixture(t);
    await c.run(
      `CREATE TABLE profile_gaps AS SELECT * FROM (VALUES (0,1.0),(1,2.0),(2,NULL),(50,3.0),(51,4.0),(52,5.0))t(idx,n)`
    );
    const rows = await profile(c, 'profile_gaps', await schema(c, 'profile_gaps'), {
      python,
      timeIndex: 'idx',
      types: { n: 'timeseries' },
      metrics: ['gap_count', 'gap_endpoints', 'min_gap', 'is_strictly_increasing'],
    });
    assert.deepEqual(get(rows, 'gap_count', 'n'), integer('1'));
    assert.deepEqual(get(rows, 'min_gap', 'n'), number(49));
    assert.deepEqual(get(rows, 'gap_endpoints', 'n'), {
      type: 'list',
      value: [{ type: 'list', value: [integer('1'), integer('50')] }],
    });
    assert.deepEqual(get(rows, 'is_strictly_increasing', 'n'), { type: 'boolean', value: true });
    await c.run(`CREATE TABLE profile_bounds AS SELECT * FROM (VALUES ('2026-01-01'),('2026-01-03'),('bad'))t(d)`);
    const columns = await schema(c, 'profile_bounds');
    await assert.rejects(
      profile(c, 'profile_bounds', columns, { python, types: { d: 'file' }, metrics: ['file_size_bytes'] }),
      /FileNotFoundError/
    );
    const parsed = await profile(c, 'profile_bounds', columns, {
      python,
      types: { d: 'date' },
      metrics: ['min_timestamp', 'max_timestamp', 'time_span'],
    });
    assert.deepEqual(get(parsed, 'min_timestamp', 'd'), { type: 'timestamptz', value: '2026-01-01T00:00:00Z' });
    assert.deepEqual(get(parsed, 'time_span', 'd'), {
      type: 'duration',
      value: { amount: '172800000000000', unit: 'nanosecond' },
    });
  }
);
