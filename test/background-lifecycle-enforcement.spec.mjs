import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execBackgroundTool, execStopTool } from '../dist/tools/background-exec.js';
import { execTool } from '../dist/tools/builtin.js';
import {
  backgroundProcesses,
  clearBackgroundRegistryForTests,
} from '../dist/core/tools/background-process-registry.js';

test.afterEach(() => clearBackgroundRegistryForTests());

const ctx = {
  abortSignal: new AbortController().signal,
  sessionKey: 'background-lifecycle',
};

test('foreground exec cannot launch an untracked shell background job', async () => {
  const result = await execTool.execute(
    {
      command: process.platform === 'win32' ? 'start /b node server.mjs' : 'node server.mjs &',
      timeout_ms: 1000,
    },
    ctx
  );
  assert.match(String(result), /run_in_background|exec_background/i);
  assert.match(String(result), /track|tracked/i);
  assert.equal(backgroundProcesses.size, 0, 'no untracked shell child was spawned');
});

test('exec_stop confirms the process is gone before returning', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-stop-confirm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'server.cjs');
  await fs.writeFile(script, 'console.log("ready"); setInterval(() => {}, 1000);\n');
  const quote = process.platform === 'win32' ? `"${script}"` : `'${script}'`;
  const started = await execBackgroundTool.execute(
    { command: `${process.execPath} ${quote}`, settle_ms: 0 },
    { ...ctx, workspaceDir: root }
  );
  const id = started.match(/bg_\d+/)?.[0];
  assert.ok(id, started);
  const proc = backgroundProcesses.get(id);
  assert.ok(proc?.child.pid, 'fixture process started');

  const stopped = await execStopTool.execute({ id }, ctx);
  assert.match(String(stopped), /confirmed|stopped/i);
  assert.notEqual(proc.status, 'running');
  if (process.platform !== 'win32') {
    let alive = true;
    try {
      process.kill(proc.child.pid, 0);
    } catch (err) {
      alive = err.code !== 'ESRCH';
    }
    assert.equal(alive, false, 'pid is gone when exec_stop returns');
  }
  clearBackgroundRegistryForTests();
});
