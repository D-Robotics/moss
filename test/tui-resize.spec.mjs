#!/usr/bin/env node
/**
 * D-1 — a terminal resize must reflow the shell IMMEDIATELY, with no keystroke.
 *
 * The defect: `app.ts` read `stdout.columns` during a React render, and ink's own
 * `resize` handler only re-runs layout + repaints the existing tree — so the
 * chrome kept the OLD width until some unrelated state change forced a
 * re-render. Growing 80→120 left every rule/status/composer line 80 cells wide
 * in a 120-cell terminal; shrinking left the old and the new frame interleaved
 * (advertised as A6/A11 and reproduced in a PTY by the verifier).
 *
 * This spec drives the built component with a stdout whose `columns` changes and
 * emits the same `resize` event ink subscribes to, and asserts the frame
 * reflows without any stdin input at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stringWidth from 'string-width';

import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';
import { createTuiStore } from '../dist/cli/tui/render-bridge.js';
import { TuiAppRoot } from '../dist/cli/tui/app.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cells = (value) => stringWidth(value);

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(30);
  }
  return false;
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-resize-'));
const runtime = new TaskRuntime({ workspaceDir: ws });

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

const listeners = new Set();
const handle = {
  store: createTuiStore(),
  notify: () => {
    for (const listener of listeners) listener();
  },
  subscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** An agent that must never run: this spec only resizes. */
const agent = {
  asyncTasks: { list: () => [] },
  // eslint-disable-next-line require-yield
  async *streamChat() {
    throw new Error('the resize spec never starts a run');
  },
};

const instance = renderInk(
  React.createElement(TuiAppRoot, {
    options: { agent, workspaceDir: ws, model: 'model-x', version: '0.22.0' },
    handle,
    runtime,
  })
);

// ink-testing-library hard-codes `columns => 100` on the prototype; shadow it
// with a live value so a resize changes what `useWindowSize()` reads.
let width = 100;
Object.defineProperty(instance.stdout, 'columns', { get: () => width, configurable: true });

/** Every full-width chrome rule in the current frame, measured in cells. */
const ruleWidths = (frame) =>
  frame
    .split('\n')
    .filter((line) => /^─+$/.test(line))
    .map(cells);

/**
 * The LIVE chrome only: the status row (the line above the top rule), both
 * rules, the composer rows between them and the hint under the bottom rule.
 * Committed transcript rows sit in ink's `<Static>` prefix and are deliberately
 * immutable history — they are not part of what a resize has to reflow.
 */
function chromeLines(frame) {
  const lines = frame.split('\n');
  const first = lines.findIndex((line) => /^─+$/.test(line));
  const second = lines.findIndex((line, index) => index > first && /^─+$/.test(line));
  if (first < 1 || second <= first) return [];
  return [
    ...(first > 0 ? [lines[first - 1]] : []),
    ...lines.slice(first, second + 1),
    ...(second + 1 < lines.length ? [lines[second + 1]] : []),
  ];
}

function resizeTo(next) {
  width = next;
  instance.stdout.emit('resize');
}

/** Wait until the frame carries a rule of exactly `next` cells. */
const repainted = (next) => waitFor(() => ruleWidths(instance.lastFrame()).includes(next), 4000);

// ─── boot: the chrome is drawn at the terminal's width ────────────────────

assert.ok(
  await waitFor(() => ruleWidths(instance.lastFrame()).includes(100)),
  `boot chrome is 100 cells: ${JSON.stringify(instance.lastFrame().slice(-200))}`
);
assert.equal(
  new Set(ruleWidths(instance.lastFrame())).size,
  1,
  'both rules share one width at boot'
);

// ─── grow 100 → 120, with NO input ────────────────────────────────────────

resizeTo(120);
assert.ok(
  await repainted(120),
  `a resize repaints at 120 with no keystroke: ${JSON.stringify(ruleWidths(instance.lastFrame()))}`
);
{
  const widths = new Set(ruleWidths(instance.lastFrame()));
  assert.deepEqual(widths, new Set([120]), 'grow: exactly one chrome width remains on screen');
  const frame = instance.lastFrame();
  assert.ok(frame.includes('model-x'), 'the status row survived');
  assert.ok(/❯/.test(frame), 'the composer survived the resize');
  assert.ok(frame.includes('? for shortcuts'), 'the hint row survived the resize');
  for (const line of chromeLines(frame)) {
    assert.ok(cells(line) <= 120, `no chrome line exceeds the new width: ${JSON.stringify(line)}`);
  }
}

// ─── shrink 120 → 60, with NO input ───────────────────────────────────────

resizeTo(60);
assert.ok(
  await repainted(60),
  `a shrink repaints at 60 with no keystroke: ${JSON.stringify(ruleWidths(instance.lastFrame()))}`
);
{
  const widths = new Set(ruleWidths(instance.lastFrame()));
  assert.deepEqual(widths, new Set([60]), 'shrink: no stale 120-cell chrome is left behind');
  for (const line of chromeLines(instance.lastFrame())) {
    assert.ok(
      cells(line) <= 60,
      `no chrome line exceeds the shrunk width: ${JSON.stringify(line)}`
    );
  }
}

// ─── and back up again: the binding is not one-shot ───────────────────────

resizeTo(90);
assert.ok(await repainted(90), 'a second resize keeps tracking the terminal width');
assert.deepEqual(
  new Set(ruleWidths(instance.lastFrame())),
  new Set([90]),
  'the width follows every SIGWINCH'
);

// ─── stdin was never touched ──────────────────────────────────────────────

assert.equal(instance.stdin.data, null, 'no keystroke was needed for any of the reflows');

instance.unmount();
await sleep(120);

console.log('[PASS] TUI resize (D-1: SIGWINCH reflows with no keystroke, grow and shrink)');
