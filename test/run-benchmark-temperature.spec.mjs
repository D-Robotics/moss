import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, 'scripts', 'run-benchmark.mjs');

function listWithTemperature(value) {
  return spawnSync(
    process.execPath,
    [runner, '--temperature', value, '--task', 'single-edit', '--list'],
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
    const result = listWithTemperature(value);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^single-edit\s/m);
  });
}

for (const value of ['', '-0.1', '2.1', 'NaN', 'Infinity']) {
  test(`benchmark rejects unsupported temperature ${value}`, () => {
    const result = listWithTemperature(value);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /temperature/i);
  });
}

for (const flag of ['--label', '--task', '--model', '--base-url', '--temperature']) {
  test(`${flag} cannot consume the next option as its value`, () => {
    const result = spawnSync(process.execPath, [runner, flag, '--list', '--help'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires a value/);
  });
}
