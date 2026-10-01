#!/usr/bin/env node
/**
 * CLI shell performance budget: the transcript data path stays flat with a
 * 10k-row history. Scrolling is O(window) — ingest 10k rows once, then project
 * any window — and event ingestion is O(1) amortized.
 *
 * Budgets: projection of any 14-row window over 10k rows < 5ms; ingesting 10k
 * text_delta events < 250ms total. The summary is printed to stdout (the
 * `.autopilot/evidence/boards` board is written by the verify harness, not by
 * this spec, which is confined to test/).
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  createTuiStore,
  appendRow,
  applyAgentEvent,
  visibleRows,
} from '../dist/cli/tui/render-bridge.js';
import { renderTranscriptRows } from '../dist/cli/tui/transcript.js';

const ROWS = 10_000;
const WINDOW = 14;

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
assert.equal(store.rows.length, ROWS, 'the whole history is retained');

// Scrolling to any offset must project one window in < 5ms and never re-project
// the rest of the history. One warm-up projection first: the very first call in
// the process pays V8 JIT/ic for the whole projection path (measured ~12ms),
// which is a one-off, not the per-scroll cost this budget is about.
renderTranscriptRows(visibleRows(store, WINDOW, 0), 80);

let worstProjection = 0;
for (const offset of [0, 1, 2500, 5000, 9_990, ROWS]) {
  const start = performance.now();
  const window = visibleRows(store, WINDOW, offset);
  const lines = renderTranscriptRows(window, 80);
  const ms = performance.now() - start;
  worstProjection = Math.max(worstProjection, ms);
  assert.equal(window.length, WINDOW, `window at offset ${offset} has ${WINDOW} rows`);
  assert.equal(window[WINDOW - 1].text.includes('row '), true, `window at ${offset} has content`);
  assert.ok(
    lines.some((entry) => entry.text.includes('row ')),
    `window at offset ${offset} projects lines`
  );
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
assert.equal(streamStore.run.streamingText.length, 400, 'the live tail stays bounded');

const summary = {
  rows: ROWS,
  appendAllMs: Math.round(ingestMs * 100) / 100,
  worstWindowProjectionMs: Math.round(worstProjection * 100) / 100,
  streaming10kMs: Math.round(streamMs * 100) / 100,
  budget: { windowProjectionMaxMs: 5, streaming10kMaxMs: 250 },
  pass: true,
};
console.log(JSON.stringify(summary));
console.log('[PASS] TUI performance budget (10k rows)');
