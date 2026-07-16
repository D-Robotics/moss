import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCodingCompletionGate,
  createCliCompletionGate,
} from '../dist/cli/coding-completion-gate.js';

test('coding gate passes when no edits', () => {
  const r = evaluateCodingCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 1,
    response: 'done',
    messages: [{ role: 'user', content: 'fix the login bug' }],
    totalToolCalls: 0,
    toolCallsByName: {},
  });
  assert.equal(r.ok, true);
});

test('coding gate passes when edits + run_tests', () => {
  const r = evaluateCodingCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 3,
    response: 'fixed',
    messages: [{ role: 'user', content: 'fix the cache bug' }],
    totalToolCalls: 4,
    toolCallsByName: { edit_file: 2, run_tests: 1 },
  });
  assert.equal(r.ok, true);
});

test('coding gate passes when edits + exec (tests via shell)', () => {
  const r = evaluateCodingCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 3,
    response: 'fixed',
    messages: [{ role: 'user', content: 'implement the feature' }],
    totalToolCalls: 3,
    toolCallsByName: { write_file: 1, exec: 1 },
  });
  assert.equal(r.ok, true);
});

test('coding gate rejects edit without verification on fix intent', () => {
  const r = evaluateCodingCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 2,
    response: 'All done, the bug is fixed.',
    messages: [{ role: 'user', content: 'fix the pre-abort child process bug' }],
    totalToolCalls: 2,
    toolCallsByName: { edit_file: 1, read_file: 1 },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /without verification/);
  assert.match(r.correction, /run_tests/);
  assert.equal(r.retryLimit, 1);
});

test('coding gate does not fire for non-coding chat', () => {
  const r = evaluateCodingCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 1,
    response: 'here is a note',
    messages: [{ role: 'user', content: 'write a short README note' }],
    totalToolCalls: 1,
    toolCallsByName: { write_file: 1 },
  });
  // "write" alone is not CODING_CHANGE_RE without fix/implement/refactor/test
  assert.equal(r.ok, true);
});

test('createCliCompletionGate chains extra gate', async () => {
  const gate = createCliCompletionGate(async () => ({
    ok: false,
    reason: 'extra',
    retryLimit: 0,
  }));
  const r = await gate({
    sessionKey: 's',
    runId: 'r',
    turn: 1,
    response: 'ok',
    messages: [{ role: 'user', content: 'hello' }],
    totalToolCalls: 0,
    toolCallsByName: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'extra');
});
