#!/usr/bin/env node
/**
 * B65 probe: the prompt budget the loop plans against must never exceed the
 * model's configured window, and the proactive compaction threshold must stay
 * inside that budget. Before this fix a 4096-token model with a 1024-token
 * output reservation reported 4000 prompt tokens (real budget 3072) and its
 * proactive threshold equalled the budget, so only the hard cap could fire and
 * the prompt could grow past the provider's context limit.
 *
 * Pure arithmetic, no model call.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { getEffectiveContextWindowTokens, getProactiveCompactThreshold } = await import(
  pathToFileURL(path.join(root, 'dist/context/window-economics.js')).href
);

// Invariant sweep: no window/output combination may claim more prompt budget
// than the window, and the proactive threshold must fit inside the budget.
let checked = 0;
for (const window of [512, 1024, 2048, 4000, 4096, 5000, 8192, 16000, 32000, 128000, 200000]) {
  for (const maxOut of [256, 1024, 2048, 4096, 16384]) {
    const effective = getEffectiveContextWindowTokens(window, maxOut);
    const threshold = getProactiveCompactThreshold(effective);
    const label = `window ${window} / maxOut ${maxOut}`;
    assert.ok(effective > 0, `${label}: effective ${effective} must be positive`);
    assert.ok(effective <= window, `${label}: effective ${effective} exceeds the window ${window}`);
    assert.ok(threshold > 0, `${label}: threshold ${threshold} must be positive`);
    assert.ok(
      threshold <= effective,
      `${label}: threshold ${threshold} exceeds the effective budget ${effective}`
    );
    checked += 1;
  }
}

// A 4096 window with a quarter output reservation leaves 3072 prompt tokens.
assert.equal(getEffectiveContextWindowTokens(4096, 1024), 3072);
assert.equal(getProactiveCompactThreshold(3072), 2304);
// A 8192 window keeps the 6144 prompt budget it had before (no regression).
assert.equal(getEffectiveContextWindowTokens(8192, 2048), 6144);
// Standard windows are untouched: 32k window, 4k output.
assert.equal(getEffectiveContextWindowTokens(32000, 4096), 27904);
assert.equal(getProactiveCompactThreshold(27904), 14904);
// A window smaller than the output reservation still reports at most the window.
for (const window of [512, 1024, 1200]) {
  const effective = getEffectiveContextWindowTokens(window, 4096);
  assert.ok(
    effective <= window,
    `tiny window ${window}: effective ${effective} exceeds the window`
  );
}

console.log(
  `[window-economics] ok: ${checked} window/output pairs in range, 4096 -> 3072 prompt tokens, 32k unchanged`
);
