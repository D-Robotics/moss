#!/usr/bin/env node
/**
 * Compaction summary output budget (O2 decision outcome).
 * Measured on a real session: without a ceiling the model fills the full
 * 0.8×reserve budget (~16k tokens / 68k chars / 3.4 min) with near-zero
 * marginal value. The clamp keeps summaries dense regardless of how large
 * the configured reserve is.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactionSummary, MAX_SUMMARY_OUTPUT_TOKENS } from '../dist/context/compaction.js';

const messages = [
  { role: 'user', content: 'read src/cli/doctor.ts', timestamp: Date.now() },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'reading' }],
    timestamp: Date.now(),
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body', is_error: false }],
    timestamp: Date.now(),
  },
];

test('summary output budget is clamped even with a huge reserve', async () => {
  const seen = [];
  const summary = await buildCompactionSummary({
    summarize: async (req) => {
      seen.push(req.maxTokens);
      return '<summary>ok</summary>';
    },
    messages,
    contextWindowTokens: 1_000_000,
    reserveTokens: 200_000, // 0.8×reserve would be 160k tokens without the clamp
  });
  assert.ok(seen.length >= 1, 'summarize called');
  for (const maxTokens of seen) {
    assert.ok(
      maxTokens <= MAX_SUMMARY_OUTPUT_TOKENS,
      `per-call maxTokens ${maxTokens} clamped to ${MAX_SUMMARY_OUTPUT_TOKENS}`
    );
    assert.ok(maxTokens >= 64, 'never clamps below the floor');
  }
  assert.match(summary, /ok/, 'summary returned');
});

test('an explicit smaller budget is respected (clamp is a ceiling, not a floor)', async () => {
  const seen = [];
  await buildCompactionSummary({
    summarize: async (req) => {
      seen.push(req.maxTokens);
      return 'ok';
    },
    messages,
    contextWindowTokens: 1_000_000,
    maxTokens: 500,
  });
  for (const maxTokens of seen)
    assert.ok(maxTokens <= 500, `explicit 500 respected, got ${maxTokens}`);
});

console.log('[PASS] compaction summary budget clamp');
