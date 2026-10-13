import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/run-package-tests.mjs'
);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runner-ci-'));
  fs.mkdirSync(path.join(dir, 'test'));
  const ok = "import test from 'node:test'; test('ok', () => {});\n";
  const bad =
    "import test from 'node:test'; import assert from 'node:assert'; test('bad', () => assert.fail('boom'));\n";
  fs.writeFileSync(path.join(dir, 'test', 'a-fail.spec.mjs'), bad);
  fs.writeFileSync(path.join(dir, 'test', 'b-pass.spec.mjs'), ok);
  fs.writeFileSync(path.join(dir, 'test', 'c-fail.spec.mjs'), bad);
  return dir;
}

function run(dir, ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  return spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
}

test('locally the runner stops at the first failing file', () => {
  const dir = fixture();
  try {
    const r = run(dir, undefined);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[test\] .*a-fail\.spec\.mjs/);
    assert.doesNotMatch(r.stderr, /b-pass\.spec\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('under CI the runner runs every file and summarizes failures', () => {
  const dir = fixture();
  try {
    const r = run(dir, 'true');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[test\] .*b-pass\.spec\.mjs/);
    assert.match(r.stderr, /2 of 3 file\(s\) failed:/);
    assert.match(r.stderr, /a-fail\.spec\.mjs \(exit/);
    assert.match(r.stderr, /c-fail\.spec\.mjs \(exit/);
    assert.doesNotMatch(r.stderr, /b-pass\.spec\.mjs \(exit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI=false keeps fail-fast', () => {
  const dir = fixture();
  try {
    const r = run(dir, 'false');
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /b-pass\.spec\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
