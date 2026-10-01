#!/usr/bin/env node
/**
 * TUI Esc-interrupt case, run as an isolated process: sequential
 * ink-testing-library instances in one process leak state, so this case
 * boots its own. Exits 0 when the interrupt contract holds.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTuiStore } from '../../dist/cli/tui/render-bridge.js';
import { TuiAppRoot } from '../../dist/cli/tui/app.js';
import { TaskRuntime } from '../../dist/core/task-runtime/runtime.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

const calls = [];
function mockAgent() {
  return {
    async *streamChat(sessionKey, message, opts) {
      calls.push({ message, abortedAtEnd: false });
      for (let i = 0; i < 10; i++) {
        if (opts?.abortSignal?.aborted) {
          calls[0].abortedAtEnd = true;
          return;
        }
        yield { type: 'text_delta', delta: `echo chunk ${i} ` };
        await sleep(60);
      }
      yield { type: 'done', result: { response: 'all done', stopReason: 'end_turn' } };
    },
  };
}

function makeHandle() {
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
const handle = makeHandle();
const runtime = new TaskRuntime({
  workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-esc-')),
});
const instance = render(
  React.createElement(TuiAppRoot, {
    options: { agent: mockAgent(), workspaceDir: '/tmp/ws' },
    handle,
    runtime,
  })
);

for (const ch of 'long running request') {
  instance.stdin.write(ch);
  await sleep(15);
}
instance.stdin.write('\r');

const streaming = await waitFor(() => instance.lastFrame().includes('echo chunk'));
if (!streaming) {
  console.error('FAIL: no streaming output before interrupt');
  process.exit(1);
}
instance.stdin.write('\x1b');
// The v0.22 shell commits the halt as a `⎿ done in Ns · interrupted` result row.
const halted = await waitFor(() => instance.lastFrame().includes('interrupted'));
const abortedFlag = await waitFor(() => calls[0]?.abortedAtEnd === true);
instance.unmount();

if (!halted) {
  console.error('FAIL: halt marker not visible');
  process.exit(1);
}
if (!abortedFlag) {
  console.error('FAIL: agent stream not aborted');
  process.exit(1);
}
if (handle.store.run.running) {
  console.error('FAIL: store still running after halt');
  process.exit(1);
}
console.log('TUI-ESC-OK halted=true agentAborted=true');
process.exit(0);
