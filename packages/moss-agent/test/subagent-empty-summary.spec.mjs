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

// fan_out failure header must be isStringToolFailure-detectable
{
  const { isStringToolFailureResult } = await import('../dist/core/tools/execute-tool-call.js');
  const failedHeader =
    'Error: [fan_out_subagents] 2 sub-agents ran concurrently — 0 ok, 2 failed. Do not treat FAILED';
  assert.equal(isStringToolFailureResult(failedHeader), true);
  const okHeader = '[fan_out_subagents] 2 sub-agents ran concurrently — 2 ok, 0 failed.';
  assert.equal(isStringToolFailureResult(okHeader), false);
}

console.log('[PASS] subagent-empty-summary');
