#!/usr/bin/env node
/**
 * B13 root cause probe: `reserveTokens`/`keepRecentTokens` default to 20k but a
 * model can have a 4k–8k window (`agent.contextTokens=5000`, local models).
 * Before this fix the compaction threshold was `window - 20000 < 0`, so every
 * turn counted as over budget, and the summarizer was asked for up to 4096
 * output tokens (~82% of a 5k window) — the request stalls and the 30s prepare
 * timeout silently skips compaction.
 *
 * No model call: settings clamp + threshold + summarizer budget are pure.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
  DEFAULT_COMPACTION_SETTINGS,
  clampCompactionSettingsToWindow,
  compactHistoryIfNeeded,
  shouldTriggerCompaction,
} = await import(pathToFileURL(path.join(root, 'dist/context/compaction.js')).href);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[compaction-window-clamp] ok ${name}`);
}

const tiny = [
  { role: 'user', content: 'hi', timestamp: 1 },
  { role: 'assistant', content: 'hello', timestamp: 2 },
];
const wide = [{ role: 'user', content: 'x'.repeat(18_000), timestamp: 3 }];

// ── 1. A 5k window gets a feasible reserve/keepRecent ────────────────────────

const small = clampCompactionSettingsToWindow(DEFAULT_COMPACTION_SETTINGS, 5_000);
assert.equal(small.reserveTokens, 1_250, `expected 1250, got ${small.reserveTokens}`);
assert.equal(small.keepRecentTokens, 2_500, `expected 2500, got ${small.keepRecentTokens}`);
ok('a 5k window clamps reserve to 25% and keepRecent to 50%');

const standard = clampCompactionSettingsToWindow(DEFAULT_COMPACTION_SETTINGS, 32_000);
assert.deepEqual(standard, DEFAULT_COMPACTION_SETTINGS);
ok('a standard 32k window keeps the configured 20k defaults (no behavior change)');

const configured = clampCompactionSettingsToWindow(
  { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 4_000, keepRecentTokens: 6_000 },
  32_000
);
assert.equal(configured.reserveTokens, 4_000);
assert.equal(configured.keepRecentTokens, 6_000);
ok('explicit user settings below the window are left alone');

// ── 2. The trigger threshold is no longer negative on small windows ──────────

assert.equal(
  shouldTriggerCompaction({ messages: tiny, contextWindowTokens: 5_000 }),
  false,
  'a two-message conversation must not count as over budget on a 5k window'
);
assert.equal(
  shouldTriggerCompaction({ messages: wide, contextWindowTokens: 5_000 }),
  true,
  'a ~4.5k-token prompt must still trigger on a 5k window'
);
ok('small-window compaction triggers on real usage, not on every turn');

// ── 3. The summary output budget fits the window ────────────────────────────

const { buildDeterministicCompactionSummary } = await import(
  pathToFileURL(path.join(root, 'dist/context/deterministic-summary.js')).href
);
const validSummary = buildDeterministicCompactionSummary(tiny, 'probe');

async function summaryMaxTokens(contextWindowTokens) {
  let captured;
  await compactHistoryIfNeeded({
    summarize: async (params) => {
      captured = params;
      return validSummary;
    },
    messages: tiny,
    contextWindowTokens,
    forceCompaction: true,
  });
  return captured?.maxTokens;
}

// B66: a 5k window no longer asks the model for a summary at all -- the
// summarizer prompt (system prompt + transcript) does not fit the window, so
// compaction uses the bounded local summary instead.
assert.equal(
  await summaryMaxTokens(5_000),
  undefined,
  'a 5k window must not call the model summarizer'
);
const tinyWindowCompaction = await compactHistoryIfNeeded({
  summarize: async () => {
    throw new Error('the model summarizer must not run on a tiny window');
  },
  messages: tiny,
  contextWindowTokens: 5_000,
  forceCompaction: true,
});
const tinySummaryChars = tinyWindowCompaction.summary?.length ?? 0;
assert.ok(tinySummaryChars > 0, 'a 5k window still produces a local deterministic summary');
assert.ok(
  tinySummaryChars <= 3_000,
  `5k window local summary ${tinySummaryChars} chars must fit ~15% of the window`
);
assert.equal(await summaryMaxTokens(32_000), 4_096);
ok('a 5k window uses a bounded local summary; 32k keeps the 4096 model-summary cap');

console.log(`[compaction-window-clamp] ${checks} checks passed`);
