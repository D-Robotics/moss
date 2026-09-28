#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveTemperatureFromEnv } from '../dist/cli/oneshot.js';

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
assert.equal(
  resolveTemperatureFromEnv({ MOSS_TEMPERATURE: 'warm' }),
  undefined,
  'non-numeric ignored'
);
