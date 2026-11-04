/**
 * exec_logs wait_for — block until a background command prints a matching line
 * (Qoder `Monitor` / `BashOutput` parity) instead of polling with the model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execBackgroundTool, execLogsTool, execStopTool } from '../dist/tools/background-exec.js';
import {
  clearBackgroundRegistryForTests,
  getBackgroundProcessSnapshot,
} from '../dist/core/tools/background-process-registry.js';

/** Boots, prints a readiness line after a delay, then stays alive. */
const SERVER = [
  "console.log('booting');",
  "setTimeout(() => console.log('ready on 8080'), 350);",
  'process.stdin.resume();',
  '',
].join('\n');

/** Prints once and exits, so the wait can end without a match. */
const CRASHER = ["console.log('bye');", 'process.exit(3);', ''].join('\n');

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'exec-logs-wait', abortSignal: new AbortController().signal };
}

async function start(t, dir, body) {
  const script = path.join(dir, `${Math.random().toString(36).slice(2)}.mjs`);
  await fs.writeFile(script, body);
  const started = await execBackgroundTool.execute(
    { command: `"${process.execPath}" "${script}"`, settle_ms: 200 },
    ctx(dir)
  );
  const id = started.match(/bg_\d+/)?.[0];
  assert.ok(id, `background command started: ${started}`);
  t.after(() => execStopTool.execute({ id }, ctx(dir)));
  return id;
}

test('wait_for resolves when the line appears, then immediately once buffered', async (t) => {
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-logs-wait-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = await start(t, dir, SERVER);

  const at = Date.now();
  const waited = await execLogsTool.execute({ id, wait_for: 'ready on \\d+', tail: 20 }, ctx(dir));
  const elapsed = Date.now() - at;
  assert.match(waited, new RegExp(`${id}: `), 'header describes the process');
  assert.match(waited, /wait_for \/ready on \\d\+\/ matched after [\d.]+m?s/);
  assert.match(waited, /matched after [\d.]+m?s: ready on 8080/);
  assert.ok(elapsed >= 200, `waited for the print, took ${elapsed}ms`);
  assert.match(waited, /--- last 20 line\(s\) ---/);

  const againAt = Date.now();
  const buffered = await execLogsTool.execute({ id, wait_for: 'ready on', tail: 5 }, ctx(dir));
  assert.match(buffered, /matched after [\d.]+m?s/);
  assert.ok(Date.now() - againAt < 200, 'an existing match returns without waiting');
});

test('wait_for reports a timeout while the process stays up', async (t) => {
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-logs-wait-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = await start(t, dir, SERVER);

  const at = Date.now();
  const timedOut = await execLogsTool.execute(
    { id, wait_for: 'never-appears', timeout_ms: 150 },
    ctx(dir)
  );
  assert.match(timedOut, /wait_for \/never-appears\/ not matched after 1[\d.]+m?s; still running/);
  assert.ok(Date.now() - at >= 140, 'the wait honored timeout_ms');
  assert.match(timedOut, /booting/, 'the tail still shows what the process printed');
});

test('wait_for ends early when the process exits first', async (t) => {
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-logs-wait-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = await start(t, dir, CRASHER);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && getBackgroundProcessSnapshot(id)?.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const afterExit = await execLogsTool.execute({ id, wait_for: 'ready' }, ctx(dir));
  assert.match(afterExit, /exited before matching wait_for \/ready\//);
  assert.match(afterExit, /exit: 3/);
});
