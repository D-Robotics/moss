import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCodingCompletionGate,
  evaluateTodoCompletionGate,
  evaluateVerificationOutcomeGate,
  evaluateFailureDrivenGate,
  evaluateDebugInvestigationGate,
  evaluateRunningBackgroundVerifyGate,
  evaluateRunningBackgroundSubagentGate,
  evaluateFanOutMergeGate,
  evaluateSkillLoadCompletionGate,
  evaluateMemoryCompletionGate,
  evaluateAskUserCompletionGate,
  evaluatePlanEvalCompletionGate,
  evaluateBrowserVisionCompletionGate,
  evaluateDeviceCompletionGate,
  evaluateWebToolsCompletionGate,
  evaluateInventedVerificationCompletionGate,
  evaluateInventedEditCompletionGate,
  evaluateInventedGitCompletionGate,
  extractLatestTodosFromMessages,
  hasFreshGreenVerificationAfterLastEdit,
  createCliCompletionGate,
} from '../dist/cli/coding-completion-gate.js';import {
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





test('coding gate rejects done after create_subagent fix without suite evidence', () => {
  const messages = [
    { role: 'user', content: 'fix the login null pointer bug' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_c', 'create_subagent', { task: 'fix auth null', scope: 'full' }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_c',
          'create_subagent',
          '[Sub-agent ab12] SUCCESS\nscope: full\n\nI edited auth.ts and fixed the null check.\n',
        ),
      ],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { create_subagent: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /delegated mutation/i);
});

test('coding gate rejects done after subagent_status without suite evidence', () => {
  const messages = [
    { role: 'user', content: 'fix the login bug in the background' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_c', 'create_subagent', { task: 'fix auth', background: true }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('tu_c', 'create_subagent', '[Sub-agent task t1] STARTED\n'),
      ],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_s', 'subagent_status', { taskId: 't1', wait: true })],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_s',
          'subagent_status',
          '[Sub-agent task t1] SUCCESS\nstatus: completed\n\nEdited auth.ts and fixed the bug.\n',
        ),
      ],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { create_subagent: 1, subagent_status: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /delegated mutation/i);
});

test('coding gate accepts done when subagent_status summary has green tests', () => {
  const messages = [
    { role: 'user', content: 'fix the login bug in the background' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_c', 'create_subagent', { task: 'fix auth', background: true }),
      ],
    },
    {
      role: 'user',
      content: [toolResult('tu_c', 'create_subagent', '[Sub-agent task t1] STARTED\n')],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_s', 'subagent_status', { taskId: 't1', wait: true })],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_s',
          'subagent_status',
          '[Sub-agent task t1] SUCCESS\n\nFixed. Test Results: ✅ ALL PASSED\n',
        ),
      ],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { create_subagent: 1, subagent_status: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate rejects parent done after fan_out implement without suite evidence', () => {
  const fanOutText = [
    '[fan_out_subagents] 2 sub-agents ran concurrently — 2 ok, 0 failed.',
    '',
    '### [fix-auth] SUCCESS (scope: full)',
    'I edited auth.ts and fixed the null check.',
    '### [fix-session] SUCCESS (scope: full)',
    'Updated session store.',
  ].join('\n');
  const messages = [
    { role: 'user', content: 'fix the login null pointer bugs in parallel' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_fo', 'fan_out_subagents', {
          tasks: [{ task: 'fix auth null', label: 'fix-auth' }, { task: 'fix session', label: 'fix-session' }],
        }),
      ],
    },
    {
      role: 'user',
      content: [toolResult('tu_fo', 'fan_out_subagents', fanOutText)],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'All done. Both bugs are fixed.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { fan_out_subagents: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /delegated mutation/i);
  assert.match(r.correction, /run_tests|verify_fix|child summaries/i);
});

