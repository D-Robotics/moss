#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DEFAULT_MAX_OUTPUT_TOKENS_CAP, deriveMaxOutputTokens } from '../dist/cli/agent-runtime.js';

assert.equal(DEFAULT_MAX_OUTPUT_TOKENS_CAP, 16_384);
assert.equal(deriveMaxOutputTokens(undefined), undefined);
assert.equal(deriveMaxOutputTokens(0), undefined);
assert.equal(
  deriveMaxOutputTokens(1_000_000),
  16_384,
  'unknown model on a 1M window starts at 16k'
);
assert.equal(
  deriveMaxOutputTokens(200_000),
  16_384,
  'unknown model on a 200k window starts at 16k'
);
assert.equal(deriveMaxOutputTokens(16_000), 14_976, 'small window clamps to contextTokens - 1024');
assert.equal(deriveMaxOutputTokens(4_000), 2_976, 'tiny window clamps to contextTokens - 1024');
assert.equal(
  deriveMaxOutputTokens(1_000_000, 'glm-5.3'),
  32_768,
  'glm-5 starts at its table default'
);
assert.equal(
  deriveMaxOutputTokens(20_000, 'glm-5.3'),
  18_976,
  'glm-5 still clamps to the context window'
);

console.log('[PASS] agent-runtime max output derivation');
