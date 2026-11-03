import assert from 'node:assert/strict';
import { evaluateSpecAuditNudge } from '../dist/core/loop/nudges/spec-audit-nudge.js';

function assistantToolUse(name, input = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name, input }],
    timestamp: 1,
  };
}

const userText =
  'docs/design.md and the comment in cart.js say rounding matches the documentation; node test.js must pass.';

assert.equal(
  evaluateSpecAuditNudge({ messages: undefined, userText, totalToolCalls: 0, attempts: 0 }).fire,
  false,
  'waits until tools have run'
);

{
  const decision = evaluateSpecAuditNudge({
    messages: [assistantToolUse('read_file', { path: 'docs/design.md' })],
    userText,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(decision.fire, true);
  assert.match(decision.correction, /SPEC-AUDIT\.md/);
  assert.match(decision.correction, /locked tests/);
  assert.match(decision.correction, /restore any premature source\/doc edit/);
}

assert.equal(
  evaluateSpecAuditNudge({
    messages: [
      assistantToolUse('read_file', { path: 'docs/design.md' }),
      assistantToolUse('write_file', { path: 'SPEC-AUDIT.md', content: 'stale docs' }),
    ],
    userText,
    totalToolCalls: 2,
    attempts: 0,
  }).fire,
  false,
  'a SPEC-AUDIT.md write satisfies the audit requirement'
);

assert.equal(
  evaluateSpecAuditNudge({
    messages: [assistantToolUse('read_file', { path: 'src/a.js' })],
    userText: 'fix the parser bug',
    totalToolCalls: 1,
    attempts: 0,
  }).fire,
  false,
  'ordinary bug fix does not claim a documentation authority'
);

assert.equal(
  evaluateSpecAuditNudge({
    messages: [assistantToolUse('read_file', { path: 'docs/design.md' })],
    userText,
    totalToolCalls: 1,
    attempts: 1,
  }).fire,
  false,
  'soft nudge fires once'
);

console.log('[PASS] spec-audit-nudge');