test('coding gate accepts parent done when fan_out summary includes green tests', () => {
  const fanOutText = [
    '[fan_out_subagents] 2 sub-agents ran concurrently — 2 ok, 0 failed.',
    '',
    '### [fix-auth] SUCCESS (scope: full)',
    'Fixed auth. Test Results: ✅ ALL PASSED',
    '### [fix-session] SUCCESS (scope: full)',
    'Fixed session. Tests: ✅ pass',
  ].join('\n');
  const messages = [
    { role: 'user', content: 'fix the login null pointer bugs in parallel' },
    {
      role: 'assistant',
      content: [toolUse('tu_fo', 'fan_out_subagents', { tasks: [{ task: 'a' }, { task: 'b' }] })],
    },
    {
      role: 'user',
      content: [toolResult('tu_fo', 'fan_out_subagents', fanOutText)],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 3,
      response: 'All done. Both bugs are fixed.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { fan_out_subagents: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

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











test('coding gate rejects exec npm run check alone after fix edit', () => {
  const messages = [
    { role: 'user', content: 'fix the null pointer bug in auth' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_x', 'exec', { command: 'npm run check' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_x', 'exec', 'exit_code: 0\nlint ok\n')],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { edit_file: 1, exec: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /diagnostics-only|without verification/i);
});

test('coding gate rejects exec tsc alone after fix edit', () => {
  const messages = [
    { role: 'user', content: 'fix the null pointer bug in auth' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_x', 'exec', { command: 'npx tsc --noEmit' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_x', 'exec', 'exit_code: 0\n')],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { edit_file: 1, exec: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /diagnostics-only|without verification/i);
  assert.match(r.correction, /run_tests|npm test|test command/i);
});

test('coding gate accepts exec npm test after fix edit', () => {
  const messages = [
    { role: 'user', content: 'fix the null pointer bug in auth' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_x', 'exec', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_x', 'exec', 'exit_code: 0\nall tests passed\n')],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { edit_file: 1, exec: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate rejects verify_fix with Tests skipped after fix edit', () => {
  const messages = [
    { role: 'user', content: 'fix the null pointer bug in auth' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_v', 'verify_fix', {})],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_v',
          'verify_fix',
          'Verify Fix: ✅ ALL PASSED\nBuild: ⏭ skipped | Typecheck: ✅ pass | Tests: ⏭ skipped\nDuration: 10ms\n',
        ),
      ],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { edit_file: 1, verify_fix: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /diagnostics-only|without verification/i);
  assert.match(r.correction, /run_tests|test command|Tests skipped/i);
});

test('coding gate rejects diagnostics-only green after fix edit', () => {
  const messages = [
    { role: 'user', content: 'fix the null pointer bug in auth' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_d', 'code_diagnostics', {})],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_d',
          'code_diagnostics',
          'Command: tsc --noEmit\nVia: package\n\nResult: PASS\nExit: 0\nDiagnostics: none\n',
        ),
      ],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 4,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { edit_file: 1, code_diagnostics: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /diagnostics-only|without verification/i);
  assert.match(r.correction, /run_tests|verify_fix|npm test/i);
});

test('coding gate accepts run_tests after fix even if diagnostics also ran', () => {
  const messages = [
    { role: 'user', content: 'fix the null pointer bug in auth' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_d', 'code_diagnostics', {})],
    },
    {
      role: 'user',
      content: [
        toolResult('tu_d', 'code_diagnostics', 'Result: PASS\nExit: 0\nDiagnostics: none\n'),
      ],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_t', 'run_tests', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_t', 'run_tests', 'Test Results: ✅ ALL PASSED\n')],
    },
  ];
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 5,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 3,
      toolCallsByName: { edit_file: 1, code_diagnostics: 1, run_tests: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('coding gate treats move_file as an edit requiring verification', () => {
  const r = evaluateCodingCompletionGate(
    baseReq({
      turn: 2,
      response: 'All done, the bug is fixed.',
      messages: [
        { role: 'user', content: 'fix the import path bug' },
        {
          role: 'assistant',
          content: [toolUse('tu_m', 'move_file', { source: 'a.ts', destination: 'b.ts' })],
        },
        { role: 'user', content: [toolResult('tu_m', 'move_file', 'Moved a.ts -> b.ts')] },
      ],
      totalToolCalls: 1,
      toolCallsByName: { move_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /without verification|stale verification/i);
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





test('running bg subagent gate rejects success claim after subagent_stop without suite', () => {
  const messages = [
    { role: 'user', content: 'fix the bug in the background' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_c', 'create_subagent', { task: 'fix auth', background: true }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_c',
          'create_subagent',
          '[Sub-agent task session/sub-abc] STARTED\n',
        ),
      ],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_stop', 'subagent_stop', { taskId: 'session/sub-abc' })],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_stop',
          'subagent_stop',
          '[Sub-agent task session/sub-abc] STOPPED\nstatus: cancelled\n\nTask cancelled.\n',
        ),
      ],
    },
  ];
  const r = evaluateRunningBackgroundSubagentGate(
    baseReq({
      turn: 3,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { create_subagent: 1, subagent_stop: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /stopped without success/i);
  assert.match(r.correction, /cancelled|run_tests|incomplete/i);
});

test('running bg subagent gate allows cancelled claim after subagent_stop', () => {
  const messages = [
    { role: 'user', content: 'fix the bug in the background' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_c', 'create_subagent', { task: 'fix auth', background: true }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('tu_c', 'create_subagent', '[Sub-agent task session/sub-abc] STARTED\n'),
      ],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_stop', 'subagent_stop', { taskId: 'session/sub-abc' })],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_stop',
          'subagent_stop',
          '[Sub-agent task session/sub-abc] STOPPED\nstatus: cancelled\n',
        ),
      ],
    },
  ];
  const r = evaluateRunningBackgroundSubagentGate(
    baseReq({
      turn: 3,
      response: 'I stopped the sub-agent; the fix is incomplete / cancelled.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { create_subagent: 1, subagent_stop: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('running bg subagent gate rejects done while create_subagent still STARTED', () => {
  const messages = [
    { role: 'user', content: 'fix the bug in the background' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_c', 'create_subagent', { task: 'fix auth', background: true }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('tu_c', 'create_subagent', '[Sub-agent task session/sub-abc123] STARTED\n\nThe sub-agent is running…\n'),
      ],
    },
  ];
  const r = evaluateRunningBackgroundSubagentGate(
    baseReq({
      turn: 2,
      response: 'All done. The bug is fixed.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { create_subagent: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /background subagent still running/i);
  assert.match(r.correction, /subagent_status|wait=true|STARTED/i);
});

test('running bg subagent gate passes after terminal subagent_status', () => {
  const messages = [
    { role: 'user', content: 'fix the bug in the background' },
    {
      role: 'assistant',
      content: [
        toolUse('tu_c', 'create_subagent', { task: 'fix auth', background: true }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('tu_c', 'create_subagent', '[Sub-agent task session/sub-abc123] STARTED\n'),
      ],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_s', 'subagent_status', { taskId: 'session/sub-abc123', wait: true })],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_s',
          'subagent_status',
          '[Sub-agent task session/sub-abc123] SUCCESS\n\nFixed. Test Results: ✅ ALL PASSED\n',
        ),
      ],
    },
  ];
  const r = evaluateRunningBackgroundSubagentGate(
    baseReq({
      turn: 4,
      response: 'All done.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { create_subagent: 1, subagent_status: 1 },
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



test('outcome gate rejects done after red tests then diagnostics pass', () => {
  const messages = [
    { role: 'user', content: 'fix the login bug' },
    {
      role: 'assistant',
      content: [toolUse('tu_e', 'edit_file', { path: 'a.ts' })],
    },
    { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
    {
      role: 'assistant',
      content: [toolUse('tu_rt', 'run_tests', { command: 'npm test' })],
    },
    {
      role: 'user',
      content: [
        toolResult('tu_rt', 'run_tests', 'Test Results: ❌ 1 FAILED\n', {
          is_error: true,
          outcome: 'error',
        }),
      ],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_d', 'code_diagnostics', {})],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_d',
          'code_diagnostics',
          'Result: PASS\nExit: 0\nDiagnostics: none\n',
        ),
      ],
    },
  ];
  const r = evaluateVerificationOutcomeGate(
    baseReq({
      turn: 5,
      response: 'All done, the bug is fixed.',
      messages,
      totalToolCalls: 3,
      toolCallsByName: { edit_file: 1, run_tests: 1, code_diagnostics: 1 },
    }),
  );
  assert.equal(r.ok, false, 'diagnostics pass must not clear red run_tests for outcome gate');
  assert.match(r.reason, /verification failed/i);
  assert.match(r.correction, /runtime verification|code_diagnostics|tsc|red/i);
});

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



test('fan-out merge gate rejects done after subagent_status FAILED', () => {
  const messages = [
    { role: 'user', content: 'fix the bug via a background subagent' },
    {
      role: 'assistant',
      content: [toolUse('tu_c', 'create_subagent', { task: 'fix x', background: true })],
    },
    {
      role: 'user',
      content: [toolResult('tu_c', 'create_subagent', '[Sub-agent task t1] STARTED\n')],
    },
    {
      role: 'assistant',
      content: [toolUse('tu_s', 'subagent_status', { taskId: 't1', wait: true })],
    },
    {
      role: 'user',
      content: [
        toolResult(
          'tu_s',
          'subagent_status',
          'Error: [Sub-agent task t1] FAILED\nstatus: failed\n\n(no output)\n(empty output treated as failure)\n',
          { is_error: true },
        ),
      ],
    },
  ];
  const r = evaluateFanOutMergeGate(
    baseReq({
      turn: 4,
      response: 'All done. The bug is fixed.',
      messages,
      totalToolCalls: 2,
      toolCallsByName: { create_subagent: 1, subagent_status: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /fan-out|FAILED|children/i);
});

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

test('debug gate allows mid-run implement edit without claiming done', () => {
  const r = evaluateDebugInvestigationGate(
    baseReq({
      turn: 2,
      response: 'Looking at the next file next.',
      messages: [
        { role: 'user', content: 'implement multi_edit path headlines for the TUI' },
        {
          role: 'assistant',
          content: [toolUse('tu_e', 'edit_file', { path: 'tui.ts' })],
        },
        { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
      ],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('debug gate rejects implement intent finish without investigation', () => {
  const r = evaluateDebugInvestigationGate(
    baseReq({
      turn: 3,
      response: 'All done. Feature implemented.',
      messages: [
        { role: 'user', content: 'implement multi_edit path headlines for the TUI' },
        {
          role: 'assistant',
          content: [toolUse('tu_e', 'edit_file', { path: 'tui.ts' })],
        },
        { role: 'user', content: [toolResult('tu_e', 'edit_file', 'ok')] },
      ],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /without investigation/i);
  assert.match(r.correction, /implement|locate|search_code|read_file/i);
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


// ── skill install without load ──────────────────────────────────────────────

test('skill load completion gate rejects claim skill loaded without load_skill', () => {
  const r = evaluateSkillLoadCompletionGate(
    baseReq({
      turn: 2,
      response: 'The skill is loaded and ready for this task.',
      messages: [{ role: 'user', content: 'install the coding skill from skillhub' }],
      totalToolCalls: 1,
      toolCallsByName: { skillhub_install: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /skill installed without load/i);
  assert.match(r.correction, /load_skill/i);
});

test('skill load completion gate allows install for future sessions only', () => {
  const r = evaluateSkillLoadCompletionGate(
    baseReq({
      turn: 2,
      response: 'Installed for future sessions only; I did not load it this turn.',
      messages: [{ role: 'user', content: 'install the skill for later' }],
      totalToolCalls: 1,
      toolCallsByName: { install_skill: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('skill load completion gate allows unrelated done after install without skill claim', () => {
  const r = evaluateSkillLoadCompletionGate(
    baseReq({
      turn: 2,
      response: 'All done. The helper is implemented.',
      messages: [{ role: 'user', content: 'also install a skill for later, then implement a helper' }],
      totalToolCalls: 2,
      toolCallsByName: { install_skill: 1, edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true, 'generic done without skill-loaded claim should not fire skill gate');
});

test('skill load completion gate passes when load_skill was used'
, () => {
  const r = evaluateSkillLoadCompletionGate(
    baseReq({
      turn: 3,
      response: 'Skill is loaded and I am following it.',
      messages: [{ role: 'user', content: 'install and use the skill' }],
      totalToolCalls: 2,
      toolCallsByName: { skillhub_install: 1, load_skill: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


test('skill load completion gate rejects claim installed after search only', () => {
  const r = evaluateSkillLoadCompletionGate(
    baseReq({
      turn: 2,
      response: 'I installed the coding skill and it is ready.',
      messages: [{ role: 'user', content: 'find a coding skill on skillhub' }],
      totalToolCalls: 1,
      toolCallsByName: { skillhub_search: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /search without install/i);
  assert.match(r.correction, /skillhub_install|load_skill/i);
});

test('skill load completion gate allows search-only when admitting search only', () => {
  const r = evaluateSkillLoadCompletionGate(
    baseReq({
      turn: 2,
      response: 'I only searched SkillHub; here are the hits. I did not install yet.',
      messages: [{ role: 'user', content: 'search skillhub for ros' }],
      totalToolCalls: 1,
      toolCallsByName: { skillhub_search: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


// ── memory honesty ──────────────────────────────────────────────────────────

test('memory completion gate rejects claimed store without memory_write', () => {
  const r = evaluateMemoryCompletionGate(
    baseReq({
      turn: 2,
      response: 'I stored in memory that you prefer short answers.',
      messages: [{ role: 'user', content: 'remember that I prefer short answers' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /memory write without memory_write/i);
  assert.match(r.correction, /memory_write/i);
});

test('memory completion gate passes when memory_write was used', () => {
  const r = evaluateMemoryCompletionGate(
    baseReq({
      turn: 2,
      response: 'Stored in memory: prefer short answers.',
      messages: [{ role: 'user', content: 'remember short answers' }],
      totalToolCalls: 1,
      toolCallsByName: { memory_write: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('memory completion gate rejects claimed delete without memory_delete', () => {
  const r = evaluateMemoryCompletionGate(
    baseReq({
      turn: 2,
      response: 'I deleted the memory entry.',
      messages: [{ role: 'user', content: 'delete that memory' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /memory delete without memory_delete/i);
});


// ── ask_user_question honesty ───────────────────────────────────────────────

test('ask_user completion gate rejects invented user choice without tool', () => {
  const r = evaluateAskUserCompletionGate(
    baseReq({
      turn: 2,
      response: 'You chose option A (Redis). I will implement that next.',
      messages: [{ role: 'user', content: 'pick a cache' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /user choice without ask_user_question/i);
  assert.match(r.correction, /ask_user_question|assumption/i);
});

test('ask_user completion gate allows stated assumption without tool', () => {
  const r = evaluateAskUserCompletionGate(
    baseReq({
      turn: 2,
      response: 'Assuming Redis (I did not ask). Proceeding with that approach.',
      messages: [{ role: 'user', content: 'pick a cache' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, true);
});

test('ask_user completion gate passes when ask_user_question was used', () => {
  const r = evaluateAskUserCompletionGate(
    baseReq({
      turn: 2,
      response: 'You selected Redis. Implementing now.',
      messages: [{ role: 'user', content: 'pick a cache' }],
      totalToolCalls: 1,
      toolCallsByName: { ask_user_question: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


// ── plan/eval/structured honesty ────────────────────────────────────────────

test('plan eval completion gate rejects claimed plan complete without plan tools', () => {
  const r = evaluatePlanEvalCompletionGate(
    baseReq({
      turn: 2,
      response: 'The plan is complete and all steps are done.',
      messages: [{ role: 'user', content: 'execute the migration plan' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /plan complete without plan tools/i);
  assert.match(r.correction, /plan_step|prose outline/i);
});

test('plan eval completion gate allows prose outline without plan tools', () => {
  const r = evaluatePlanEvalCompletionGate(
    baseReq({
      turn: 2,
      response: 'Prose plan only (no formal plan tools): 1) migrate, 2) verify.',
      messages: [{ role: 'user', content: 'outline a plan' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, true);
});

test('plan eval completion gate rejects claimed eval passed without eval', () => {
  const r = evaluatePlanEvalCompletionGate(
    baseReq({
      turn: 2,
      response: 'Eval suite passed — all green.',
      messages: [{ role: 'user', content: 'run the eval suite' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /eval passed without eval/i);
});

test('plan eval completion gate passes when plan tools were used', () => {
  const r = evaluatePlanEvalCompletionGate(
    baseReq({
      turn: 3,
      response: 'Plan execution complete!',
      messages: [{ role: 'user', content: 'run the plan' }],
      totalToolCalls: 2,
      toolCallsByName: { plan: 1, plan_step: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


// ── browser/vision honesty ──────────────────────────────────────────────────

test('browser vision completion gate rejects invented browser click without tools', () => {
  const r = evaluateBrowserVisionCompletionGate(
    baseReq({
      turn: 2,
      response: 'I clicked the login button and filled the form.',
      messages: [{ role: 'user', content: 'log into the site' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /browser action without browser tools/i);
});

test('browser vision completion gate rejects invented vision analysis without tools', () => {
  const r = evaluateBrowserVisionCompletionGate(
    baseReq({
      turn: 2,
      response: 'I analyzed the screenshot — the UI shows an error banner.',
      messages: [{ role: 'user', content: 'what is on screen?' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /vision\/screenshot without vision tools/i);
});

test('browser vision completion gate passes when browser tools were used', () => {
  const r = evaluateBrowserVisionCompletionGate(
    baseReq({
      turn: 2,
      response: 'I clicked submit after filling the form.',
      messages: [{ role: 'user', content: 'submit the form' }],
      totalToolCalls: 1,
      toolCallsByName: { web_browser_control: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


// ── device/fleet honesty ────────────────────────────────────────────────────

test('device completion gate rejects invented board exec without tools', () => {
  const r = evaluateDeviceCompletionGate(
    baseReq({
      turn: 2,
      response: 'I ran on the board: uname -a. Board reports Linux aarch64.',
      messages: [{ role: 'user', content: 'check the RDK board kernel' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /device action without device tools/i);
  assert.match(r.correction, /device_|fleet_batch/i);
});

test('device completion gate passes when device_exec was used', () => {
  const r = evaluateDeviceCompletionGate(
    baseReq({
      turn: 2,
      response: 'On the board I ran uname -a successfully.',
      messages: [{ role: 'user', content: 'check kernel' }],
      totalToolCalls: 1,
      toolCallsByName: { device_exec: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('device completion gate allows admitting no board tools', () => {
  const r = evaluateDeviceCompletionGate(
    baseReq({
      turn: 2,
      response: 'I did not run on the board; please connect first.',
      messages: [{ role: 'user', content: 'check board' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, true);
});


// ── web research honesty ────────────────────────────────────────────────────

test('web tools completion gate rejects invented web search without tools', () => {
  const r = evaluateWebToolsCompletionGate(
    baseReq({
      turn: 2,
      response: 'I searched the web and found https://example.com/docs — the official site says X.',
      messages: [{ role: 'user', content: 'search the web for docs' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /web evidence without web tools/i);
  assert.match(r.correction, /web_search|web_fetch/i);
});

test('web tools completion gate allows local-knowledge-only admission', () => {
  const r = evaluateWebToolsCompletionGate(
    baseReq({
      turn: 2,
      response: 'From local knowledge only (I did not search): X.',
      messages: [{ role: 'user', content: 'what is X?' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, true);
});

test('web tools completion gate passes when web_search was used', () => {
  const r = evaluateWebToolsCompletionGate(
    baseReq({
      turn: 2,
      response: 'I searched the web; top hit is useful.',
      messages: [{ role: 'user', content: 'search the web' }],
      totalToolCalls: 1,
      toolCallsByName: { web_search: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


// ── invented verification honesty ───────────────────────────────────────────

test('invented verification gate rejects tests-passed claim without verify tools', () => {
  const r = evaluateInventedVerificationCompletionGate(
    baseReq({
      turn: 2,
      response: 'All tests passed. The bug is fixed.',
      messages: [{ role: 'user', content: 'is it fixed?' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /claimed verification without verification tools/i);
  assert.match(r.correction, /run_tests|verify_fix|code_diagnostics/i);
});

test('invented verification gate allows admitting tests not run', () => {
  const r = evaluateInventedVerificationCompletionGate(
    baseReq({
      turn: 2,
      response: 'I did not run tests yet; still looking.',
      messages: [{ role: 'user', content: 'status?' }],
      totalToolCalls: 1,
      toolCallsByName: { read_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('invented verification gate passes when run_tests was used', () => {
  const r = evaluateInventedVerificationCompletionGate(
    baseReq({
      turn: 2,
      response: 'All tests passed.',
      messages: [{ role: 'user', content: 'run tests' }],
      totalToolCalls: 1,
      toolCallsByName: { run_tests: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


// ── invented file mutation honesty ──────────────────────────────────────────

test('invented edit gate rejects claimed file write without edit tools', () => {
  const r = evaluateInventedEditCompletionGate(
    baseReq({
      turn: 2,
      response: 'I edited auth.ts and fixed the null check. All done.',
      messages: [{ role: 'user', content: 'fix auth' }],
      totalToolCalls: 1,
      toolCallsByName: { read_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /claimed file edit without edit tools/i);
  assert.match(r.correction, /edit_file|write_file|apply_patch/i);
});

test('invented edit gate allows analysis-only admission', () => {
  const r = evaluateInventedEditCompletionGate(
    baseReq({
      turn: 2,
      response: 'I only analyzed auth.ts; I did not edit any files.',
      messages: [{ role: 'user', content: 'look at auth' }],
      totalToolCalls: 1,
      toolCallsByName: { read_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

test('invented edit gate passes when edit_file was used', () => {
  const r = evaluateInventedEditCompletionGate(
    baseReq({
      turn: 2,
      response: 'I edited auth.ts.',
      messages: [{ role: 'user', content: 'fix auth' }],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, true);
});


// ── invented git honesty ────────────────────────────────────────────────────

test('invented git gate rejects claimed commit without git exec', () => {
  const r = evaluateInventedGitCompletionGate(
    baseReq({
      turn: 2,
      response: 'I committed the changes and pushed to origin. All done.',
      messages: [{ role: 'user', content: 'commit and push' }],
      totalToolCalls: 1,
      toolCallsByName: { edit_file: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /claimed git action without git exec/i);
  assert.match(r.correction, /git|gh pr/i);
});

test('invented git gate allows admitting no commit', () => {
  const r = evaluateInventedGitCompletionGate(
    baseReq({
      turn: 2,
      response: 'I did not commit yet; waiting for your go-ahead.',
      messages: [{ role: 'user', content: 'status?' }],
      totalToolCalls: 0,
      toolCallsByName: {},
    }),
  );
  assert.equal(r.ok, true);
});

test('invented git gate passes when exec ran git commit', () => {
  const messages = [
    { role: 'user', content: 'commit' },
    {
      role: 'assistant',
      content: [toolUse('tu_g', 'exec', { command: 'git commit -m "fix"' })],
    },
    {
      role: 'user',
      content: [toolResult('tu_g', 'exec', 'exit_code: 0\n[main abc] fix\n')],
    },
  ];
  const r = evaluateInventedGitCompletionGate(
    baseReq({
      turn: 2,
      response: 'I committed the changes.',
      messages,
      totalToolCalls: 1,
      toolCallsByName: { exec: 1 },
    }),
  );
  assert.equal(r.ok, true);
});
