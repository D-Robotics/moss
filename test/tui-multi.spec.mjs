#!/usr/bin/env node
/**
 * CLI shell multi-task plane: /sessions, /mcp, /subs, /rewind — all driven
 * through host-provided providers and printed into the transcript (the v0.22
 * shell has no overlays, so the answer is the output).
 */
import assert from 'node:assert/strict';

import { createTuiStore } from '../dist/cli/tui/render-bridge.js';
import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';
import { TuiAppRoot } from '../dist/cli/tui/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

async function type(instance, text) {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(15);
  }
  instance.stdin.write('\r');
  await sleep(20);
}

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

const streamCalls = [];
function mockAgent() {
  return {
    asyncTasks: {
      list: () => [
        { taskId: 'task-abc123', status: 'completed' },
        { taskId: 'task-def456', status: 'running' },
      ],
    },
    async *streamChat(sessionKey, message) {
      streamCalls.push(message);
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
    },
  };
}

const rewinds = [];
const options = {
  agent: mockAgent(),
  workspaceDir: '/tmp/ws',
  sessionKey: 'sess-current',
  listSessions: async () => [
    { key: 'sess-current', messageCount: 5, current: true },
    { key: 'sess-old', title: 'Fix the bug', messageCount: 12 },
  ],
  mcpServers: [
    { name: 'fixture-stdio', state: 'connected', toolCount: 50 },
    { name: 'broken', state: 'failed', error: 'spawn ENOENT' },
  ],
  listCheckpoints: () => [{ seq: 1, label: 'write src/a.ts', files: 1 }],
  rewindTo: (seq) => {
    rewinds.push(seq);
    return { ok: true, detail: '1 file(s) restored' };
  },
};

const handle = liveHandle();
const runtime = new TaskRuntime({ workspaceDir: '/tmp/ws' });
const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
const rowsWith = (needle) => handle.store.rows.filter((r) => r.text.includes(needle));

// /sessions lists both, with the current marker on the active one
await type(instance, '/sessions');
assert.ok(
  await waitFor(() => rowsWith('* sess-current').length > 0),
  'sessions block marks the current session'
);
assert.ok(
  handle.store.rows.some((r) => r.text.includes('sess-old — Fix the bug')),
  'sessions block lists the other session with its title'
);

// /mcp shows connected + failed servers with lazy tool counts
await type(instance, '/mcp');
assert.ok(
  await waitFor(() => rowsWith('● fixture-stdio — connected (50 tools, lazy)').length > 0),
  'mcp block shows the connected server lazily'
);
assert.ok(
  handle.store.rows.some((r) => r.text.includes('○ broken — failed')),
  'mcp block shows the failed server'
);

// /subs lists the async task registry
await type(instance, '/subs');
assert.ok(
  await waitFor(
    () =>
      handle.store.rows.some((r) => r.text.includes('abc123')) &&
      handle.store.rows.some((r) => r.text.includes('def456'))
  ),
  'subs block lists tasks'
);

// /rewind lists checkpoints; /rewind 1 restores through the host provider
await type(instance, '/rewind');
assert.ok(
  await waitFor(() => rowsWith('1. write src/a.ts (1 files)').length > 0),
  'rewind lists checkpoints'
);
await type(instance, '/rewind 1');
assert.ok(
  await waitFor(() => instance.lastFrame().includes('restored checkpoint 1: 1 file(s) restored')),
  `rewind restores through the host provider: ${JSON.stringify(instance.lastFrame().slice(-200))}`
);
assert.deepEqual(rewinds, [1], 'host rewind provider invoked');

instance.unmount();
await sleep(120);
void streamCalls;

console.log('[PASS] TUI multi-task plane (sessions/mcp/subs/rewind)');
