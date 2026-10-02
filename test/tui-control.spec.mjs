#!/usr/bin/env node
/**
 * CLI shell control plane: /steer during a run, input queue with
 * pause/drop/resume, per-run + session usage in the status line, /bg list,
 * approval bridge. Retargeted from the deleted Mission Control status bar and
 * overlays to the single-column shell (chrome status line + inline blocks).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTuiStore, formatUsage } from '../dist/cli/tui/render-bridge.js';
import { renderStatusRight } from '../dist/cli/tui/transcript.js';
import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';
import { TuiAppRoot } from '../dist/cli/tui/app.js';
import { getCliApprovalAskerForTest } from '../dist/cli/approval.js';

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

function mount(options) {
  const handle = liveHandle();
  const runtime = new TaskRuntime({
    workspaceDir: options.workspaceDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-ctl-')),
  });
  const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
  return { instance, handle, runtime };
}

const calls = [];
const steers = [];
function mockAgent({ slow = false, hold = null } = {}) {
  return {
    steer(sessionKey, constraint) {
      steers.push({ sessionKey, constraint });
      return { delivery: 'steer', message: constraint, id: 's1', createdAt: Date.now() };
    },
    async *streamChat(sessionKey, message, opts) {
      calls.push(message);
      // hold: stream one delta and block until the test releases — makes
      // queue semantics deterministic on slow machines (the timed slow mode
      // finished before /queue on the Windows CI leg and drained the queue).
      if (hold) {
        yield { type: 'text_delta', delta: `ack:${message.slice(0, 12)} ` };
        await hold.promise;
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
        return;
      }
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

// ─── usage formatter + status line ──────────────────────────────────────────

{
  assert.match(
    formatUsage({ tokensIn: 1500, tokensOut: 400, runTokensIn: 900, runTokensOut: 100 }),
    /1k in run/
  );
  assert.match(
    formatUsage({ tokensIn: 1500, tokensOut: 400, runTokensIn: 900, runTokensOut: 100 }),
    /1.9k session/
  );
  assert.doesNotMatch(
    renderStatusRight({ running: false, tokens: 1500, taskCount: 0, queueLength: 0 }, 60).text,
    /tokens/,
    'the idle status line leaves session usage to /usage'
  );
}

// ─── /steer injects into the live run ───────────────────────────────────────

{
  calls.length = 0;
  steers.length = 0;
  let releaseRun;
  const hold = { promise: new Promise((resolve) => (releaseRun = resolve)) };
  const { instance, handle } = mount({
    agent: mockAgent({ hold }),
    workspaceDir: '/tmp/ws',
    sessionKey: 'sess-1',
  });
  await type(instance, 'do the big task');
  await waitFor(() => calls.length === 1);
  await type(instance, '/steer keep it under 50 lines');
  const steered = await waitFor(() => steers.length === 1);
  assert.ok(steered, '/steer reached agent.steer');
  assert.equal(steers[0].sessionKey, 'sess-1');
  assert.equal(steers[0].constraint, 'keep it under 50 lines');
  const answered = await waitFor(() =>
    handle.store.rows.some((r) => r.text.includes('queued: keep it under 50 lines'))
  );
  assert.ok(
    answered,
    `/steer answered inline: ${JSON.stringify(instance.lastFrame().slice(-200))}`
  );
  releaseRun();
  instance.unmount();
  await sleep(120);
}

// ─── queue: submit while running → runs after; pause holds; drop works ─────

{
  calls.length = 0;
  let releaseFirst;
  const hold = { promise: new Promise((resolve) => (releaseFirst = resolve)) };
  const { instance, handle } = mount({ agent: mockAgent({ hold }), workspaceDir: '/tmp/ws' });
  await type(instance, 'first slow task');
  await waitFor(() => calls.length === 1);
  await type(instance, 'second queued task');
  const queued = await waitFor(() => instance.lastFrame().includes('1 queued'));
  assert.ok(
    queued,
    `the shell shows the queue depth: ${JSON.stringify(instance.lastFrame().slice(-120))}`
  );
  await type(instance, '/queue');
  await waitFor(() => instance.lastFrame().includes('Queue (active)'));
  assert.match(instance.lastFrame(), /1\. second queued task/);

  // Pause, then let the held first run finish — the queued item must NOT start.
  await type(instance, '/queue pause');
  await waitFor(() => instance.lastFrame().includes('paused — new submissions wait'));
  releaseFirst();
  await waitFor(() => handle.store.run.running === false, 6000);
  await sleep(300);
  assert.equal(calls.length, 1, 'paused queue does not drain');

  // Drop the queued item, then confirm the queue is empty.
  await type(instance, '/queue drop');
  await waitFor(() => instance.lastFrame().includes('dropped: second queued task'));

  // Resume with nothing queued: a fresh submission runs directly.
  await type(instance, '/queue resume');
  await waitFor(() => instance.lastFrame().includes('resumed'));
  await type(instance, 'fresh after resume');
  const ran = await waitFor(() => calls.includes('fresh after resume'));
  assert.ok(ran, 'submission after resume runs');
  instance.unmount();
  await sleep(120);
}

// ─── usage: /usage shows run + session totals; status line carries usage ────

{
  calls.length = 0;
  const { instance, handle } = mount({ agent: mockAgent(), workspaceDir: '/tmp/ws' });
  await type(instance, 'count my tokens');
  await waitFor(() =>
    handle.store.rows.some((r) => r.kind === 'assistant' && r.text.includes('done count my'))
  );
  assert.match(
    instance.lastFrame(),
    /✻ \w+ for \d+s/,
    'run summary stays human-sized (tokens live in /usage)'
  );
  await type(instance, '/usage');
  await waitFor(() => instance.lastFrame().includes('150 in run / 150 session'));
  instance.unmount();
  await sleep(120);
}

// ─── /bg: empty background registry ─────────────────────────────────────────

{
  calls.length = 0;
  const { instance } = mount({ agent: mockAgent(), workspaceDir: '/tmp/ws' });
  await type(instance, '/bg');
  await waitFor(() => instance.lastFrame().includes('no background tasks running'));
  instance.unmount();
  await sleep(120);
}

// ─── approval bridge: question renders inline, next input answers ───────────
// The numbered options + ↑↓ cursor are covered in tui-shell.spec.mjs; here the
// guarantee is that the host's asker reaches the shell and the answer returns.

{
  calls.length = 0;
  const { instance } = mount({ agent: mockAgent(), workspaceDir: '/tmp/ws' });
  const asker = getCliApprovalAskerForTest();
  assert.ok(typeof asker === 'function', 'TUI registered an approval asker');
  const answerPromise = asker('Allow write_file src/index.ts?');
  const shown = await waitFor(() => instance.lastFrame().includes('Do you want to proceed?'));
  assert.ok(shown, `approval renders inline: ${JSON.stringify(instance.lastFrame().slice(-200))}`);
  assert.match(instance.lastFrame(), /1\. Yes/, 'the affirmative option is offered');
  await type(instance, 'y');
  const answer = await answerPromise;
  assert.equal(answer, 'y');
  const answered = await waitFor(() => instance.lastFrame().includes('approval: yes'));
  assert.ok(answered, 'the decision is committed to the transcript');
  instance.unmount();
  await sleep(120);
}

console.log('[PASS] TUI control plane (steer/queue/usage/bg/approval)');
