#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parallelToolCallsWithinBudget } from '../dist/core/loop/agent-loop-tool-execution.js';

assert.equal(
  parallelToolCallsWithinBudget(4, { totalToolCalls: 0 }, 6),
  true,
  'a readonly batch stays parallel when the full batch fits in the remaining budget',
);
assert.equal(
  parallelToolCallsWithinBudget(4, { totalToolCalls: 3 }, 6),
  false,
  'a batch falls back to serial enforcement when it would exceed the remaining budget',
);
assert.equal(
  parallelToolCallsWithinBudget(4, { totalToolCalls: 3 }, undefined),
  true,
  'unbounded runs always preserve readonly parallelism',
);

console.log('[PASS] tool budgets preserve safe parallel batches');
