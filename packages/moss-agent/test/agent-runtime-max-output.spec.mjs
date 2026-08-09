#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DEFAULT_MAX_OUTPUT_TOKENS_CAP, deriveMaxOutputTokens } from '../dist/cli/agent-runtime.js';

assert.equal(DEFAULT_MAX_OUTPUT_TOKENS_CAP, 8192);

assert.equal(deriveMaxOutputTokens(undefined), undefined);
assert.equal(deriveMaxOutputTokens(0), undefined);
assert.equal(deriveMaxOutputTokens(1_000_000), 8192, '1M window caps at 8k for latency');
assert.equal(deriveMaxOutputTokens(200_000), 8192, '200k window caps at 8k');
assert.equal(deriveMaxOutputTokens(16_000), 4000, '16k window uses window/4');
assert.equal(deriveMaxOutputTokens(4_000), 2048, 'tiny window floors at 2k');

console.log('[PASS] agent-runtime max output derivation');
