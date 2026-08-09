#!/usr/bin/env node
/**
 * Overflow patterns — merged Pi v0.80.3 + moss Chinese.
 *
 * Verifies that patterns from Pi (previously missing in moss) now match,
 * and that moss's Chinese patterns still work.
 */
import assert from 'node:assert/strict';
import { isOverflowMessage, getOverflowPatterns } from '../dist/provider/overflow-patterns.js';

// ─── 1. Pi patterns that moss previously missed ────────────────────────────
const piOnlyCases = [
  'input is too long', // Bedrock / minimal proxies (bare variant — found by moss)
  'input is too long for requested model', // Bedrock (full)
  'Input token count (1196265) exceeds the maximum number of tokens allowed (1048575)', // Google
  "This model's maximum prompt length is 131072 but the request contains 537812 tokens", // xAI
  'Please reduce the length of the messages or completion', // Groq
  "This endpoint's maximum context length is 8192 tokens. However, you requested about 12000 tokens", // OpenRouter
  'Input length (265330) exceeds the maximum allowed input length of (262144) tokens.', // OpenRouter/Poolside
  "The input (500 tokens) is longer than the model's context length (4096 tokens).", // Together AI
  'prompt token count of 50000 exceeds the limit of 8192', // GitHub Copilot
  'the request exceeds the available context size, try increasing it', // llama.cpp
  'tokens to keep from the initial prompt is greater than the context length', // LM Studio
  'invalid params, context window exceeds limit', // MiniMax
  'Your request exceeded model token limit: 8192 (requested: 50000)', // Kimi
  'Prompt has 50000 tokens, but the configured context size is 8192 tokens', // DS4
  'model_context_window_exceeded', // z.ai
  'prompt too long; exceeded max context length by 5000 tokens', // Ollama
  '400 status code (no body)', // Cerebras
  '413 (no body)', // Cerebras 413
];
for (const msg of piOnlyCases) {
  assert.ok(isOverflowMessage(msg), `Pi pattern matches: ${msg.slice(0, 50)}...`);
}

// ─── 2. moss Chinese patterns still work ───────────────────────────────────
const chineseCases = [
  '上下文过长，请减少输入',
  '上下文超限',
  '输入过长',
  'tokens 超限',
  'prompt过长',
  '超过最大上下文',
  '请求超长',
];
for (const msg of chineseCases) {
  assert.ok(isOverflowMessage(msg), `Chinese pattern matches: ${msg}`);
}

// ─── 3. Pi patterns that moss already had still work ───────────────────────
const existingCases = [
  'prompt is too long: 213462 tokens > 200000 maximum', // Anthropic
  'Your input exceeds the context window of this model', // OpenAI
  'context_length_exceeded', // OpenAI code
  'too many tokens', // Generic
  'request_too_large', // Anthropic 413
];
for (const msg of existingCases) {
  assert.ok(isOverflowMessage(msg), `Existing pattern still matches: ${msg.slice(0, 50)}`);
}

// ─── 4. Non-overflow messages don't match ─────────────────────────────────
const nonOverflowCases = [
  'rate limit exceeded',
  'invalid api key',
  'server error',
  'model not found',
  '',
  'success',
  // Client-side `max_tokens` parameter errors are NOT context overflow — the
  // user's fix is to lower max_tokens, not compact history or start a new
  // session. Previously matched by a bare /max(?:imum)?_tokens/i pattern; that
  // pattern was removed so these client_error cases classify correctly.
  "your requested max_tokens (512000) exceeds the model's maximum output tokens (128000)",
  'invalid value for parameter max_tokens: must be between 1 and 8192',
  'max_tokens must be a positive integer',
  'the maximum_tokens field is required',
];
for (const msg of nonOverflowCases) {
  assert.equal(isOverflowMessage(msg), false, `Non-overflow not matched: "${msg}"`);
}

// ─── 5. Pattern count sanity ──────────────────────────────────────────────
const patterns = getOverflowPatterns();
assert.ok(patterns.length >= 34, `at least 34 patterns (Pi 25+ + moss 9+), got ${patterns.length}`);

console.log('  [PASS] overflow-patterns: Pi + moss Chinese + existing + non-overflow rejection');
