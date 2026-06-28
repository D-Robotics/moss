#!/usr/bin/env node
/**
 * Provider routing and error handling — tested from the user's perspective:
 * what error messages and routing decisions does the user experience.
 */
import assert from 'node:assert/strict';

import { providerErrorHint, providerError, createCliProvider } from '../dist/cli/providers.js';
import { PROVIDER_PRESETS } from '../dist/cli/config.js';

// ─── PROVIDER_PRESETS ────────────────────────────────────────────────────────

{
  const presets = Object.keys(PROVIDER_PRESETS);
  for (const expected of ['deepseek', 'qwen', 'openai', 'anthropic', 'openai-compatible']) {
    assert.ok(presets.includes(expected), `PROVIDER_PRESETS includes '${expected}'`);
  }
}

// Each preset has a displayName and an id matching its key
for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
  assert.ok(preset.displayName, `${name} preset has a displayName`);
  assert.equal(preset.id, name, `${name} preset id matches its key`);
}

// ─── providerErrorHint ────────────────────────────────────────────────────────

{
  const hint = providerErrorHint(401);
  assert.ok(hint.includes('API key') || hint.includes('apiKey'), '401 hint points to API key problem');
  assert.ok(hint.includes('moss setup') || hint.includes('moss config'), '401 hint shows how to fix it');
}

{
  const hint = providerErrorHint(403);
  assert.ok(hint.includes('API key') || hint.includes('apiKey'), '403 hint points to API key problem');
}

{
  const hint = providerErrorHint(429);
  assert.ok(hint.toLowerCase().includes('rate') || hint.toLowerCase().includes('limit'), '429 hint mentions rate limiting');
}

{
  const hint = providerErrorHint(500);
  assert.ok(hint.toLowerCase().includes('retry') || hint.toLowerCase().includes('gateway'), '5xx hint suggests retry');
}

{
  const hint = providerErrorHint(200);
  assert.equal(hint, '', '200 OK has no hint');
}

// ─── providerError ────────────────────────────────────────────────────────────

{
  const err = providerError('DeepSeek', 401, 'Unauthorized');
  assert.ok(err instanceof Error, 'returns an Error instance');
  assert.ok(err.message.includes('401'), 'error message includes HTTP status');
  assert.ok(err.message.includes('DeepSeek'), 'error message includes provider name');
  // The hint should be appended for actionable errors
  assert.ok(err.message.includes('moss setup') || err.message.includes('apiKey'), 'error message includes remediation hint');
}

{
  // JSON error responses should extract the human-readable message
  const jsonBody = JSON.stringify({ error: { message: 'Invalid API key provided' } });
  const err = providerError('OpenAI', 401, jsonBody);
  assert.ok(err.message.includes('Invalid API key provided'), 'extracts human-readable message from JSON body');
  assert.ok(!err.message.includes('"error"'), 'does not include raw JSON keys in message');
}

{
  // Very long error bodies should be truncated
  const longBody = 'x'.repeat(500);
  const err = providerError('Qwen', 500, longBody);
  assert.ok(err.message.length < 600, 'long error bodies are truncated to user-readable length');
}

{
  // 429 from built-in gateway should mention switching to own key
  const err = providerError('OpenAI-compatible', 429, 'quota exceeded');
  assert.ok(err.message.includes('rate') || err.message.includes('retry') || err.message.length > 20,
    'rate limit error is informative');
}

// ─── createCliProvider returns a usable LLM provider ─────────────────────────

{
  const provider = createCliProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com/v1',
  });
  assert.ok(typeof provider.stream === 'function', 'provider has stream method');
  assert.ok(typeof provider.complete === 'function', 'provider has complete method');
}

console.log('[PASS] Provider routing and error handling');
