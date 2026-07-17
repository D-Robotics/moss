#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateRedVerifyNudge } from '../dist/core/loop/red-verify-nudge.js';

function sessionWithRunTests(resultText, opts = {}) {
  return [
    { role: 'user', content: 'fix the login bug' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_rt',
          name: 'run_tests',
          input: { command: 'npm test' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_rt',
          name: 'run_tests',
          content: resultText,
          ...(opts.is_error ? { is_error: true, outcome: 'error' } : {}),
        },
      ],
    },
  ];
}

// No verification tools → no fire
{
  const r = evaluateRedVerifyNudge({
    messages: [{ role: 'user', content: 'hi' }],
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Green tests → no fire
{
  const r = evaluateRedVerifyNudge({
    messages: sessionWithRunTests('Test Results: ✅ ALL PASSED\nCommand: npm test\n'),
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Red harness banner → fire
{
  const r = evaluateRedVerifyNudge({
    messages: sessionWithRunTests('Test Results: ❌ 2 FAILED\nCommand: npm test\n', {
      is_error: true,
    }),
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.equal(r.toolName, 'run_tests');
  assert.match(r.correction, /RED|re-run|run_tests|verify/i);
}

// Max attempts per red wave (2) → third blocked
{
  const r = evaluateRedVerifyNudge({
    messages: sessionWithRunTests('Test Results: ❌ 1 FAILED\n', { is_error: true }),
    attempts: 2,
  });
  assert.equal(r.fire, false);
}

// After green, signal reset so a later red wave can fire again
{
  const r = evaluateRedVerifyNudge({
    messages: sessionWithRunTests('Test Results: ✅ ALL PASSED\nCommand: npm test\n'),
    attempts: 2,
  });
  assert.equal(r.fire, false);
  assert.equal(r.resetAttempts, true);
}

// Verification-shaped exec failure → fire
{
  const messages = [
    { role: 'user', content: 'fix the bug' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_ex',
          name: 'exec',
          input: { command: 'npm test' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_ex',
          name: 'exec',
          content: 'exit_code: 1\nFAIL',
          is_error: true,
          outcome: 'error',
        },
      ],
    },
  ];
  const r = evaluateRedVerifyNudge({ messages, attempts: 0 });
  assert.equal(r.fire, true);
  assert.equal(r.toolName, 'exec');
}

// Non-verification exec failure → no fire (not a verify tool)
{
  const messages = [
    { role: 'user', content: 'fix the bug' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_ex', name: 'exec', input: { command: 'ls' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_ex',
          name: 'exec',
          content: 'exit_code: 1\nnope',
          is_error: true,
        },
      ],
    },
  ];
  const r = evaluateRedVerifyNudge({ messages, attempts: 0 });
  assert.equal(r.fire, false);
}

console.log('[PASS] red-verify-nudge');
