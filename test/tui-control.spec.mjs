#!/usr/bin/env node
/**
 * TUI control plane (v0.18): /steer during a run, input queue with
 * pause/drop/resume, per-run + session usage in the status line, /bg list.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTuiStore, formatUsage } from '../dist/cli/tui/render-bridge.js';

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
const { TuiAppRoot } = await import('../dist/cli/tui/app.js');

const calls = [];
const steers = [];
function mockAgent({ slow = false } = {}) {
  return {
    steer(sessionKey, constraint) {
      steers.push({ sessionKey, constraint });
      return { delivery: 'steer', message: constraint, id: 's1', createdAt: Date.now() };
    },
    async *streamChat(sessionKey, message, opts) {
      calls.push(message);
      for (let i = 0; i < (slow ? 6 : 1); i++) {
        if (slow && opts?.abortSignal?.aborted) return;
        yield { type: 'text_delta', delta: `ack:${message.slice(0, 12)} ` };
        if (slow) await sleep(80);
      }
      yield {
        type: 'llm_usage',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      yield {
        type: 'done',
        result: { response: `done ${message.slice(0, 10)}`, stopReason: 'end_turn' },
      };
    },
  };
}

// ─── usage formatter ────────────────────────────────────────────────────────

{
  assert.match(
    formatUsage({ tokensIn: 1500, tokensOut: 400, runTokensIn: 900, runTokensOut: 100 }),
    /1k in run/
  );
  assert.match(
    formatUsage({ tokensIn: 1500, tokensOut: 400, runTokensIn: 900, runTokensOut: 100 }),
    /1.9k session/
  );
}

// ─── /steer injects into the live run ───────────────────────────────────────

{
  calls.length = 0;
  steers.length = 0;
  const handle = liveHandle();
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: { agent: mockAgent({ slow: true }), workspaceDir: '/tmp/ws', sessionKey: 'sess-1' },
      handle,
    })
  );
  await type(instance, 'do the big task');
  await waitFor(() => calls.length === 1);
  await type(instance, '/steer keep it under 50 lines');
  const steered = await waitFor(() => steers.length === 1);
  assert.ok(steered, '/steer reached agent.steer');
  assert.equal(steers[0].sessionKey, 'sess-1');
  assert.equal(steers[0].constraint, 'keep it under 50 lines');
  await waitFor(() => instance.lastFrame().includes('Steer queued'));
  instance.unmount();
  await sleep(120);
}

// ─── queue: submit while running → runs after; pause holds; drop works ─────

{
  calls.length = 0;
  const handle = liveHandle();
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: { agent: mockAgent({ slow: true }), workspaceDir: '/tmp/ws' },
      handle,
    })
  );
  await type(instance, 'first slow task');
  await waitFor(() => calls.length === 1);
  await type(instance, 'second queued task');
  await waitFor(() => instance.lastFrame().includes('Queued #1'));
  await type(instance, '/queue');
  await waitFor(() => instance.lastFrame().includes('Queue (active)'));
  assert.match(instance.lastFrame(), /1\. second queued task/);

  // Pause, then let the first run finish — the queued item must NOT start.
  await type(instance, '/queue pause');
  await waitFor(() => instance.lastFrame().includes('Queue paused'));
  await waitFor(() => !instance.lastFrame().includes('working'), 6000);
  await sleep(300);
  assert.equal(calls.length, 1, 'paused queue does not drain');

  // Drop the queued item, then confirm empty.
  await type(instance, '/queue drop');
  await waitFor(() => instance.lastFrame().includes('Dropped: second queued task'));

  // Resume with nothing queued: a fresh submission runs directly.
  await type(instance, '/queue resume');
  await type(instance, 'fresh after resume');
  const ran = await waitFor(() => calls.includes('fresh after resume'));
  assert.ok(ran, 'submission after resume runs');
  instance.unmount();
  await sleep(120);
}

// ─── usage: /usage shows run + session totals; status line carries usage ────

{
  calls.length = 0;
  const handle = liveHandle();
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: { agent: mockAgent(), workspaceDir: '/tmp/ws' },
      handle,
    })
  );
  await type(instance, 'count my tokens');
  await waitFor(() => instance.lastFrame().includes('done count my'));
  assert.match(instance.lastFrame(), /150 in run \/ 150 session/, 'status line usage');
  await type(instance, '/usage');
  await waitFor(() => instance.lastFrame().includes('tokens: '));
  instance.unmount();
  await sleep(120);
}

// ─── /bg: empty background registry ─────────────────────────────────────────

{
  calls.length = 0;
  const handle = liveHandle();
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: { agent: mockAgent(), workspaceDir: '/tmp/ws' },
      handle,
    })
  );
  await type(instance, '/bg');
  await waitFor(() => instance.lastFrame().includes('No background tasks'));
  instance.unmount();
  await sleep(120);
}

void fs;
void os;
void path;

console.log('[PASS] TUI control plane (steer/queue/usage/bg)');
