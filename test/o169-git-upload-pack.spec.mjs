#!/usr/bin/env node
/**
 * O169: a literal `git --upload-pack=<cmd>` / `--receive-pack=<cmd>` (and
 * clone's short `-u`) makes git run that command to speak the pack protocol —
 * `git clone --upload-pack='touch /tmp/pwn' url` is arbitrary execution that
 * looked like a plain clone. Before the fix findExecCapableForms saw no form,
 * so the exec-capable gate never fired: the probe ran and the run exited 0.
 * The flags now land in the same pre-exec block as the other git exec options
 * (O152), in the subcommand position and the global one, glued or split.
 * `git push -u origin main` (--set-upstream) stays green: only clone's `-u`
 * is --upload-pack.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { o152Scenario } from './o152-harness.mjs';
import {
  findExecCapableForms,
  commandHasExecCapableRead,
} from '../dist/safety/exec-capable-read.js';
import { findShellProtectedWrites } from '../dist/safety/protected-paths.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o169-')));
const ctx = {
  cwd: base,
  workspaceRoot: base,
  configDirs: [],
  env: process.env,
  home: path.join(base, 'home'),
};
fs.mkdirSync(ctx.home, { recursive: true });

function assertExecCapable(cmd) {
  assert.equal(commandHasExecCapableRead(cmd), true, cmd);
  assert.ok(findExecCapableForms(cmd).length > 0, cmd);
  const hits = findShellProtectedWrites(cmd, ctx).filter((h) => h.kind === 'exec-capable');
  assert.ok(hits.length > 0, `exec-capable hit; ${cmd}`);
}

function assertNotExecCapable(cmd) {
  assert.equal(commandHasExecCapableRead(cmd), false, cmd);
  const hits = findShellProtectedWrites(cmd, ctx).filter((h) => h.kind === 'exec-capable');
  assert.equal(hits.length, 0, cmd);
}

// ── policy: the flags are exec-capable forms ────────────────────────────────

const RED = [
  'git clone --upload-pack=touch /tmp/pwn file:///tmp/x /tmp/y',
  'git clone --upload-pack="touch /tmp/pwn" file:///tmp/x /tmp/y',
  'git fetch --upload-pack=touch origin',
  'git push --receive-pack=touch origin main',
  'git ls-remote --upload-pack=touch origin',
  'git clone --upload-pack touch file:///tmp/x',
  'git fetch --upload-pack touch origin',
  'git push --receive-pack touch origin main',
  'git --upload-pack=touch fetch origin',
  'git --receive-pack=touch push origin main',
  'git push --exec=touch origin main',
  // clone's short option for --upload-pack
  'git clone -u touch file:///tmp/x',
  'git clone -utouch file:///tmp/x',
];

for (const cmd of RED) test(`policy RED: ${cmd}`, () => assertExecCapable(cmd));

const GREEN = [
  'git clone file:///tmp/x /tmp/y',
  'git clone --depth 1 file:///tmp/x',
  'git clone --bare file:///tmp/x',
  'git fetch origin',
  'git fetch --all --prune',
  'git push origin main',
  'git push -u origin main',
  'git push --force-with-lease origin main',
  'git ls-remote origin',
  'git -c user.email=a@b commit -m x',
  'git status',
  'git log --oneline -5',
];

for (const cmd of GREEN) test(`policy GREEN: ${cmd}`, () => assertNotExecCapable(cmd));

// ── process: the probe inside --upload-pack never runs ─────────────────────

const MARKER = 'o169-marker.touched';

function probeScript(dir) {
  const script = path.join(dir, 'o169-probe.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho touched > "$(dirname "$0")/${MARKER}"\n`, {
    mode: 0o755,
  });
  return script;
}

async function blockedProcessCase(build) {
  return o152Scenario({
    lang: 'en',
    gitInit: false,
    steps: build,
    finalText: 'All done, everything is finished.',
    inspect: (c) => ({ marker: fs.existsSync(path.join(c.root, MARKER)) }),
  });
}

test('process BLOCK: git clone --upload-pack=<probe> never runs it (exit 9)', async () => {
  const r = await blockedProcessCase((c) => [
    {
      name: 'exec',
      args: {
        command: `git clone --upload-pack=${probeScript(c.root)} file:///nonexistent.git; node -e 1`,
      },
    },
  ]);
  const detail = `code=${r.code} last=${r.last}\n${(r.err ?? '').slice(-500)}`;
  assert.equal(r.extra.marker, false, 'the probe must not run');
  assert.equal(r.code, 9, detail);
  assert.match(r.last, /被拦|Blocked by: /, detail);
});

test('process BLOCK: git push --receive-pack=<probe> never runs it (exit 9)', async () => {
  const r = await blockedProcessCase((c) => [
    {
      name: 'exec',
      args: { command: `git push --receive-pack=${probeScript(c.root)} origin main; node -e 1` },
    },
  ]);
  const detail = `code=${r.code} last=${r.last}\n${(r.err ?? '').slice(-500)}`;
  assert.equal(r.extra.marker, false, 'the probe must not run');
  assert.equal(r.code, 9, detail);
  assert.match(r.last, /被拦|Blocked by: /, detail);
});

test('process BLOCK: git clone -u <probe> (short form) never runs it (exit 9)', async () => {
  const r = await blockedProcessCase((c) => [
    {
      name: 'exec',
      args: { command: `git clone -u ${probeScript(c.root)} file:///nonexistent.git; node -e 1` },
    },
  ]);
  assert.equal(r.extra.marker, false, 'the probe must not run');
  assert.equal(r.code, 9, `code=${r.code} last=${r.last}`);
});

test('process GREEN: plain git status still runs', async () => {
  const r = await o152Scenario({
    lang: 'en',
    steps: () => [{ name: 'exec', args: { command: 'git status; node -e 1' } }],
    finalText: 'All done, everything is finished.',
  });
  assert.notEqual(r.code, 9, `git status must not be blocked; ${r.last}`);
});
