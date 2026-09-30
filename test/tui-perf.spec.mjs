#!/usr/bin/env node
/**
 * TUI performance budget (v0.20): the transcript data path stays flat with a
 * 10k-row history — scrolling is O(window), event ingestion is O(1) amortized.
 * Budgets: projection of any window over 10k rows < 5ms; ingesting 10k
 * text_delta events < 250ms total.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

import { createTuiStore, appendRow, applyAgentEvent } from '../dist/cli/tui/render-bridge.js';
import { transcriptLines } from '../dist/cli/tui/transcript-view.js';

const ROWS = 10_000;

const store = createTuiStore();
const t0 = performance.now();
for (let i = 0; i < ROWS; i++) {
  appendRow(
    store,
    i % 2 === 0 ? 'user' : 'assistant',
    `row ${i} — some transcript content of usual width`
  );
}
const ingestMs = performance.now() - t0;

// Scroll to any offset must project a window in < 5ms.
let worstProjection = 0;
for (const offset of [0, 1, 2500, 5000, 9_990, ROWS]) {
  const start = performance.now();
  const lines = transcriptLines(store, offset, { height: 14 });
  const ms = performance.now() - start;
  worstProjection = Math.max(worstProjection, ms);
  assert.equal(lines.length, 14, `window at offset ${offset} has 14 lines`);
}
assert.ok(worstProjection < 5, `worst window projection ${worstProjection.toFixed(2)}ms >= 5ms`);

// Streaming 10k text_delta events (a very long run) stays under budget.
const streamStore = createTuiStore();
const t1 = performance.now();
for (let i = 0; i < ROWS; i++) {
  applyAgentEvent(streamStore, { type: 'text_delta', delta: 'x' });
}
const streamMs = performance.now() - t1;
assert.ok(streamMs < 250, `10k text_delta ingestion ${streamMs.toFixed(2)}ms >= 250ms`);

const summary = {
  rows: ROWS,
  appendAllMs: Math.round(ingestMs * 100) / 100,
  worstWindowProjectionMs: Math.round(worstProjection * 100) / 100,
  streaming10kMs: Math.round(streamMs * 100) / 100,
  budget: { windowProjectionMaxMs: 5, streaming10kMaxMs: 250 },
  pass: true,
};
console.log(JSON.stringify(summary));
fs.writeFileSync(
  path.join('.autopilot', 'evidence', 'boards', 'perf-budget.json'),
  `${JSON.stringify(summary, null, 2)}\n`
);
console.log('[PASS] TUI performance budget (10k rows)');
