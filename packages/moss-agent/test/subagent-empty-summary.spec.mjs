#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  isEmptySubagentSummary,
  normalizeSubagentSuccess,
  inferFanOutScope,
  inferFanOutScopeWithExploreDefault,
  defaultMaxTurnsForScope,
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

// ─── fan_out scope inference ────────────────────────────────────────────────

assert.equal(inferFanOutScope('review correctness of the diff'), 'explore');
assert.equal(inferFanOutScope('security angle: look for injection'), 'explore');
assert.equal(inferFanOutScope('fix the null pointer bug in auth.ts'), 'full');
assert.equal(inferFanOutScope('implement path headlines for multi_edit'), 'full');
assert.equal(inferFanOutScope('verify with npm test and typecheck only'), 'verify');
assert.equal(inferFanOutScope('plan a phased migration roadmap'), 'plan');
assert.equal(inferFanOutScope('anything', 'full'), 'full', 'explicit scope wins');
assert.equal(inferFanOutScope('fix the bug', 'explore'), 'explore', 'explicit explore wins even for fix');
assert.equal(inferFanOutScope('how is the codebase organized'), 'explore');
assert.equal(inferFanOutScopeWithExploreDefault('generic parallel angle without verbs'), 'explore');
assert.equal(inferFanOutScopeWithExploreDefault('fix the auth bug'), 'full');
assert.equal(defaultMaxTurnsForScope('explore'), 20);
assert.equal(defaultMaxTurnsForScope('full'), 64);

console.log('[PASS] subagent-empty-summary + inferFanOutScope');
