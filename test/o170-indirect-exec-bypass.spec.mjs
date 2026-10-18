#!/usr/bin/env node
/**
 * O170: indirect execution bypasses that already existed on main —
 * assignments that make a POSIX shell run code (BASH_ENV, ENV,
 * PROMPT_COMMAND, ZDOTDIR, exported BASH_FUNC_* bodies) and tmux/screen
 * forms that spawn commands outside Moss's process tree. On main none of
 * these tripped the exec-capable gate: `BASH_ENV=<probe> bash -c ':'` ran
 * the probe. The env forms are reported when a POSIX shell head runs on the
 * same line (`ENV=production npm start` is not flagged); the tmux/screen
 * forms only when they carry a command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { o152Scenario, IS_WIN } from './o152-harness.mjs';
import { commandHasExecCapableRead } from '../dist/safety/exec-capable-read.js';
import { findShellProtectedWrites } from '../dist/safety/protected-paths.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o170-')));
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
  const hits = findShellProtectedWrites(cmd, ctx).filter((h) => h.kind === 'exec-capable');
  assert.ok(hits.length > 0, `exec-capable hit; ${cmd}`);
}

function assertNotExecCapable(cmd) {
  assert.equal(commandHasExecCapableRead(cmd), false, cmd);
  const hits = findShellProtectedWrites(cmd, ctx).filter((h) => h.kind === 'exec-capable');
  assert.equal(hits.length, 0, cmd);
}

// ── shell-exec env assignments (shell head on the line) ────────────────────

const ENV_RED = [
  'BASH_ENV=/tmp/e.sh bash -c ":"',
  'BASH_ENV=/tmp/e.sh bash script.sh',
  'export BASH_ENV=/tmp/e.sh; bash -c ":"',
  'export PROMPT_COMMAND="touch /tmp/pwn"; bash -ic ":"',
  'PROMPT_COMMAND=touch bash -i -c ":"',
  'env BASH_ENV=/tmp/e.sh bash -c ":"',
  'ZDOTDIR=/tmp/z zsh -c ":"',
  'export ZDOTDIR=/tmp/z; zsh -c ":"',
  'ENV=/tmp/e.sh dash -c ":"',
  'ENV=/tmp/e.sh sh -c ":"',
  'set BASH_ENV=/tmp/e.sh && bash -c ":"',
  "BASH_FUNC_x%%=() { touch /tmp/pwn; }; bash -c 'x'",
];

for (const cmd of ENV_RED) test(`policy RED: ${cmd}`, () => assertExecCapable(cmd));

const ENV_GREEN = [
  // No shell on the line — the assignment is inert (also avoids the common
  // app-config name collision).
  'ENV=production npm start',
  'ENV=prod node x.js',
  'BASH_ENV=/tmp/e.sh node x.js',
  'export ENV=production; npm test',
  // A shell without any of the vars.
  'bash -c "ls"',
  'bash script.sh',
  'zsh -c "echo hi"',
  'sh -c ":"',
  // Ordinary env stays green.
  'FOO=1 bash -c ":"',
  'PATH=/usr/bin:/bin ls',
];

for (const cmd of ENV_GREEN) test(`policy GREEN: ${cmd}`, () => assertNotExecCapable(cmd));

// ── tmux / screen ──────────────────────────────────────────────────────────

const SPAWN_RED = [
  'tmux new-session -d "touch /tmp/pwn"',
  'tmux new-session -d -s w "evil"',
  'tmux new-window "evil"',
  'tmux split-window "evil"',
  'tmux run-shell "evil"',
  'tmux run-shell -t w "evil"',
  "tmux send-keys -t w 'evil' Enter",
  'screen -dmS w evil',
  'screen -S w -X stuff "evil\\n"',
];

for (const cmd of SPAWN_RED) test(`policy RED: ${cmd}`, () => assertExecCapable(cmd));

const SPAWN_GREEN = [
  'tmux ls',
  'tmux list-sessions',
  'tmux kill-session -t w',
  'tmux attach -t w',
  'screen -ls',
  'screen -d -m', // no command follows
];

for (const cmd of SPAWN_GREEN) test(`policy GREEN: ${cmd}`, () => assertNotExecCapable(cmd));

// ── process: BASH_ENV never runs the probe ────────────────────────────────

const MARKER = 'o170-marker.touched';

test(
  'process BLOCK: BASH_ENV=<probe> bash -c never runs it (exit 9)',
  { skip: IS_WIN ? 'bash-form e2e; policy covered above' : false },
  async () => {
    const r = await o152Scenario({
      lang: 'en',
      gitInit: false,
      steps: (c) => {
        const script = path.join(c.root, 'o170-probe.sh');
        fs.writeFileSync(script, `#!/bin/sh\necho touched > "$(dirname "$0")/${MARKER}"\n`, {
          mode: 0o755,
        });
        return [{ name: 'exec', args: { command: `BASH_ENV=${script} bash -c ':'; node -e 1` } }];
      },
      finalText: 'All done, everything is finished.',
      inspect: (c) => ({ marker: fs.existsSync(path.join(c.root, MARKER)) }),
    });
    const detail = `code=${r.code} last=${r.last}\n${(r.err ?? '').slice(-400)}`;
    assert.equal(r.extra.marker, false, 'the probe must not run');
    assert.equal(r.code, 9, detail);
    assert.match(r.last, /被拦|Blocked by: /, detail);
  }
);

test(
  'process GREEN: plain bash -c still runs (exit 0)',
  { skip: IS_WIN ? 'bash-form e2e; policy covered above' : false },
  async () => {
    const r = await o152Scenario({
      lang: 'en',
      steps: () => [{ name: 'exec', args: { command: `bash -c ':'; node -e 1` } }],
      finalText: 'All done, everything is finished.',
    });
    assert.equal(r.code, 0, `code=${r.code} last=${r.last}`);
  }
);
