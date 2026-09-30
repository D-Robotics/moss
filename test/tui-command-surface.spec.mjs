#!/usr/bin/env node
/**
 * TUI command-surface honesty (v0.20): every command advertised in the TUI
 * help line has a working handler — typing it never yields "Unknown command".
 * (/quit exits, so it is verified by its branch in the help line only.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTuiStore } from '../dist/cli/tui/render-bridge.js';
import { TUI_HELP_TEXT, buildTuiHelpText } from '../dist/cli/tui/app.js';
import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';

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
    await sleep(12);
  }
  instance.stdin.write('\r');
  await sleep(30);
}

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');
const { TuiAppRoot } = await import('../dist/cli/tui/app.js');

const streamCalls = [];
const agent = {
  steer() {
    return { delivery: 'steer', id: 's', message: '', createdAt: Date.now() };
  },
  async *streamChat(_sk, message) {
    streamCalls.push(message);
    yield {
      type: 'done',
      result: { response: `ok ${message.slice(0, 6)}`, stopReason: 'end_turn' },
    };
  },
};
const options = {
  agent,
  workspaceDir: '/tmp/ws',
  listSessions: async () => [],
  mcpServers: [],
  listCheckpoints: () => [],
};

// Extract "/cmd" tokens from the help line (skip /quit which exits).
const helpLine = buildTuiHelpText().split('\n')[2];
const advertised = [...helpLine.matchAll(/\/([a-z]+)/g)].map((m) => `/${m[1]}`);
assert.ok(advertised.length >= 8, `help advertises >=8 commands (got ${advertised.length})`);
void TUI_HELP_TEXT;

const BOOT_BANNER = 'moss Mission Control — /help for keys';

for (const command of advertised) {
  if (command === '/quit') continue; // exits the app — verified by name only
  const arg = command === '/steer' ? ' be terse' : '';
  const handle = liveHandle();
  const runtime = new TaskRuntime({
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-')),
  });
  const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
  await sleep(120);
  await type(instance, `${command}${arg}`);
  const handled = await waitFor(() =>
    handle.store.rows.some(
      (r) => r.kind === 'banner' && r.text !== BOOT_BANNER && !r.text.startsWith('Resumed')
    )
  );
  const unknown = handle.store.rows.some((r) => r.text.includes('Unknown command'));
  assert.ok(handled, `${command} produced a response`);
  assert.ok(!unknown, `${command} must not be answered "Unknown command"`);
  instance.unmount();
  await sleep(100);
}

void streamCalls;
console.log('[PASS] TUI command surface honesty (every advertised command answers)');
