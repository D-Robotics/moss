import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, 'scripts', 'run-benchmark.mjs');

// A parser regression must not reach user config or launch a real benchmark.
function runArgs(args) {
  return spawnSync(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${path.join(root, 'scripts')}`,
      `--allow-fs-read=${path.join(root, 'bench', 'tasks')}`,
      `--allow-fs-read=${path.join(root, 'package.json')}`,
      runner,
      ...args,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
}

for (const value of ['0', '0.5', '2', 'none']) {
  test(`benchmark temperature ${value} leaves subsequent options intact`, () => {
    const result = runArgs(['--temperature', value, '--task', 'single-edit', '--list']);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^single-edit\s/m);
  });
}

for (const value of ['', '-0.1', '2.1', 'NaN', 'Infinity']) {
  test(`benchmark rejects unsupported temperature ${value}`, () => {
    const result = runArgs(['--temperature', value, '--task', 'single-edit', '--list']);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /temperature/i);
  });
}

for (const flag of ['--label', '--task', '--model', '--base-url', '--temperature']) {
  test(`${flag} cannot consume the next option as its value`, () => {
    const result = runArgs([flag, '--list', '--help']);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires a value/);
  });
}

for (const flag of [
  '--task',
  '--baseline',
  '--capability-gate',
  '--label',
  '--model',
  '--base-url',
]) {
  test(`${flag} rejects empty values before starting a benchmark`, () => {
    for (const args of [
      [`${flag}=`, '--help'],
      [flag, ' ', '--help'],
    ]) {
      const result = runArgs(args);
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /requires a value/);
    }
  });
}

test('option-like seed values can be passed explicitly with equals', () => {
  const result = runArgs(['--tasks', '1', '--seed=--nightly', '--list']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /seed=--nightly\b/);
});

test('empty seed remains an explicit deterministic value', () => {
  const result = runArgs(['--tasks=1', '--seed=', '--list']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /seed= ids=/);
});

test('equals inside a value is preserved', () => {
  const result = runArgs(['--tasks=1', '--seed=first=second', '--list']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /seed=first=second\b/);
});

test('temperature also accepts the equals form', () => {
  const result = runArgs(['--temperature=0.5', '--task', 'single-edit', '--list']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^single-edit\s/m);
});

test('flags that do not take values reject the equals form', () => {
  const result = runArgs(['--list=unexpected', '--help']);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not accept a value/);
});
