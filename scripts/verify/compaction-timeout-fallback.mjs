#!/usr/bin/env node
/**
 * B13 probe: a slow LLM summarizer must not leave the context over budget with
 * only a log line. On a prepare timeout the loop retries with the local
 * deterministic summary (no model call), marks the compaction event `degraded`
 * and the result must actually shrink the context.
 *
 * No model call: `runProactiveWindowCompaction` is driven with a prepare that
 * stalls until the abort signal fires.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = '120';

const { runProactiveWindowCompaction } = await import(
  pathToFileURL(path.join(root, 'dist/core/loop/agent-loop-compaction.js')).href
);
const { buildDeterministicCompactionSummary } = await import(
  pathToFileURL(path.join(root, 'dist/context/deterministic-summary.js')).href
);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[compaction-timeout-fallback] ok ${name}`);
}

const longDrop = Array.from({ length: 4 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${index}: ${'detail '.repeat(120)}`,
  timestamp: 1_700_000_000_000 + index,
}));
const summaryMessage = {
  role: 'user',
  content: `<summary>${buildDeterministicCompactionSummary(longDrop, 'proactive')}</summary>`,
  timestamp: 2,
};
const calls = [];
const events = [];
const warnings = [];

const prepare = async ({ skipLlmCompaction, abortSignal }) => {
  calls.push(Boolean(skipLlmCompaction));
  if (!skipLlmCompaction) {
    await new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('summarizer stalled forever')), 5_000);
      abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted by prepare timeout'));
        },
        { once: true }
      );
    });
  }
  return {
    summary: summaryMessage.content,
    summaryMessage,
    messages: [summaryMessage],
    droppedMessages: longDrop.length,
    checkpointOutline: ['deterministic'],
  };
};

const outcome = await runProactiveWindowCompaction({
  sessionKey: 'probe',
  runId: 'probe-run',
  currentMessages: longDrop,
  rawTotalChars: 4_000,
  promptUnitsForWindow: 1_200,
  prepareCompaction: prepare,
  persistCurrentMessages: async () => {},
  push: (event) => events.push(event),
  onWarn: (message, meta) => warnings.push({ message, meta }),
});

const compaction = events.find((event) => event.type === 'compaction');
assert.ok(compaction, 'no compaction event was pushed');
assert.deepEqual(calls, [false, true], 'the timeout must retry with skipLlmCompaction');
assert.equal(compaction.degraded, true, 'the compaction event must say degraded');
assert.equal(outcome.degraded, true);
assert.equal(outcome.succeeded, true);
assert.equal(warnings.length, 1);
assert.match(warnings[0].message, /deterministic summary/);
assert.equal(warnings[0].meta.timeoutMs, 120);
assert.equal(warnings[0].meta.phase, 'proactive');
assert.ok(warnings[0].meta.elapsedMs >= 100, 'the warning must carry the observed wait');
assert.ok(
  Number(compaction.tokensAfter) < Number(compaction.tokensBefore),
  `the fallback grew the context: ${compaction.tokensBefore} -> ${compaction.tokensAfter}`
);
ok('prepare timeout retries deterministically and emits degraded compaction');

// The deterministic summary itself must never be larger than the messages it
// replaces, or a "compaction" can grow the context (seen with a tiny window).
const tiny = [{ role: 'user', content: 'short question', timestamp: 1 }];
const tinySummary = buildDeterministicCompactionSummary(tiny, 'proactive');
assert.ok(tinySummary.length <= 400, `tiny drop produced a ${tinySummary.length}-char summary`);
ok('a tiny dropped window cannot produce a huge summary');

const huge = Array.from({ length: 40 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `turn ${index}: ${'payload '.repeat(400)}`,
  timestamp: 1_700_000_000_000 + index,
}));
const hugeSummary = buildDeterministicCompactionSummary(huge, 'proactive');
const hugeChars = huge.reduce((n, message) => n + message.content.length, 0);
assert.ok(hugeSummary.length <= 12_000, `summary over the hard cap: ${hugeSummary.length}`);
assert.ok(
  hugeSummary.length <= hugeChars * 0.5,
  'summary must replace at most half the dropped chars'
);
ok('a large dropped window still produces a bounded summary');

console.log(`[compaction-timeout-fallback] ${checks} checks passed`);
