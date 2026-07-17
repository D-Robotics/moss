import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCodingCompletionGate,
  evaluateTodoCompletionGate,
  evaluateVerificationOutcomeGate,
  evaluateFailureDrivenGate,
  evaluateDebugInvestigationGate,
  evaluateRunningBackgroundVerifyGate,
  evaluateFanOutMergeGate,
  extractLatestTodosFromMessages,
  hasFreshGreenVerificationAfterLastEdit,
  createCliCompletionGate,
} from '../dist/cli/coding-completion-gate.js';
import {
  clearBackgroundRegistryForTests,
} from '../dist/tools/background-exec.js';

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

/** edit then green/red verify — ordered post-condition fixtures */
function editThenVerify(resultText, opts = {}) {
  const editName = opts.editName ?? 'edit_file';
  return [
    { role: 'user', content: 'fix the cache bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_edit_1', editName, { path: 'a.ts', old_string: 'x', new_string: 'y' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_edit_1', editName, 'ok')],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_rt_1', 'run_tests', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [
        toolResult('tu_rt_1', 'run_tests', resultText, opts.is_error ? { is_error: true } : {}),
      ],
    },
  ];
}

function greenThenLaterEdit() {
  return [
    { role: 'user', content: 'fix the cache bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_edit_1', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_edit_1', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_rt_1', 'run_tests', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_rt_1', 'run_tests', 'Test Results: ✅ ALL PASSED\n')],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_edit_2', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_edit_2', 'edit_file', 'ok')] },
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

test('coding gate passes when edits then green run_tests', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'fixed',
      messages: editThenVerify('Test Results: ✅ ALL PASSED\n'),
      totalToolCalls: 4,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate passes when edits + exec npm test (verification command)', () => {
  const messages = [
    { role: 'user', content: 'fix the cache bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_w', 'write_file', { path: 'a.ts', content: 'x' })],
    },
    { role: 'user', content: [toolResult('tu_w', 'write_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_exec_1', 'exec', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_exec_1', 'exec', 'exit_code: 0\nok')],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'fixed',
      messages,
      totalToolCalls: 3,
      toolCallsByName: { write_file: 1, exec: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate rejects stale green after later edits', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 5,
      response: 'All done.',
      messages: greenThenLaterEdit(),
      totalToolCalls: 5,
      toolCallsByName: { edit_file: 2, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale verification/i);
  assert.match(r.correction, /stale|again after|re-run/i);
});

test('hasFreshGreenVerificationAfterLastEdit is false for bg start-only', () => {
  const messages = [
    { role: 'user', content: 'fix the bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_bg', 'exec_background', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_bg', 'exec_background', 'Started bg_1. Still running…')],
    },
  ];
  assert.equal(hasFreshGreenVerificationAfterLastEdit(messages), false);
});

test('hasFreshGreenVerificationAfterLastEdit is false for NO TESTS / NO STEPS', () => {
  const noTests = editThenVerify(
    'Test Results: ⚠️ NO TESTS EXECUTED\nCommand: npm test\nTests: 0 total, 0 passed, 0 failed, 0 skipped\n',
    { is_error: true },
  );
  assert.equal(hasFreshGreenVerificationAfterLastEdit(noTests), false);

  const noSteps = [
    { role: 'user', content: 'fix the cache bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_edit_1', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_edit_1', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_vf', 'verify_fix', {})],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_vf',
          'verify_fix',
          'Verify Fix: ⚠️ NO STEPS EXECUTED\nBuild: ⏭ skipped | Typecheck: ⏭ skipped | Tests: ⏭ skipped\n',
          { is_error: true },
        ),
      ],
    },
  ];
  assert.equal(hasFreshGreenVerificationAfterLastEdit(noSteps), false);
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
      messages: [
        { role: 'user', content: 'fix the pre-abort child process bug' },
        {
          role: 'assistant',
          content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
        },
        { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
      ],
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

test('coding gate rejects "did not run tests" when also claiming fixed', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 2,
      response: 'I did not run tests but the bug is fixed. All done.',
      messages: [
        { role: 'user', content: 'fix the pre-abort child process bug' },
        {
          role: 'assistant',
          content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
        },
        { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
      ],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /without verification|stale verification/i);
});

test('coding gate allows incomplete reply that admits no tests yet', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 2,
      response: 'I did not run tests yet — still working on the remaining edge case.',
      messages: [
        { role: 'user', content: 'fix the pre-abort child process bug' },
        {
          role: 'assistant',
          content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
        },
        { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
      ],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('running bg verify gate rejects done while npm test still running', async () => {
  clearBackgroundRegistryForTests();
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { execBackgroundTool } = await import('../dist/tools/background-exec.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-bg-gate-'));
  try {
    // Long-running process; command string must match VERIFY_COMMAND_RE.
    // Use sleep (allowed) with npm test as an extra arg-like token in the shell string.
    const out = await execBackgroundTool.execute(
      {
        command: process.platform === 'win32'
          ? 'ping -n 30 127.0.0.1 >nul & rem npm test'
          : 'sleep 30; true # npm test',
        settle_ms: 40,
        label: 'unit-bg-verify',
      },
      { workspaceDir: dir, sessionKey: 't', abortSignal: new AbortController().signal },
    );
    assert.match(String(out), /Still running|Started bg_|Background command/i);
    const r = evaluateRunningBackgroundVerifyGate(
      baseReq({
        turn: 3,
        response: 'All done, tests passed.',
        messages: [
          { role: 'user', content: 'fix the cache bug' },
          {
            role: 'assistant',
            content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
          },
          { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
        ],
        totalToolCalls: 2,
        toolCallsByName: { edit_file: 1, exec_background: 1 },
      }),
    );
    assert.equal(r.ok, false, `expected block, got ${JSON.stringify(r)}; startOut=${String(out).slice(0, 120)}`);
    assert.match(r.reason, /still running|background/i);
    assert.match(r.correction, /Wait|background|running/i);
  } finally {
    clearBackgroundRegistryForTests();
    await fs.rm(dir, { recursive: true, force: true });
  }
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
      messages: editThenVerify(failText, { is_error: true }),
      totalToolCalls: 4,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /verification failed|while finishing|success claimed/i);
  assert.match(r.correction, /FAILED|fail|red/i);
  assert.equal(r.retryLimit, 1);
});

test('outcome gate rejects quiet done after red verify with edits', () => {
  const r = evaluateVerificationOutcomeGate(
    baseReq({
      turn: 4,
      response: 'Done.',
      messages: editThenVerify('Test Results: ❌ 1 FAILED\n', { is_error: true }),
      totalToolCalls: 3,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /while finishing|success claimed|failed/i);
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

test('failure-driven gate honors is_error / outcome without Error: prefix', () => {
  // Non-verification tool so failure-driven owns the case (verify path uses outcome gate).
  const messages = [
    { role: 'user', content: 'fix the login bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_sc', 'search_code', { pattern: 'foo' })],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_sc',
          name: 'search_code',
          content: 'rg not found in PATH',
          is_error: true,
          outcome: 'error',
        },
      ],
    },
  ];
  const r = evaluateFailureDrivenGate(
    baseReq({
      turn: 3,
      response: 'All done, everything works.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { search_code: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /unresolved tool failure|tool failure/i);
  assert.match(r.correction, /rg not found|error/i);
});

test('outcome gate treats is_error verification exec as red', () => {
  const messages = [
    { role: 'user', content: 'fix the cache bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_ex', 'exec', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_ex',
          name: 'exec',
          content: 'Tests failed: 2 failed, 8 passed',
          is_error: true,
          outcome: 'error',
        },
      ],
    },
  ];
  const r = evaluateVerificationOutcomeGate(
    baseReq({
      turn: 4,
      response: 'All tests passed. The bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { edit_file: 1, exec: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /verification failed|success claimed/i);
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
      messages: editThenVerify(failText, { is_error: true }),
      totalToolCalls: 3,
      toolCallsByName: { edit_file: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, false);
  // Prefer coding evidence / stale path or outcome — either is a hard stop.
  assert.match(
    r.reason,
    /verification failed|while finishing|success claimed|without verification|stale verification/i,
  );
});

// ── debug investigation (blind edit) ────────────────────────────────────────

test('fan-out merge gate rejects done after failed children', () => {
  const fanOutText = [
    'Error: [fan_out_subagents] 2 sub-agents ran concurrently — 1 ok, 1 failed. Do not treat FAILED/empty children as done.',
    '',
    '### [correctness] SUCCESS',
    'looks fine',
    '### [security] FAILED',
    '(no output)',
    '(empty output treated as failure — do not invent success)',
  ].join('\n');
  const messages = [
    { role: 'user', content: 'review this PR in parallel' },
    {
      role: 'assistant',
      content: [toolUse('tu_fo', 'fan_out_subagents', { tasks: [{ task: 'a' }, { task: 'b' }] })],
    },
    {
      role: 'user',
      content: [toolResult('tu_fo', 'fan_out_subagents', fanOutText, { is_error: true })],
    },
  ];
  const r = evaluateFanOutMergeGate(
    baseReq({
      turn: 3,
      response: 'All done. Both angles finished successfully.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { fan_out_subagents: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /fan-out|FAILED|children/i);
  assert.match(r.correction, /FAILED|re-run|empty/i);
});

test('fan-out merge gate allows honest partial merge', () => {
  const fanOutText =
    'Error: [fan_out_subagents] 2 sub-agents ran concurrently — 1 ok, 1 failed. Do not treat FAILED/empty children as done.';
  const messages = [
    { role: 'user', content: 'review this PR in parallel' },
    {
      role: 'assistant',
      content: [toolUse('tu_fo', 'fan_out_subagents', { tasks: [{ task: 'a' }, { task: 'b' }] })],
    },
    {
      role: 'user',
      content: [toolResult('tu_fo', 'fan_out_subagents', fanOutText, { is_error: true })],
    },
  ];
  const r = evaluateFanOutMergeGate(
    baseReq({
      turn: 3,
      response: 'Partial: correctness succeeded; security FAILED and needs a re-run with scope=verify.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { fan_out_subagents: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

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
