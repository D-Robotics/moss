#!/usr/bin/env node
/**
 * An enum rejection must name the allowed values.
 *
 * `must be one of the enum values` sent the model back to guess, and the guess
 * burned another turn. The validator knows both the allowed set and what
 * arrived, so it should say them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolInputObject } from '../dist/core/tools/tool-pipeline.js';

const tool = {
  name: 'demo_tool',
  description: 'test double',
  metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['fast', 'thorough'] },
    },
    required: ['mode'],
  },
  async execute() {
    return 'ok';
  },
};

test('enum rejection lists the allowed values and what arrived', () => {
  const result = validateToolInputObject(tool, { mode: 'quick' });
  assert.equal(result.ok, false);
  assert.match(result.message, /parameter "mode" must be one of "fast", "thorough"/);
  assert.match(result.message, /\(got "quick"\)/);
});

test('an allowed value still passes', () => {
  const result = validateToolInputObject(tool, { mode: 'thorough' });
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, 'thorough');
});
