#!/usr/bin/env node
/**
 * Per-turn token line and the headless usage JSON parser.
 */
import assert from 'node:assert/strict';

import { formatTurnUsage } from '../dist/cli/usage-display.js';
import { parseLlmUsageStdout } from '../dist/cli/task-run.js';
import { renderStatusRight } from '../dist/cli/tui/transcript.js';

assert.equal(formatTurnUsage(569012, 16849), '569k in / 16.8k out');
assert.equal(formatTurnUsage(100, 50), '100 in / 50 out');

const usage = parseLlmUsageStdout(
  '{"type":"llm_usage","input_tokens":569012,"output_tokens":16849}\n'
);
assert.deepEqual(usage, { inputTokens: 569012, outputTokens: 16849 });
assert.equal(parseLlmUsageStdout('Task accepted — PASS\n'), null);
assert.equal(parseLlmUsageStdout('{"type":"other"}\n'), null);

const idle = renderStatusRight(
  { running: false, tokens: 1500, taskCount: 0, queueLength: 0, turnIn: 569012, turnOut: 16849 },
  80
);
assert.match(idle.text, /569k in \/ 16\.8k out/);
assert.doesNotMatch(idle.text, /tokens/);

const legacy = renderStatusRight({ running: true, tokens: 1500, taskCount: 0, queueLength: 0 }, 80);
assert.match(legacy.text, /1\.5k out/);
assert.doesNotMatch(legacy.text, / in \//);

console.log('[PASS] usage display');
