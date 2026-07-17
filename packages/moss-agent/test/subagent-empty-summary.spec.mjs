#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  isEmptySubagentSummary,
  normalizeSubagentSuccess,
} from '../dist/tools/create-subagent.js';

assert.equal(isEmptySubagentSummary(''), true);
assert.equal(isEmptySubagentSummary('   '), true);
assert.equal(isEmptySubagentSummary('(no output)'), true);
assert.equal(isEmptySubagentSummary(null), true);
assert.equal(isEmptySubagentSummary(undefined), true);
assert.equal(isEmptySubagentSummary('Found 3 bugs in auth.ts'), false);

assert.equal(normalizeSubagentSuccess(true, ''), false);
assert.equal(normalizeSubagentSuccess(true, '(no output)'), false);
assert.equal(normalizeSubagentSuccess(true, '  '), false);
assert.equal(normalizeSubagentSuccess(false, 'had error'), false);
assert.equal(normalizeSubagentSuccess(true, 'ok: fixed and tests green'), true);

// Background completion path must use the same normalization (contract):
// success:true + empty summary → false for registry and subagent_status.
{
  const bgSuccess = true;
  const bgSummary = '(no output)';
  assert.equal(
    normalizeSubagentSuccess(bgSuccess, bgSummary),
    false,
    'background empty summary cannot stay success',
  );
}

console.log('[PASS] subagent-empty-summary');
