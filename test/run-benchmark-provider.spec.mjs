import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, 'scripts', 'run-benchmark.mjs');
const probe = path.join(root, 'test', 'fixtures', 'bench-provider-probe.cjs');

// The preload blocks user-provider reads and captures synthetic configuration
// before any write. Node's permission model also blocks child processes.
function runProvider(env, args = [], task = 'single-edit') {
  return spawnSync(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${path.join(root, 'scripts')}`,
      `--allow-fs-read=${path.join(root, 'bench', 'tasks')}`,
      `--allow-fs-read=${path.join(root, 'package.json')}`,
      `--allow-fs-read=${probe}`,
      '--require',
      probe,
      runner,
      '--task',
      task,
      ...args,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'C',
        LC_ALL: 'C',
        MOSS_BENCH_CLI: runner,
        ...env,
      },
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
}

const configured = {
  MOSS_BENCH_API_KEY: 'synthetic-bench-key',
  MOSS_BENCH_MODEL: 'environment-model',
  MOSS_BENCH_BASE_URL: 'https://environment.invalid/v1',
};

test('explicit provider flags do not read another application configuration', () => {
  const result = runProvider(
    {
      MOSS_BENCH_API_KEY: configured.MOSS_BENCH_API_KEY,
      EXPECT_MODEL: 'flag-model',
      EXPECT_BASE_URL: 'https://flag.invalid/v1',
    },
    ['--model', 'flag-model', '--base-url', 'https://flag.invalid/v1']
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_USER_PROVIDER_READ/);
  assert.deepEqual(JSON.parse(result.stdout), {
    modelMatches: true,
    baseUrlMatches: true,
    keyMatches: true,
  });
});

test('environment provider settings work and flags take precedence', () => {
  for (const [args, model, baseUrl] of [
    [[], 'environment-model', 'https://environment.invalid/v1'],
    [['--model', 'flag-model'], 'flag-model', 'https://environment.invalid/v1'],
    [['--base-url', 'https://flag.invalid/v1'], 'environment-model', 'https://flag.invalid/v1'],
  ]) {
    const result = runProvider(
      { ...configured, EXPECT_MODEL: model, EXPECT_BASE_URL: baseUrl },
      args
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_USER_PROVIDER_READ/);
    assert.deepEqual(JSON.parse(result.stdout), {
      modelMatches: true,
      baseUrlMatches: true,
      keyMatches: true,
    });
  }
});

for (const source of ['environment', 'flag']) {
  test(`benchmark summary omits an endpoint with secrets supplied by ${source}`, () => {
    const endpoint =
      'https://user:SYNTHETIC_SECRET@example.invalid/v1/SYNTHETIC_SECRET?token=SYNTHETIC_SECRET#SYNTHETIC_SECRET';
    const result = runProvider(
      {
        ...configured,
        MOSS_BENCH_BASE_URL: source === 'environment' ? endpoint : configured.MOSS_BENCH_BASE_URL,
        EXPECT_MODEL: configured.MOSS_BENCH_MODEL,
        EXPECT_BASE_URL: endpoint,
        CAPTURE_SUMMARY: '1',
      },
      source === 'flag' ? ['--base-url', endpoint] : [],
      'device-observe-evidence'
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const capture = result.stdout.split('\n').find((line) => line.startsWith('SYNTHETIC_SUMMARY '));
    assert.ok(capture, 'expected synthetic summary');
    assert.deepEqual(JSON.parse(capture.slice('SYNTHETIC_SUMMARY '.length)), {
      configMatches: { modelMatches: true, baseUrlMatches: true, keyMatches: true },
      baseUrlOmitted: true,
      containsSecret: false,
    });
  });
}

test('benchmark passes the configured endpoint to the sample CLI', () => {
  const endpoint = 'https://example.invalid/v1?token=SYNTHETIC_SECRET';
  const result = runProvider(
    {
      ...configured,
      MOSS_BENCH_BASE_URL: endpoint,
      MOSS_DEVICE_HOST: 'synthetic-device.invalid',
      EXPECT_MODEL: configured.MOSS_BENCH_MODEL,
      EXPECT_BASE_URL: endpoint,
      CAPTURE_CHILD: '1',
    },
    [],
    'device-observe-evidence'
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const capture = result.stdout.split('\n').find((line) => line.startsWith('SYNTHETIC_CHILD '));
  assert.ok(capture, 'expected intercepted CLI invocation');
  assert.deepEqual(JSON.parse(capture.slice('SYNTHETIC_CHILD '.length)), {
    configMatches: { modelMatches: true, baseUrlMatches: true, keyMatches: true },
    expectedExecutable: true,
    baseUrlMatches: true,
  });
});

for (const field of Object.keys(configured)) {
  test(`missing or blank ${field} fails without consulting other applications`, () => {
    for (const value of [undefined, '   ']) {
      const env = { ...configured, [field]: value };
      const result = runProvider(env);
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /MOSS_BENCH_API_KEY/);
      assert.doesNotMatch(result.stderr, /UNEXPECTED_USER_PROVIDER_READ/);
    }
  });
}
