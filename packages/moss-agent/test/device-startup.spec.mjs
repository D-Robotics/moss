import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('configured device host remains disconnected until /connect', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(packageDir, 'dist', 'cli.js'), '--mock', '--print', 'hello'],
    {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        MOSS_DEVICE_HOST: '192.0.2.1',
        MOSS_DEVICE_USER: 'root',
        MOSS_DEVICE_NO_VERIFY: '1',
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, /\[device\]/i);
  assert.doesNotMatch(output, /BOARD MODE/i);
});
