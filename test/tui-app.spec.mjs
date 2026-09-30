#!/usr/bin/env node
/**
 * moss TUI (v0.17): full-screen transcript, Esc interrupt, bracketed paste,
 * resume replay. Component-level via ink-testing-library; pure modules
 * (paste capture, render bridge) directly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPasteCapture,
  feedChunk,
  confirmPendingPaste,
  PASTE_START,
  PASTE_END,
} from '../dist/cli/tui/input-box.js';
import {
  applyAgentEvent,
  beginRun,
  createTuiStore,
  endRun,
} from '../dist/cli/tui/render-bridge.js';
import { renderStatusBar } from '../dist/cli/tui/status-bar.js';
import { transcriptLines } from '../dist/cli/tui/transcript-view.js';

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

async function waitFor(predicate, timeoutMs = 4000, stepMs = 40) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ─── 1. Bracketed paste: 50 lines become ONE pending message ────────────────

{
  const cap = createPasteCapture();
  const lines = Array.from({ length: 50 }, (_, i) => `pasted line ${i + 1}`);
  const paste = `${PASTE_START}${lines.join('\n')}${PASTE_END}`;
  // Terminals may deliver the paste in several chunks.
  const mid = Math.floor(paste.length / 3);
  const d1 = feedChunk(cap, paste.slice(0, mid));
  const d2 = feedChunk(cap, paste.slice(mid, mid * 2));
  const d3 = feedChunk(cap, paste.slice(mid * 2));
  assert.equal(d1.completed || d2.completed || d3.completed, true, 'paste completes');
  const pending = confirmPendingPaste(cap);
  assert.ok(pending, 'one pending message captured');
  assert.equal(pending.split('\n').length, 50, 'all 50 lines in ONE message');
  assert.equal(confirmPendingPaste(cap), undefined, 'nothing else queued — exactly one turn');

  const noPaste = feedChunk(createPasteCapture(), 'regular typing');
  assert.equal(noPaste.consumed, false, 'normal typing is not hijacked');
}

// ─── 2. Render bridge: events → rows ────────────────────────────────────────

{
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, { type: 'text_delta', delta: 'hello ' });
  applyAgentEvent(store, { type: 'text_delta', delta: 'world' });
  applyAgentEvent(store, { type: 'tool_start', toolName: 'exec', toolCallId: 't1', input: {} });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 't1',
    result: 'ok',
    isError: false,
  });
  applyAgentEvent(store, { type: 'error', message: 'boom' });
  endRun(store, false);
  const kinds = store.rows.map((r) => r.kind);
  // The streaming tail commits as an assistant row at endRun — after the
  // system/error rows emitted mid-run.
  assert.deepEqual(kinds, ['system', 'error', 'assistant'], JSON.stringify(kinds));
  assert.equal(store.rows[2].text, 'hello world');
  assert.match(store.rows[0].text, /exec \(ok\)/);
  assert.equal(store.run.running, false);
}

// ─── 3. Status bar + transcript window ──────────────────────────────────────

{
  assert.match(
    renderStatusBar({ model: 'deepseek-flash@latest', running: true, scrollOffset: 0 }),
    /working/
  );
  assert.match(renderStatusBar({ running: false, halted: true, scrollOffset: 3 }), /halted/);
  const store = createTuiStore();
  for (let i = 1; i <= 30; i++) {
    store.rows.push({ id: i, kind: 'user', text: `row ${i}` });
  }
  const visible = transcriptLines(store, 0, { height: 5 });
  assert.deepEqual(visible, ['› row 26', '› row 27', '› row 28', '› row 29', '› row 30']);
  const scrolled = transcriptLines(store, 10, { height: 5 });
  assert.ok(scrolled[0].includes('row 16'));
}

async function type(instance, text) {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(20);
  }
  instance.stdin.write('\r');
  await sleep(20);
}

// ─── 4. Component: help, paste→one call, Esc interrupt, resume replay ───────

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');
  const { TuiAppRoot, runTuiApp } = await import('../dist/cli/tui/app.js');

  const calls = [];
  function createMockAgent({ slow = false } = {}) {
    return {
      async *streamChat(sessionKey, message, opts) {
        calls.push({ sessionKey, message, aborted: false });
        const callIndex = calls.length - 1;
        for (let i = 0; i < (slow ? 10 : 1); i++) {
          if (slow && opts?.abortSignal?.aborted) {
            calls[callIndex].aborted = true;
            return;
          }
          yield { type: 'text_delta', delta: `echo: ${message.slice(0, 20)} [${i}] ` };
          if (slow) await sleep(60);
        }
        yield {
          type: 'done',
          result: { response: `echo: ${message.slice(0, 30)}`, stopReason: 'end_turn' },
        };
      },
    };
  }

  // 4a. /help renders the key reference
  {
    calls.length = 0;
    const handle = liveHandle();
    const instance = renderInk(
      React.createElement(TuiAppRoot, {
        options: { agent: createMockAgent(), workspaceDir: '/tmp/ws', model: 'm-test' },
        handle,
      })
    );
    await type(instance, '/help');
    await waitFor(() => instance.lastFrame().includes('PgUp'));
    assert.match(instance.lastFrame(), /Esc interrupt/, 'help text visible');
    instance.unmount();
    await sleep(150);
  }

  // 4b. A 50-line paste is confirmed into exactly ONE agent call
  {
    calls.length = 0;
    const handle = liveHandle();
    const instance = renderInk(
      React.createElement(TuiAppRoot, {
        options: { agent: createMockAgent(), workspaceDir: '/tmp/ws' },
        handle,
      })
    );
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    instance.stdin.write(`${PASTE_START}${lines.join('\n')}${PASTE_END}`);
    await waitFor(() => instance.lastFrame().includes('paste: 50 lines'));
    instance.stdin.write('\r');
    const ok = await waitFor(() => calls.length === 1);
    assert.ok(ok, `exactly one streamChat call (got ${calls.length})`);
    assert.equal(calls[0].message.split('\n').length, 50, 'full paste in one message');
    await waitFor(() => instance.lastFrame().includes('echo:'));
    instance.unmount();
    await sleep(150);
  }

  // 4c. Esc interrupts a running turn at a boundary; process survives.
  // Isolated subprocess: sequential ink instances in one process leak state.
  {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['test/fixtures/tui-esc-case.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 0, `esc case failed: ${(r.stderr || r.stdout || '').slice(-300)}`);
    assert.match(r.stdout, /TUI-ESC-OK/);
  }

  // 4d. Resume replay rows render on boot via runTuiApp options
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-replay-'));
    void tmp;
    const { buildResumeReplay } = await import('../dist/cli/tui-utils.js');
    const replay = buildResumeReplay([
      { role: 'user', content: 'earlier question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'earlier answer' },
          { type: 'tool_use', name: 'exec', input: { command: 'ls' } },
        ],
      },
    ]);
    const replayRows = replay.items.map((item) => ({ kind: item.kind, text: item.text }));
    const handle = liveHandle();
    const instance = renderInk(
      React.createElement(TuiAppRoot, {
        options: {
          agent: createMockAgent(),
          workspaceDir: '/tmp/ws',
          replayRows,
        },
        handle,
      })
    );
    const ok = await waitFor(
      () =>
        instance.lastFrame().includes('earlier question') &&
        instance.lastFrame().includes('Resumed')
    );
    assert.ok(ok, `replay rendered: ${instance.lastFrame().slice(0, 200)}`);
    instance.unmount();
    await sleep(150);
  }

  // 4e. Unknown slash commands answer honestly
  {
    calls.length = 0;
    const handle = liveHandle();
    const instance = renderInk(
      React.createElement(TuiAppRoot, {
        options: { agent: createMockAgent(), workspaceDir: '/tmp/ws' },
        handle,
      })
    );
    await type(instance, '/steer x');
    await waitFor(() => instance.lastFrame().includes('Unknown command "/steer"'));
    instance.unmount();
    await sleep(150);
  }

  void runTuiApp;
}

console.log('[PASS] TUI foundation (transcript/paste/Esc/replay)');
