#!/usr/bin/env node
/**
 * Task OS projection into the shell (A1+A2):
 *   · A1 — every engine phase transition lands in the transcript as a `◇ task`
 *     row, not only the rotating status line, so a minute-long device task
 *     stays reviewable.
 *   · A2 — the transcript's last word after a task run is the acceptance
 *     verdict (PASS/FAIL + criteria, FAIL names /task resume), never the
 *     model's prose.
 *
 * Driven through the real engine: `/task run <goal> --accept true` with a mock
 * agent whose turns just return; the command verdict provider supplies the
 * exit-code authority.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTuiStore } from '../dist/cli/tui/render-bridge.js';
import { TuiAppRoot } from '../dist/cli/tui/app.js';
import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 8000, stepMs = 40) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const agent = {
  async *streamChat(_sessionKey, message) {
    yield { type: 'text_delta', delta: `ok: ${message.slice(0, 12)}` };
    yield {
      type: 'done',
      result: { response: `ok: ${message.slice(0, 12)}`, stopReason: 'end_turn' },
    };
  },
  asyncTasks: { list: () => [] },
  config: { model: 'spec-model', contextTokens: 100_000 },
  tools: { getAll: () => [], getNames: () => [], size: 0 },
};

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-projection-'));
const handle = liveHandle();
const runtime = new TaskRuntime({ workspaceDir: workspace });
const instance = renderInk(
  React.createElement(TuiAppRoot, {
    options: {
      agent,
      workspaceDir: workspace,
      model: 'spec-model',
      version: '0.0.0-spec',
      listSessions: async () => [],
      mcpServers: [],
      listCheckpoints: () => [],
    },
    handle,
    runtime,
  })
);

const type = async (text) => {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(8);
  }
  instance.stdin.write('\r');
  await sleep(30);
};

assert.ok(await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner')), 'shell booted');

await type('/task run keep the board alive --accept true');

// A1: phase transitions are transcript rows, not just the status line.
const phaseRows = () => handle.store.rows.filter((r) => r.text.startsWith('◇ task '));
assert.ok(
  await waitFor(() => phaseRows().some((r) => r.text.includes('task planning'))),
  `planning phase lands in the transcript: ${JSON.stringify(phaseRows().map((r) => r.text))}`
);
assert.ok(
  await waitFor(() => phaseRows().some((r) => r.text.includes('task verifying'))),
  'verifying phase lands in the transcript'
);

// A2: the last task word is the verdict, with criteria and short id.
const verdictRow = () =>
  handle.store.rows.find((r) => /^◇ task \w+ — PASS \(\d+\/\d+ criteria met\)$/.test(r.text));
assert.ok(
  await waitFor(() => verdictRow() !== undefined),
  `the acceptance verdict is the transcript's last task word: ${JSON.stringify(
    handle.store.rows.slice(-6).map((r) => r.text)
  )}`
);

// FAIL path: an unsatisfiable command verdict names the recovery entry.
const failWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-projection-fail-'));
const failHandle = liveHandle();
const failRuntime = new TaskRuntime({ workspaceDir: failWorkspace });
const failInstance = renderInk(
  React.createElement(TuiAppRoot, {
    options: {
      agent,
      workspaceDir: failWorkspace,
      model: 'spec-model',
      version: '0.0.0-spec',
      listSessions: async () => [],
      mcpServers: [],
      listCheckpoints: () => [],
    },
    handle: failHandle,
    runtime: failRuntime,
  })
);
assert.ok(
  await waitFor(() => failHandle.store.rows.some((r) => r.kind === 'banner')),
  'fail-case shell booted'
);
const typeFail = async (text) => {
  for (const ch of text) {
    failInstance.stdin.write(ch);
    await sleep(8);
  }
  failInstance.stdin.write('\r');
  await sleep(30);
};
await typeFail('/task run unsatisfiable goal --accept false');
const failRow = () => failHandle.store.rows.find((r) => /^◇ task \w+ — FAIL /.test(r.text));
assert.ok(await waitFor(() => failRow() !== undefined), 'a FAIL verdict lands in the transcript');
assert.match(failRow().text, /\/task resume task_\w+ to repair/, 'FAIL names the recovery command');

instance.unmount();
failInstance.unmount();
await sleep(150);
console.log('[PASS] TUI task projection (phases + verdict last word)');

// A5: a blocked task stays pinned in the chrome with the reason + recovery.
{
  const { createDraftTask, appendTaskEvent } = await import('../dist/core/task/task-store.js');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-blocked-'));
  const contract = await createDraftTask(ws, 'stream camera at 30 fps');
  await appendTaskEvent(ws, contract.taskId, 'execution_started');
  await appendTaskEvent(ws, contract.taskId, 'blocked_on_user', {
    reason: 'device credentials missing',
  });

  const bHandle = liveHandle();
  const bRuntime = new TaskRuntime({ workspaceDir: ws });
  const bInstance = renderInk(
    React.createElement(TuiAppRoot, {
      options: {
        agent,
        workspaceDir: ws,
        model: 'spec-model',
        version: '0.0.0-spec',
        listSessions: async () => [],
        mcpServers: [],
        listCheckpoints: () => [],
      },
      handle: bHandle,
      runtime: bRuntime,
    })
  );
  assert.ok(
    await waitFor(() => bInstance.lastFrame().includes('blocked — device credentials missing')),
    `the blocked reason is pinned in the chrome: ${JSON.stringify(
      bInstance.lastFrame().slice(0, 400)
    )}`
  );
  assert.match(
    bInstance.lastFrame(),
    new RegExp(`/task resume ${contract.taskId}`),
    'the pinned line names the recovery command'
  );
  bInstance.unmount();
  await sleep(150);
}
