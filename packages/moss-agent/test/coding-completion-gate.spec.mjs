import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCodingCompletionGate,
  evaluateTodoCompletionGate,
  evaluateVerificationOutcomeGate,
  evaluateFailureDrivenGate,
  evaluateDebugInvestigationGate,
  extractLatestTodosFromMessages,
  createCliCompletionGate,
} from '../dist/cli/coding-completion-gate.js';

function baseReq(overrides = {}) {
  return {
    sessionKey: 's',
    runId: 'r',
    turn: 1,
    response: 'done',
    messages: [{ role: 'user', content: 'fix the login bug' }],
    totalToolCalls: 0,
    toolCallsByName: {},
    ...overrides,
  };
}

function toolUse(id, name, input = {}) {
  return { type: 'tool_use', id, name, input };
}

function toolResult(toolUseId, name, content, extra = {}) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    name,
    content,
    ...extra,
  };
}

function todoMessages(resultText) {
  return [
    {
      role: 'assistant',
      content: [toolUse('tu_todo_1', 'todo_write', { todos: [] })],
    },
    {
      role: 'user',
      content: [toolResult('tu_todo_1', 'todo_write', resultText)],
    },
  ];
}

function execSession(command, resultText = 'ok') {
  return [
    { role: 'user', content: 'fix the cache bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_exec_1', 'exec', { command })],
    },
    {
      role: 'user',
      content: [toolResult('tu_exec_1', 'exec', resultText)],
    },
  ];
}

function runTestsSession(resultText) {
  return [
    { role: 'user', content: 'fix the cache bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_rt_1', 'run_tests', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_rt_1', 'run_tests', resultText)],
    },
  ];
}

// ── coding verification evidence ────────────────────────────────────────────

test('coding gate passes when no edits', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      response: 'done',
      messages: [{ role: 'user', content: 'fix the login bug' }],
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate passes when edits + run_tests', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'fixed',
      messages: [{ role: 'user', content: 'fix the cache bug' }],
      totalToolCalls: 4,
      toolCallsByName: { edit_file: 2, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate passes when edits + exec npm test (verification command)', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'fixed',
      messages: execSession('npm test'),
      totalToolCalls: 3,
      toolCallsByName: { write_file: 1, exec: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate rejects edits + non-verification exec (echo hi)', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'fixed',
      messages: execSession('echo hi'),
      totalToolCalls: 3,
      toolCallsByName: { write_file: 1, exec: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /without verification/);
  assert.match(r.correction, /run_tests/);
});

test('coding gate rejects edit without verification on fix intent', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 2,
      response: 'All done, the bug is fixed.',
      messages: [{ role: 'user', content: 'fix the pre-abort child process bug' }],
      totalToolCalls: 2,
      toolCallsByName: { edit_file: 1, read_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /without verification/);
  assert.match(r.correction, /run_tests/);
  assert.equal(r.retryLimit, 1);
});

test('coding gate does not fire for non-coding chat', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      response: 'here is a note',
      messages: [{ role: 'user', content: 'write a short README note' }],
      totalToolCalls: 1,
      toolCallsByName: { write_file: 1 },
    }),
  );
  // "write" alone is not CODING_CHANGE_RE without fix/implement/refactor/test
  assert.equal(r.ok, true);
});

