#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveTemperatureFromEnv, resolveTopPFromEnv } from '../dist/cli/oneshot.js';

assert.equal(resolveTemperatureFromEnv({}), undefined, 'unset env falls back to agent default');
assert.equal(
  resolveTemperatureFromEnv({ MOSS_TEMPERATURE: '' }),
  undefined,
  'empty string is treated as unset'
);
assert.equal(resolveTemperatureFromEnv({ MOSS_TEMPERATURE: '0' }), 0);
assert.equal(resolveTemperatureFromEnv({ MOSS_TEMPERATURE: ' 0.7 ' }), 0.7, 'whitespace tolerated');
assert.equal(resolveTemperatureFromEnv({ MOSS_TEMPERATURE: '2' }), 2);
assert.equal(resolveTemperatureFromEnv({ MOSS_TEMPERATURE: '2.5' }), undefined, 'above range');
assert.equal(resolveTemperatureFromEnv({ MOSS_TEMPERATURE: '-1' }), undefined, 'below range');
assert.equal(resolveTopPFromEnv({}), undefined);
assert.equal(resolveTopPFromEnv({ MOSS_TOP_P: '0.95' }), 0.95);
assert.equal(resolveTopPFromEnv({ MOSS_TOP_P: '0' }), undefined, 'top_p must be above 0');
assert.equal(resolveTopPFromEnv({ MOSS_TOP_P: '1.1' }), undefined, 'top_p must be at most 1');
assert.equal(
  resolveTemperatureFromEnv({ MOSS_TEMPERATURE: 'warm' }),
  undefined,
  'non-numeric ignored'
);
