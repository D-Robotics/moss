import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execBackgroundTool, execInputTool, execLogsTool } from '../dist/tools/background-exec.js';
import {
  clearBackgroundRegistryForTests,
  getBackgroundProcessSnapshot,
} from '../dist/core/tools/background-process-registry.js';

const REPL = [
  "let buf = '';",
  "process.stdin.on('data', (chunk) => {",
  '  buf += chunk.toString();',
  "  const parts = buf.split('\\n');",
  '  buf = parts.pop();',
  '  for (const line of parts) console.log(`got:${line}`);',
  '});',
  "process.stdin.on('end', () => console.log('stdin closed'));",
  '',
].join('\n');

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'exec-input', abortSignal: new AbortController().signal };
}

async function waitForExit(id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = getBackgroundProcessSnapshot(id);
    if (snap && snap.status !== 'running') return snap;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

test('exec_input drives a running process stdin and closes it', async (t) => {
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-input-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'repl.mjs');
  await fs.writeFile(script, REPL);

  const started = await execBackgroundTool.execute(
    { command: `"${process.execPath}" "${script}"`, settle_ms: 300 },
    ctx(dir)
  );
  const id = started.match(/bg_\d+/)?.[0];
  assert.ok(id, `background command started: ${started}`);

  const first = await execInputTool.execute({ id, text: 'alpha' }, ctx(dir));
  assert.match(first, /Wrote 6 byte\(s\) to bg_\d+ stdin/);
  assert.match(first, /exec_logs/);

  const second = await execInputTool.execute({ id, text: 'beta', eof: true }, ctx(dir));
  assert.match(second, /closed stdin/);

  const snap = await waitForExit(id);
  assert.ok(snap, 'process exited after stdin closed');
  assert.equal(snap.exitCode, 0);

  const logs = await execLogsTool.execute({ id, tail: 100 }, ctx(dir));
  assert.match(logs, /got:alpha/);
  assert.match(logs, /got:beta/);
  assert.match(logs, /stdin closed/);
});

test('exec_input reports unknown ids and already-closed stdin', async (t) => {
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-input-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const missing = await execInputTool.execute({ id: 'bg_404', text: 'x' }, ctx(dir));
  assert.match(missing, /no background process with id "bg_404"/);

  const started = await execBackgroundTool.execute(
    {
      command: `"${process.execPath}" -e "process.stdin.on('end', () => {}); process.stdin.resume()"`,
      settle_ms: 300,
    },
    ctx(dir)
  );
  const id = started.match(/bg_\d+/)?.[0];
  assert.ok(id, started);
  const empty = await execInputTool.execute({ id, text: '' }, ctx(dir));
  assert.match(empty, /pass text to write, or eof: true/);
  const closed = await execInputTool.execute({ id, eof: true }, ctx(dir));
  assert.match(closed, /Closed stdin on bg_\d+\./);
  const snap = await waitForExit(id);
  assert.ok(snap, 'process exited');
  const after = await execInputTool.execute({ id, text: 'late' }, ctx(dir));
  assert.match(after, /is already (exited|killed|error); its stdin is closed/);
});
