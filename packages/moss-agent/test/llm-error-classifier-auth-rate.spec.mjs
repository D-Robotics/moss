#!/usr/bin/env node
import assert from 'node:assert/strict';
import { classifyLlmError } from '../dist/core/llm/llm-error-classifier.js';

assert.deepEqual(
  classifyLlmError(new Error('LLM stream error: rate limit exceeded')),
  { category: 'rate_limit', retryable: true, message: 'LLM stream error: rate limit exceeded' },
);
const auth = classifyLlmError(new Error('LLM stream error: Invalid API key'));
assert.equal(auth.category, 'auth');
assert.equal(auth.retryable, false);
console.log('[PASS] natural-language auth and rate-limit errors classify correctly');
