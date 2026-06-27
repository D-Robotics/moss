#!/usr/bin/env node
/**
 * providerError renders a readable, actionable message from an upstream HTTP
 * error body instead of dumping the raw JSON blob (which leaks
 * provider_specific_fields and other internals the user cannot act on).
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/cli-provider-error.spec.mjs
 */
import assert from 'node:assert/strict';
import { providerError, providerErrorHint } from '../dist/cli/providers.js';

{
  // OpenAI-compatible gateways return { "error": { "message": "..." } }; the
  // raw JSON also carries provider_specific_fields — the user should see the
  // message, not the blob, plus a hint for a 400.
  const body = JSON.stringify({
    error: {
      message: 'Invalid model name passed in model=gpt-4o. Call /v1/models to view available models.',
      type: 'None',
      param: 'None',
      code: '400',
      provider_specific_fields: { error: 'Invalid model name passed in model=gpt-4o...' },
    },
  });
  const err = providerError('OpenAI-compatible', 400, body);
  assert.match(err.message, /HTTP 400: Invalid model name passed in model=gpt-4o/);
  assert.doesNotMatch(err.message, /provider_specific_fields/, 'provider internals must not leak');
  assert.match(err.message, /\/model|moss setup/, '400 must hint at how to fix the model');
}

{
  // A plain-text (non-JSON) body is preserved verbatim, just compacted.
  const err = providerError('OpenAI-compatible', 500, '  upstream  error  ');
  assert.match(err.message, /HTTP 500: upstream error/);
  assert.match(err.message, /gateway error/);
}

{
  // 401/403 → API key hint.
  assert.match(providerError('Anthropic', 401, '{"error":"bad key"}').message, /check your API key/);
  assert.match(providerErrorHint(403), /API key/);
}

{
  // 429 → rate-limit hint; 5xx → gateway hint; unknown status → no false guidance.
  assert.match(providerErrorHint(429), /rate limited/);
  assert.match(providerErrorHint(503), /gateway error/);
  assert.equal(providerErrorHint(302), '');
}

{
  // Long detail is truncated so the terminal isn't flooded.
  const longMsg = 'x'.repeat(500);
  const err = providerError('OpenAI-compatible', 400, JSON.stringify({ error: { message: longMsg } }));
  assert.ok(err.message.length < 500, 'long detail must be truncated');
  assert.match(err.message, /…/, 'truncation marker present');
  assert.doesNotMatch(err.message, /x{400}/, 'detail must be shortened');
}

console.log('[PASS] providerError renders readable, actionable upstream errors');
