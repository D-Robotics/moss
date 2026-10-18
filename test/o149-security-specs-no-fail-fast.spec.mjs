#!/usr/bin/env node
/**
 * O149 (P2): a red portability spec early in the alphabet (e.g.
 * `exec-git-config` on Windows) made the local fail-fast runner exit before
 * the security specs (`o13*`, `aa-o13*`, `protected`, `hooks`, …) ran, so a
 * Windows run showed no security evidence at all. Under CI the runner already
 * runs every file (46850877); locally it now keeps fail-fast for ordinary
 * files but still runs every security spec after the first failure.
 */
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

const OK = "import test from 'node:test'; test('ok', () => {});\n";
const BAD =
  "import test from 'node:test'; import assert from 'node:assert'; test('bad', () => assert.fail('boom'));\n";

const SECURITY = [
  'aa-o130-win-config-protect.spec.mjs',
  'hooks-fail-closed.spec.mjs',
  'o135-pretooluse-nonzero-allow.spec.mjs',
  'o94-protected-paths.spec.mjs',
  'o121-safety-block-outcome.spec.mjs',
  'cli-security.spec.mjs',
];

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o149-'));
  fs.mkdirSync(path.join(dir, 'test'));
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(dir, 'test', name), body);
  return dir;
}

function run(dir, ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  return spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
}

const started = (stderr, name) =>
  new RegExp(`\\[test\\] .*${name.replace(/[.]/g, '\\.')}\\s*$`, 'm').test(stderr);

// `a-…` sorts before every security spec, like `exec-git-config` before `o13*`.
const FILES = {
  'a-portability-red.spec.mjs': BAD,
  'b-ordinary.spec.mjs': OK,
  ...Object.fromEntries(SECURITY.map((name) => [name, OK])),
  'z-ordinary.spec.mjs': OK,
};

for (const ci of [undefined, 'false', '0']) {
  test(`local (CI=${ci ?? 'unset'}): an early red file does not skip the security specs`, () => {
    const dir = fixture(FILES);
    try {
      const r = run(dir, ci);
      assert.notEqual(r.status, 0, 'the red file still fails the run');
      for (const name of SECURITY) assert.ok(started(r.stderr, name), `${name} ran\n${r.stderr}`);
      // Ordinary files keep the local fail-fast behaviour.
      assert.ok(!started(r.stderr, 'b-ordinary.spec.mjs'), r.stderr);
      assert.ok(!started(r.stderr, 'z-ordinary.spec.mjs'), r.stderr);
      assert.match(r.stderr, /1 of \d+ file\(s\) failed:/);
      assert.match(r.stderr, /a-portability-red\.spec\.mjs \(exit/);
      assert.match(
        r.stderr,
        /security spec\(s\) still ran after the first failure: 6 passed, 0 failed/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('local: a red security spec after the first failure is reported too', () => {
  const dir = fixture({ ...FILES, 'hooks-fail-closed.spec.mjs': BAD });
  try {
    const r = run(dir, undefined);
    assert.notEqual(r.status, 0);
    for (const name of SECURITY) assert.ok(started(r.stderr, name), `${name} ran\n${r.stderr}`);
    assert.match(r.stderr, /2 of \d+ file\(s\) failed:/);
    assert.match(r.stderr, /hooks-fail-closed\.spec\.mjs \(exit/);
    assert.match(
      r.stderr,
      /security spec\(s\) still ran after the first failure: 5 passed, 1 failed/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local: an all-green run is unchanged', () => {
  const { 'a-portability-red.spec.mjs': _red, ...green } = FILES;
  const dir = fixture(green);
  try {
    const r = run(dir, undefined);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[test\] passed 8 file\(s\)/);
    assert.doesNotMatch(r.stderr, /still ran after the first failure/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI: every file still runs (unchanged)', () => {
  const dir = fixture(FILES);
  try {
    const r = run(dir, 'true');
    assert.notEqual(r.status, 0);
    for (const name of [...SECURITY, 'b-ordinary.spec.mjs', 'z-ordinary.spec.mjs'])
      assert.ok(started(r.stderr, name), `${name} ran\n${r.stderr}`);
    assert.match(r.stderr, /1 of 9 file\(s\) failed:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
