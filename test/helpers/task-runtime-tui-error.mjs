import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import React from 'react';
import { render } from 'ink-testing-library';
import { TaskRuntime } from '../../dist/index.js';
import { TuiAppRoot } from '../../dist/cli/tui/app.js';
import { createTuiStore } from '../../dist/cli/tui/render-bridge.js';

const [workspace, mode] = process.argv.slice(2);
const recovery = path.join(workspace, '.moss', 'task-events.jsonl.lock.recovery');
const originalRead = fs.readFile;
let armed = mode === 'boot';
let failedReads = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 3500) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`TUI ${mode} did not expose the actual storage error`);
}
fs.readFile = async function (file, ...args) {
  const bytes = await originalRead.call(this, file, ...args);
  if (armed && String(file) === recovery) {
    assert.equal(JSON.parse(String(bytes)).pid, process.pid);
    failedReads++;
    throw Object.assign(new Error('TUI real recovery owner read EIO'), { code: 'EIO' });
  }
  return bytes;
};
syncBuiltinESMExports();
const listeners = new Set();
const handle = {
  store: createTuiStore(),
  notify: () => {
    for (const listener of listeners) listener();
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
const runtime = new TaskRuntime({ workspaceDir: workspace });
const agent = {
  async *streamChat() {
    yield { type: 'text_delta', delta: 'normal chat completed' };
    yield { type: 'done', result: { response: 'normal chat completed', stopReason: 'end_turn' } };
  },
  asyncTasks: { list: () => [] },
  config: { model: 'spec-model', contextTokens: 100_000 },
  tools: { getAll: () => [], getNames: () => [], size: 0 },
};
const instance = render(
  React.createElement(TuiAppRoot, {
    options: { agent, workspaceDir: workspace, model: 'spec-model', listSessions: async () => [] },
    handle,
    runtime,
  })
);
try {
  if (mode === 'chat') {
    await waitFor(
      () => runtime.version > 0 && handle.store.rows.some((row) => row.kind === 'banner')
    );
    armed = true;
    instance.stdin.write('h');
    await sleep(12);
    instance.stdin.write('i');
    await sleep(12);
    instance.stdin.write('\r');
  }
  await waitFor(() =>
    handle.store.rows.some((row) => row.kind === 'error' && /owner/.test(row.text))
  );
  await sleep(20); // Keep Node's actual unhandled rejection policy enabled.
  assert.equal(failedReads, 2, 'actual JSON and legacy owner reads both fail');
  assert.match(runtime.getLiveState().lastError.message, /owner/);
  assert.equal(handle.store.run.running, false);
  assert.equal(
    handle.store.rows.some((row) => row.kind === 'summary' && /\bPASS\b/.test(row.text)),
    false
  );
  const owner = JSON.parse(await originalRead(recovery, 'utf8'));
  assert.equal(owner.pid, process.pid, 'unknown owner remains fail-closed');
  process.stdout.write(
    `${JSON.stringify({ mode, failedReads, errorVisible: true, ownerRetained: true })}\n`
  );
} finally {
  instance.unmount();
  fs.readFile = originalRead;
  syncBuiltinESMExports();
}
