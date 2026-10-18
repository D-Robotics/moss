#!/usr/bin/env node
/**
 * O149: an early red spec must never hide the safety specs after it.
 * QA #145 F1: picking "security specs" by file name missed most of them
 * (o151/o152/o153/o158/safe-child-env/exec-git-config/o117/o123/…), and the
 * summary still said "security specs still run". The runner now runs every
 * file, locally and under CI, and names anything that did not run.
 * Fixture = QA's repro (/workspace/qa/o149-pr145/miss-repro.log): an early
 * red `aa-00-planted-red` plus empty specs under real safety spec names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/run-package-tests.mjs'
);

// QA #145 F1 table: real names, both the ones the old name regex matched and
// the ones it missed.
const SAFETY_NAMES = [
  'egress-redact',
  'exec-git-config',
  'hooks-fail-closed',
  'o101-indirect-writes',
  'o103-blocked-outcome',
  'o117-git-config-l3-precise',
  'o123-git-commit-l3',
  'o135-pretooluse-nonzero-allow',
  'o151-workspace-root-cd-not-git-internals',
  'o152-exec-capable-and-l3-restore',
  'o153-win-shell-without-pathext',
  'o158-no-cwd-executable',
  'permission-rules',
  'safe-child-env',
];
const OK = "import test from 'node:test'; test('ok', () => {});\n";
const RED =
  "import test from 'node:test'; import assert from 'node:assert'; test('planted', () => assert.fail('planted'));\n";

function fixture({ redSafety } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o149-'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'aa-00-planted-red.spec.mjs'), RED);
  for (const name of [...SAFETY_NAMES, 'tui-layout', 'zz-ordinary']) {
    fs.writeFileSync(path.join(dir, 'test', `${name}.spec.mjs`), name === redSafety ? RED : OK);
  }
  return dir;
}

function run(dir, ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  return spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
}

const started = (stderr, name) =>
  new RegExp(`^\\[test\\] .*[\\\\/]${name}\\.spec\\.mjs$`, 'm').test(stderr);

for (const ci of [undefined, 'false', '0', 'true']) {
  test(`CI=${ci ?? 'unset'}: an early red spec does not skip any later spec`, () => {
    const dir = fixture();
    try {
      const r = run(dir, ci);
      assert.notEqual(r.status, 0, 'a red spec still fails the run');
      for (const name of [...SAFETY_NAMES, 'tui-layout', 'zz-ordinary']) {
        assert.ok(started(r.stderr, name), `${name} must run after the early red\n${r.stderr}`);
      }
      assert.match(r.stderr, /\[test\] 1 of 17 file\(s\) failed:/);
      assert.match(r.stderr, /aa-00-planted-red\.spec\.mjs \(exit/);
      // No claim the run cannot back up.
      assert.doesNotMatch(r.stderr, /security specs? still r[au]n|fail-fast: skipping/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('local: a red safety spec after the first failure is reported too', () => {
  const dir = fixture({ redSafety: 'o158-no-cwd-executable' });
  try {
    const r = run(dir, undefined);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[test\] 2 of 17 file\(s\) failed:/);
    assert.match(r.stderr, /aa-00-planted-red\.spec\.mjs \(exit/);
    assert.match(r.stderr, /o158-no-cwd-executable\.spec\.mjs \(exit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local: an all-green run is unchanged', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'test', 'aa-00-planted-red.spec.mjs'), OK);
  try {
    const r = run(dir, undefined);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[test\] passed 17 file\(s\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'interrupted run names every spec that did not run',
  { skip: process.platform === 'win32' && 'needs POSIX signals' },
  async () => {
    const dir = fixture();
    const marker = path.join(dir, 'slow-started');
    fs.writeFileSync(
      path.join(dir, 'test', 'm-slow.spec.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, '1'); setTimeout(() => {}, 60000);\n`
    );
    try {
      const env = { ...process.env };
      delete env.CI;
      const child = spawn(process.execPath, [script], { cwd: dir, env });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      for (let i = 0; i < 300 && !fs.existsSync(marker); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(fs.existsSync(marker), `slow spec never started\n${stderr}`);
      child.kill('SIGTERM');
      const code = await new Promise((r) => child.on('close', r));
      assert.notEqual(code, 0);
      assert.match(stderr, /\[test\] interrupted: \d+ file\(s\) did not run to completion:/);
      for (const name of [
        'm-slow',
        'o101-indirect-writes',
        'o158-no-cwd-executable',
        'zz-ordinary',
      ]) {
        assert.match(
          stderr,
          new RegExp(`^  .*[\\\\/]${name}\\.spec\\.mjs$`, 'm'),
          `${name} listed`
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
