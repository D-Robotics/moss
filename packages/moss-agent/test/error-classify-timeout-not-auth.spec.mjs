#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyLlmError } from '../dist/core/llm/llm-error-classifier.js';
import { classifyProviderError } from '../dist/provider/error-classify.js';

test('first-chunk stalls remain retryable timeouts even when guidance mentions API keys', () => {
  const message =
    'LLM produced no streaming output (including thinking) within 45s. ' +
    'Check network/proxy, Base URL, API Key and model availability.';
  const result = classifyProviderError({ errorMessage: message });

  assert.equal(result.category, 'timeout');
  assert.equal(result.retryable, true);
});

test('explicit authentication failures remain non-retryable', () => {
  for (const errorMessage of [
    'Invalid API key',
    'Unauthorized: bad credentials',
    'API key is invalid',
    'Your API key has expired',
    'Bad API key',
  ]) {
    const result = classifyProviderError({ errorMessage });
    assert.equal(result.category, 'auth', errorMessage);
    assert.equal(result.retryable, false, errorMessage);
  }

  const unauthorizedTimeoutText = classifyProviderError({
    errorMessage: 'Request timed out while validating the API key',
    status: 401,
  });
  assert.equal(unauthorizedTimeoutText.category, 'auth');
  assert.equal(unauthorizedTimeoutText.retryable, false);
});

test('operation-aborted messages retain abort semantics', () => {
  const result = classifyProviderError({
    errorMessage: 'Operation aborted',
    abortReason: 'user',
  });

  assert.equal(result.category, 'aborted_by_user');
  assert.equal(result.silent, true);
});

test('the typed first-chunk timeout is classified without relying on message text', () => {
  const error = new Error('Check network, proxy, Base URL, API Key, and model availability.');
  error.name = 'LlmFirstChunkTimeoutError';

  assert.deepEqual(classifyLlmError(error), {
    category: 'timeout',
    retryable: true,
    message: error.message,
  });
});
