#!/usr/bin/env node
/**
 * O168: the write-target rules must not block normal commands. On main
 * (O101/O151), an uncertain command (any interpreter run) put every absolute
 * mention through the delete-ancestor rule, so `python3 x.py $HOME`,
 * `node x.js "$PWD"`, `. venv/bin/activate && python -V` and `python3 x.py
 * /tmp` were reported as deleting home / the workspace root — and a NON-git
 * directory's $PWD was labeled "git repository internals". A script's
 * arguments are mentions, not deletions: the ancestor rule now skips them.
 * Directly protected arguments (`$HOME/.ssh`, `.git/config`), the interpreter
 * inline forms, and real deletes (`rm -rf $HOME`, `mv $HOME /tmp`) are
 * unchanged — actual writes stay covered by the script scan (layer 2) and the
 * post-run snapshot (layer 3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { o152Scenario, IS_WIN } from './o152-harness.mjs';
import { findShellProtectedWrites } from '../dist/safety/protected-paths.js';

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o168-')));
// Home lives OUTSIDE the workspace, like a real one (an inside-workspace
// home makes the home anchor swallow the workspace-root anchor).
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o168home-')));
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(WS, 'x.py'), 'import sys\nprint(sys.argv)\n');
fs.writeFileSync(path.join(WS, 'x.js'), 'console.log(process.argv)\n');
fs.writeFileSync(path.join(WS, 'x.sh'), 'echo "$@"\n');
fs.mkdirSync(path.join(WS, 'venv', 'bin'), { recursive: true });
fs.writeFileSync(path.join(WS, 'venv', 'bin', 'activate'), 'export VIRTUAL_ENV=x\n');
const ctx = {
  cwd: WS,
  workspaceRoot: WS,
  configDirs: [],
  env: process.env,
  home: HOME,
};

const hitsOf = (cmd) => findShellProtectedWrites(cmd, ctx).map((h) => `${h.raw}:${h.category}`);

// ── policy: normal commands are no longer hits ──────────────────────────────

const GREEN = [
  'python3 x.py $HOME',
  'python3 -u x.py $HOME',
  'python3 x.py /tmp',
  'node x.js "$PWD"',
  'node x.js $HOME',
  'sh x.sh $HOME',
  'bash x.sh "$PWD"',
  '. venv/bin/activate && python -V',
  'source venv/bin/activate && python -V',
  '. ./venv/bin/activate && python3 -V',
];

for (const cmd of GREEN) {
  test(`policy GREEN: ${cmd}`, () => {
    assert.deepEqual(hitsOf(cmd), [], cmd);
  });
}

// ── policy: protection unchanged where it matters ──────────────────────────

const RED = [
  ['python3 x.py $HOME/.ssh', 'ssh'],
  ['python3 x.py .git/config', 'git'],
  ['node x.js ~/.ssh/authorized_keys', 'ssh'],
  ['rm -rf $HOME', 'ssh'],
  ['mv $HOME /tmp', 'ssh'],
  ['rm -rf .git', 'git'],
  ['rm -rf "$PWD"', 'git'],
];

for (const [cmd, category] of RED) {
  test(`policy RED: ${cmd} still hits (${category})`, () => {
    const hits = hitsOf(cmd);
    assert.ok(hits.length > 0, cmd);
    assert.ok(
      hits.some((h) => h.endsWith(`:${category}`)),
      `${cmd} -> ${JSON.stringify(hits)}`
    );
  });
}

test('policy RED: interpreter inline form keeps the old behavior', () => {
  // No script file: the argument is not a script argument, so the ancestor
  // rule still applies (stricter only).
  const hits = hitsOf('python3 -c "print(1)" $HOME');
  assert.ok(hits.length > 0, JSON.stringify(hits));
});

// ── process: the four commands run (exit 0) ────────────────────────────────

const FINAL = 'All done, everything is finished.';

async function runsClean(command) {
  return o152Scenario({
    lang: 'en',
    gitInit: false,
    seed: {
      'x.py': 'import sys\nprint(sys.argv)\n',
      'x.js': 'console.log(process.argv)\n',
      'x.sh': 'echo "$@"\n',
      'venv/bin/activate': 'export VIRTUAL_ENV=x\n',
    },
    steps: () => [{ name: 'exec', args: { command } }],
    finalText: FINAL,
  });
}

const E2E_GREEN = [
  'python3 x.py $HOME && node -e 1',
  'node x.js "$PWD" && node -e 1',
  '. venv/bin/activate && python -V && node -e 1',
];

for (const command of E2E_GREEN) {
  test(
    `process GREEN: ${command} → exit 0`,
    { skip: IS_WIN ? 'sh-form e2e; policy covered above' : false },
    async () => {
      const r = await runsClean(command);
      assert.equal(r.code, 0, `code=${r.code} last=${r.last}\n${(r.err ?? '').slice(-400)}`);
    }
  );
}

test(
  'process RED control: python3 x.py $HOME/.ssh still blocks (exit 9)',
  { skip: IS_WIN ? 'sh-form e2e; policy covered above' : false },
  async () => {
    const r = await runsClean('python3 x.py $HOME/.ssh; node -e 1');
    assert.equal(r.code, 9, `code=${r.code} last=${r.last}`);
  }
);
