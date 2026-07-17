import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCodingCompletionGate,
  evaluateTodoCompletionGate,
  extractLatestTodosFromMessages,
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

function todoMessages(resultText) {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_todo_1',
          name: 'todo_write',
          input: { todos: [] },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_todo_1',
          name: 'todo_write',
          content: resultText,
        },
      ],
    },
  ];
}

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

test('todo gate rejects open multi-item checklist', () => {
  const text = [
    '1. ✓ Read auth module [completed]',
    '2. ◐ Fix null check [in_progress]',
    '3. ○ Add regression test [pending]',
    '',
    'Progress: 1/3 complete.',
  ].join('\n');
  const r = evaluateTodoCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 4,
    response: 'All done, the bug is fixed.',
    messages: todoMessages(text),
    totalToolCalls: 5,
    toolCallsByName: { todo_write: 2, edit_file: 1, run_tests: 1 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete todos');
  assert.match(r.correction, /open item/);
  assert.equal(r.retryLimit, 1);
});

test('todo gate passes when all items completed', () => {
  const text = [
    '1. ✓ Read auth module [completed]',
    '2. ✓ Fix null check [completed]',
    '',
    'Progress: 2/2 complete.',
  ].join('\n');
  const r = evaluateTodoCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 4,
    response: 'Fixed and verified.',
    messages: todoMessages(text),
    totalToolCalls: 5,
    toolCallsByName: { todo_write: 2, edit_file: 1, run_tests: 1 },
  });
  assert.equal(r.ok, true);
});

test('todo gate passes when response admits remaining work', () => {
  const text = [
    '1. ✓ Step A [completed]',
    '2. ○ Step B [pending]',
    '',
    'Progress: 1/2 complete.',
  ].join('\n');
  const r = evaluateTodoCompletionGate({
    sessionKey: 's',
    runId: 'r',
    turn: 3,
    response: 'Step A is done; remaining work is Step B next.',
    messages: todoMessages(text),
    totalToolCalls: 3,
    toolCallsByName: { todo_write: 1 },
  });
  assert.equal(r.ok, true);
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
  const r = await gate({
    sessionKey: 's',
    runId: 'r',
    turn: 2,
    response: 'Done.',
    messages: [
      { role: 'user', content: 'fix the login bug' },
      ...todoMessages(text),
    ],
    totalToolCalls: 3,
    toolCallsByName: { todo_write: 1, edit_file: 1 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete todos');
});
