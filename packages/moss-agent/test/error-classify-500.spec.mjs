#!/usr/bin/env node
/**
 * classifyProviderError — HTTP 5xx retryability. A 500 Internal Server Error
 * is often transient (gateway hiccup, temporary overload) and should be
 * retried like 502/503. Previously 500 fell to 'unknown' with retryable:false,
 * so the user saw an immediate failure instead of a retry.
 */
import assert from 'node:assert/strict';

import { classifyProviderError } from '../dist/provider/error-classify.js';

// ─── 500 is now retryable (was non-retryable 'unknown') ────────────────────

{
  const r = classifyProviderError({ errorMessage: 'Internal Server Error', status: 500 });
  assert.equal(r.retryable, true, 'HTTP 500 is retryable (transient server error)');
  assert.ok(r.category !== 'unknown', '500 is classified as a specific category, not unknown');
}

{
  const r = classifyProviderError({ errorMessage: 'internal server error' });
  assert.equal(r.retryable, true, '"internal server error" message is retryable even without status');
}

// ─── 502/503/504 remain retryable ──────────────────────────────────────────

for (const status of [500, 502, 503, 504, 529]) {
  const r = classifyProviderError({ errorMessage: `HTTP ${status}`, status });
  assert.equal(r.retryable, true, `HTTP ${status} is retryable`);
}

// ─── truncated successful HTTP streams are also transient ─────────────────

for (const errorMessage of [
  'LLM stream incomplete: Stream ended without finish_reason',
  'OpenAI provider: stream terminated without [DONE] or finish_reason',
]) {
  const r = classifyProviderError({ errorMessage });
  assert.equal(r.category, 'service_unavailable', 'missing terminal marker is a gateway interruption');
  assert.equal(r.retryable, true, 'missing terminal marker is retried');
}

// ─── non-retryable errors stay non-retryable (no false regression) ─────────

{
  const r = classifyProviderError({ errorMessage: 'Invalid API key', status: 401 });
  assert.equal(r.retryable, false, '401 auth error is not retryable');
}

{
  // Context overflow IS retryable in moss (after compaction, retry may succeed)
  // — this is by design. Just verify it's classified correctly.
  const r = classifyProviderError({ errorMessage: 'context_length_exceeded', code: 'context_length_exceeded' });
  assert.equal(r.category, 'context_length_exceeded', 'context overflow is classified correctly');
}

console.error('error-classify: HTTP 500 is now retryable (was non-retryable unknown) ✓');
