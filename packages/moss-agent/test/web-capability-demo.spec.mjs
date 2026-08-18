#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function runCapabilityDemo() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/demo-moss-capabilities.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, MOSS_NO_UPDATE_CHECK: '1', MOSS_NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('documented Web capability demo completes through the authorized mutation path', async () => {
  const result = await runCapabilityDemo();
  assert.equal(
    result.code,
    0,
    `capability demo failed${result.signal ? ` with ${result.signal}` : ''}\n${result.stdout}\n${result.stderr}`
  );
  assert.match(result.stdout, /"ok": true/);
  assert.match(result.stdout, /VERIFIED_SHOWCASE_COMPLETE/);
});
