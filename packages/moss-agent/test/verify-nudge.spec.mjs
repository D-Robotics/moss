#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateVerifyNudge,
  VERIFY_NUDGE_MIN_EDITS,
  VERIFY_NUDGE_MIN_TURNS,
} from '../dist/core/loop/verify-nudge.js';

// Not enough edits
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 5,
    toolCallsByName: { edit_file: 1, read_file: 2 },
    userText: 'fix the login bug',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Already verified with runtime suite
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 6,
    toolCallsByName: { edit_file: 3, run_tests: 1 },
    userText: 'fix the login bug',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Fix/implement: diagnostics-only does NOT silence mid-run nudge
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 6,
    toolCallsByName: { edit_file: 3, code_diagnostics: 1 },
    userText: 'fix the login bug',
    attempts: 0,
  });
  assert.equal(r.fire, true, 'code_diagnostics alone must not silence fix/implement verify nudge');
  assert.match(r.correction, /code_diagnostics alone is not enough|run_tests|verify_fix/);
}

// Generic coding: diagnostics is enough to silence mid-run nudge
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 6,
    toolCallsByName: { edit_file: 3, code_diagnostics: 1 },
    userText: 'add a small helper utility',
    attempts: 0,
  });
  assert.equal(r.fire, false, 'diagnostics can silence non-fix coding mid-run nudge');
}

// Fix + exec present — skip mid-run (end gate still checks command shape)
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 6,
    toolCallsByName: { edit_file: 3, exec: 1 },
    userText: 'fix the login bug',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Already nudged once
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 6,
    toolCallsByName: { edit_file: 3 },
    userText: 'fix the login bug',
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

// User asked to skip tests
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 6,
    toolCallsByName: { edit_file: 3 },
    userText: 'fix the typo, 不要跑测试',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Coding edits past thresholds without verify → fire
{
  const r = evaluateVerifyNudge({
    turns: VERIFY_NUDGE_MIN_TURNS,
    totalToolCalls: 5,
    toolCallsByName: { edit_file: VERIFY_NUDGE_MIN_EDITS, read_file: 1 },
    userText: 'fix the pre-abort child process bug',
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /run_tests|verify_fix/);
  assert.match(r.correction, /\[System\]/);
}

// One multi_edit batch counts as enough weighted edits
{
  const r = evaluateVerifyNudge({
    turns: VERIFY_NUDGE_MIN_TURNS,
    totalToolCalls: 4,
    toolCallsByName: { multi_edit: 1, read_file: 2 },
    userText: 'refactor the auth module across files',
    attempts: 0,
  });
  assert.equal(r.fire, true, 'single multi_edit should weight as batch edits');
}

// One apply_patch batch likewise
{
  const r = evaluateVerifyNudge({
    turns: VERIFY_NUDGE_MIN_TURNS,
    totalToolCalls: 3,
    toolCallsByName: { apply_patch: 1, search_code: 1 },
    userText: 'fix the cache bug with a patch',
    attempts: 0,
  });
  assert.equal(r.fire, true, 'single apply_patch should weight as batch edits');
}

// Non-coding chat → no fire
{
  const r = evaluateVerifyNudge({
    turns: 5,
    totalToolCalls: 5,
    toolCallsByName: { write_file: 3 },
    userText: 'write a short note about lunch',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] verify-nudge');