test('coding gate passes when user asks to skip tests', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 2,
      response: 'Updated the copy.',
      messages: [{ role: 'user', content: 'fix the typo in the banner, 不要跑测试' }],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

// ── todo gate ───────────────────────────────────────────────────────────────

test('extractLatestTodosFromMessages parses checklist', () => {
  const text = [
    '1. ✓ Read auth module [completed]',
    '2. ◐ Fix null check [in_progress]',
    '3. ○ Add regression test [pending]',
    '',
    'Progress: 1/3 complete.',
  ].join('\n');
  const todos = extractLatestTodosFromMessages(todoMessages(text));
  assert.ok(todos);
  assert.equal(todos.length, 3);
  assert.equal(todos[1].status, 'in_progress');
  assert.equal(todos[2].status, 'pending');
});

test('todo gate rejects open multi-item checklist with retryLimit 2', () => {
  const text = [
    '1. ✓ Read auth module [completed]',
    '2. ◐ Fix null check [in_progress]',
    '3. ○ Add regression test [pending]',
    '',
    'Progress: 1/3 complete.',
  ].join('\n');
  const r = evaluateTodoCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, the bug is fixed.',
      messages: todoMessages(text),
      totalToolCalls: 5,
      toolCallsByName: { todo_write: 2, edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete todos');
  assert.match(r.correction, /open item/);
  assert.equal(r.retryLimit, 2);
});

test('todo gate passes when all items completed', () => {
  const text = [
    '1. ✓ Read auth module [completed]',
    '2. ✓ Fix null check [completed]',
    '',
    'Progress: 2/2 complete.',
  ].join('\n');
  const r = evaluateTodoCompletionGate(
    baseReq({
      turn: 4,
      response: 'Fixed and verified.',
      messages: todoMessages(text),
      totalToolCalls: 5,
      toolCallsByName: { todo_write: 2, edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('todo gate passes when response admits remaining work', () => {
  const text = [
    '1. ✓ Step A [completed]',
    '2. ○ Step B [pending]',
    '',
    'Progress: 1/2 complete.',
  ].join('\n');
  const r = evaluateTodoCompletionGate(
    baseReq({
      turn: 3,
      response: 'Step A is done; remaining work is Step B next.',
      messages: todoMessages(text),
      totalToolCalls: 3,
      toolCallsByName: { todo_write: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

// ── verification outcome ────────────────────────────────────────────────────

test('outcome gate rejects success claim after run_tests FAIL', () => {
  const failText = [
    '❌ 2 FAILED',
    'Command: npm test',
    'Total: 10  Passed: 8  Failed: 2',
    'Failure: auth.spec.mjs > rejects empty email',
  ].join('\n');
  const r = evaluateVerificationOutcomeGate(
    baseReq({
      turn: 5,
      response: 'All tests passed. The bug is fixed.',
      messages: runTestsSession(failText),
      totalToolCalls: 4,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /verification failed|red verification|failed verification/i);
  assert.match(r.correction, /FAILED|fail/i);
  assert.equal(r.retryLimit, 1);
});

test('outcome gate passes when response admits failure', () => {
  const failText = '❌ 1 FAILED\nFailure: foo';
  const r = evaluateVerificationOutcomeGate(
    baseReq({
      turn: 5,
      response: 'Tests still failing on foo; need another pass.',
      messages: runTestsSession(failText),
      totalToolCalls: 4,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('outcome gate passes when verification succeeded', () => {
  const passText = '✅ ALL PASSED\nTotal: 10  Passed: 10  Failed: 0';
  const r = evaluateVerificationOutcomeGate(
    baseReq({
      turn: 5,
      response: 'All tests passed.',
      messages: runTestsSession(passText),
      totalToolCalls: 4,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

// ── failure-driven ──────────────────────────────────────────────────────────

test('failure-driven gate rejects done claim after Error tool_result', () => {
  const messages = [
    { role: 'user', content: 'fix the login bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_edit', 'edit_file', { path: 'a.ts' })],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_edit',
          'edit_file',
          'Error: old_string not found in a.ts (file may have changed)',
        ),
      ],
    },
  ];
  const r = evaluateFailureDrivenGate(
    baseReq({
      turn: 3,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /unresolved tool failure|tool failure/i);
  assert.match(r.correction, /Error:/);
});

test('failure-driven gate passes when response acknowledges error', () => {
  const messages = [
    { role: 'user', content: 'fix the login bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_edit', 'edit_file', { path: 'a.ts' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_edit', 'edit_file', 'Error: old_string not found')],
    },
  ];
  const r = evaluateFailureDrivenGate(
    baseReq({
      turn: 3,
      response: 'edit_file failed with Error: old_string not found; retrying with a fresh read.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

// ── chain ───────────────────────────────────────────────────────────────────

test('createCliCompletionGate chains extra gate', async () => {
  const gate = createCliCompletionGate(async () => ({
    ok: false,
    reason: 'extra',
    retryLimit: 0,
  }));
  const r = await gate(
    baseReq({
      response: 'ok',
      messages: [{ role: 'user', content: 'hello' }],
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'extra');
});

test('createCliCompletionGate prioritizes incomplete todos over coding gate', async () => {
  const text = [
    '1. ✓ Plan [completed]',
    '2. ○ Implement [pending]',
    '3. ○ Verify [pending]',
    '',
    'Progress: 1/3 complete.',
  ].join('\n');
  const gate = createCliCompletionGate();
  const r = await gate(
    baseReq({
      turn: 2,
      response: 'Done.',
      messages: [{ role: 'user', content: 'fix the login bug' }, ...todoMessages(text)],
      totalToolCalls: 3,
      toolCallsByName: { todo_write: 1, edit_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete todos');
});

test('createCliCompletionGate runs outcome after coding evidence ok', async () => {
  const failText = '❌ 1 FAILED\nFailure: bar';
  const gate = createCliCompletionGate();
  const r = await gate(
    baseReq({
      turn: 4,
      response: '全部通过，bug is fixed.',
      messages: runTestsSession(failText),
      totalToolCalls: 3,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /verification failed|red verification|failed verification/i);
});

// ── debug investigation (blind edit) ────────────────────────────────────────

test('debug gate rejects fix intent edit with zero investigation tools', () => {
  const r = evaluateDebugInvestigationGate(
    baseReq({
      turn: 2,
      response: 'All done, the bug is fixed.',
      messages: [{ role: 'user', content: 'fix the null pointer bug in auth' }],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /without investigation/i);
  assert.match(r.correction, /read_file|search_code|reproduce/i);
});

test('debug gate passes when read_file was used', () => {
  const r = evaluateDebugInvestigationGate(
    baseReq({
      turn: 3,
      response: 'Fixed after reading the stack.',
      messages: [{ role: 'user', content: 'fix the null pointer bug' }],
      totalToolCalls: 2,
      toolCallsByName: { read_file: 1, edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('debug gate passes for implement intent without fix/bug words', () => {
  const r = evaluateDebugInvestigationGate(
    baseReq({
      turn: 2,
      response: 'Added the helper.',
      messages: [{ role: 'user', content: 'implement a small helper in utils' }],
      totalToolCalls: 1,
      toolCallsByName: { write_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('debug gate passes when user says known one-line fix', () => {
  const r = evaluateDebugInvestigationGate(
    baseReq({
      turn: 2,
      response: 'Applied the known one-line fix.',
      messages: [{ role: 'user', content: 'fix typo — known fix, one-line change in banner' }],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});
