#!/usr/bin/env node
/**
 * O96 — loop guard must not treat normal lint/test non-zero exits as a broken
 * exec tool. Real faults (timeout / start failure) still block; same-command
 * identical-output streaks hint to change code/command without STOP wording.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createToolLoopGuardState,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
  formatToolLoopGuardMessage,
  classifyShellToolFailure,
  normalizeVerifyCommandSignature,
} from '../dist/core/tools/tool-loop-guard.js';

const LINT_FAIL = 'Command failed (exit 1):\neslint: 3 errors\n';
const LINT_FAIL_ALT = 'Command failed (exit 1):\neslint: 5 errors (different)\n';
const TEST_FAIL =
  'Test Results: ❌ 2 FAILED\nCommand: npm test\nTests: 2 total, 0 passed, 2 failed\n';
const EXIT_CODE_FAIL = 'exit_code: 1\nnpm run check failed\n';
const TIMEOUT = 'timed out after 120000ms (raise timeout_ms or use exec_background)\n';
const START_FAIL = 'Execution error: spawn Sync foo ENOENT\n';
const START_FAIL_CMD = 'Command failed:\n/bin/sh: npmx: command not found\n';
const BLOCKED = 'Command blocked: dangerous rm -rf /\n';
const KILLED = 'Command killed by SIGKILL:\npartial\n';

const STOP_RE = /STOP calling|is not returning usable results|工具不可用|不要再调用/;

test('classifyShellToolFailure: normal non-zero vs real faults vs deny', () => {
  assert.equal(classifyShellToolFailure(LINT_FAIL), 'normal_nonzero');
  assert.equal(classifyShellToolFailure(EXIT_CODE_FAIL), 'normal_nonzero');
  assert.equal(classifyShellToolFailure(TEST_FAIL), 'normal_nonzero');
  assert.equal(classifyShellToolFailure(TIMEOUT), 'timeout');
  assert.equal(classifyShellToolFailure(START_FAIL), 'start_failure');
  assert.equal(classifyShellToolFailure(START_FAIL_CMD), 'start_failure');
  assert.equal(classifyShellToolFailure(KILLED), 'killed');
  assert.equal(classifyShellToolFailure(BLOCKED), 'other');
  assert.equal(classifyShellToolFailure(''), 'unusable');
  assert.equal(classifyShellToolFailure('(no output)'), 'unusable');
});

test('A: three normal lint/test non-zero execs do NOT trip global byToolFailure / STOP', () => {
  const state = createToolLoopGuardState();
  // Three different verification commands, each a normal non-zero exit.
  const cmds = [
    { command: 'npm run check' },
    { command: 'npm test' },
    { command: 'npx eslint src' },
  ];
  const results = [LINT_FAIL, TEST_FAIL, EXIT_CODE_FAIL];
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, results[i], cmds[i]);
  }
  assert.equal(
    state.byToolFailure.get('exec') ?? 0,
    0,
    'normal non-zero must not increment byToolFailure'
  );
  // Still allowed to call exec again (e.g. another check).
  const next = shouldShortCircuitToolCall(state, 'exec', { command: 'npm run lint' });
  assert.equal(next, null, 'must still allow further exec after 3 lint/test non-zeros');
  // Guard: no STOP wording could have been produced from a non-block.
  assert.equal(state.byToolFailure.get('exec'), undefined);
});

test('A-run_tests: harness FAIL banner also skips byToolFailure', () => {
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'run_tests', true, TEST_FAIL, { command: 'npm test' });
  }
  assert.equal(state.byToolFailure.get('run_tests') ?? 0, 0);
  // Same command identical output → same-command streak, not global failure.
  const blocked = shouldShortCircuitToolCall(state, 'run_tests', { command: 'npm test' });
  assert.ok(blocked, 'identical same-command streak should hint');
  assert.match(blocked, /same check failed repeatedly/i);
  assert.equal(state.byToolFailure.get('run_tests') ?? 0, 0);
  const msg = formatToolLoopGuardMessage(blocked, 'run_tests');
  assert.doesNotMatch(msg, STOP_RE);
  assert.match(msg, /同一检查连续失败|Same check failed repeatedly/i);
  assert.match(msg, /改代码|Change the code/i);
});

test('B: three timeouts still block; message says 超时 not test-failed', () => {
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, TIMEOUT, { command: `sleep ${i}` });
  }
  assert.equal(state.byToolFailure.get('exec'), 3);
  const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'sleep 99' });
  assert.ok(blocked);
  assert.match(blocked, /timed out 3 time/i);
  assert.doesNotMatch(blocked, /has failed 3 time/i);
  const msg = formatToolLoopGuardMessage(blocked, 'exec');
  assert.match(msg, /超时|timed out/i);
  assert.doesNotMatch(msg, /测试没过|lint failed/i);
});

test('B: three start failures still block; message says 未能启动', () => {
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, START_FAIL, { command: `missing-bin-${i}` });
  }
  assert.equal(state.byToolFailure.get('exec'), 3);
  const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'missing-bin-x' });
  assert.ok(blocked);
  assert.match(blocked, /failed to start 3 time/i);
  const msg = formatToolLoopGuardMessage(blocked, 'exec');
  assert.match(msg, /未能启动|failed to start/i);
});

test('C: same command identical output ≥3 → change-approach hint, no STOP', () => {
  const state = createToolLoopGuardState();
  const input = { command: 'npm run check' };
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, LINT_FAIL, input);
  }
  assert.equal(state.byToolFailure.get('exec') ?? 0, 0, 'streak must not pollute byToolFailure');
  const blocked = shouldShortCircuitToolCall(state, 'exec', input);
  assert.ok(blocked);
  assert.match(blocked, /same check failed repeatedly/);
  assert.match(blocked, /npm run check/);
  const msg = formatToolLoopGuardMessage(blocked, 'exec');
  assert.doesNotMatch(msg, STOP_RE);
  assert.match(msg, /同一检查连续失败/);
  assert.match(msg, /Same check failed repeatedly/);
  assert.match(msg, /改代码|Change the code/);
  assert.match(msg, /不要换工具绕开|do not switch tools/i);
});

test('QA isolation: after 3× same npm run check, a different exec (npm test) still runs', () => {
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, LINT_FAIL, { command: 'npm run check' });
  }
  assert.ok(shouldShortCircuitToolCall(state, 'exec', { command: 'npm run check' }));
  // Different command must still be allowed; no global STOP.
  const other = shouldShortCircuitToolCall(state, 'exec', { command: 'npm test' });
  assert.equal(other, null, 'different command must not be blocked by same-command streak');
  assert.equal(state.byToolFailure.get('exec') ?? 0, 0);
});

test('C: different output on same command resets streak (no false block)', () => {
  const state = createToolLoopGuardState();
  const input = { command: 'npm run check' };
  recordToolLoopOutcome(state, 'exec', true, LINT_FAIL, input);
  recordToolLoopOutcome(state, 'exec', true, LINT_FAIL, input);
  recordToolLoopOutcome(state, 'exec', true, LINT_FAIL_ALT, input); // different output
  assert.equal(state.bySameCommandFailure.get('exec:npm run check')?.count, 1);
  assert.equal(shouldShortCircuitToolCall(state, 'exec', input), null);
});

test('exit 0 success clears same-command streak', () => {
  const state = createToolLoopGuardState();
  const input = { command: 'npm run check' };
  recordToolLoopOutcome(state, 'exec', true, LINT_FAIL, input);
  recordToolLoopOutcome(state, 'exec', true, LINT_FAIL, input);
  recordToolLoopOutcome(state, 'exec', false, 'ok\n', input);
  assert.equal(state.bySameCommandFailure.has('exec:npm run check'), false);
});

test('QA guardrail: Command blocked is NOT normal_nonzero (still counts as fault path)', () => {
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, BLOCKED, { command: `rm -rf /tmp/x${i}` });
  }
  assert.equal(state.byToolFailure.get('exec'), 3, 'policy deny must not be treated as lint miss');
  const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'rm -rf /tmp/z' });
  assert.ok(blocked, 'three policy denies still short-circuit via byToolFailure');
});

test('normalizeVerifyCommandSignature collapses whitespace', () => {
  const a = normalizeVerifyCommandSignature('exec', { command: 'npm   run   check' });
  const b = normalizeVerifyCommandSignature('exec', { command: 'npm run check' });
  assert.equal(a?.key, b?.key);
  assert.equal(a?.display, 'npm run check');
});

test('UX: normal non-zero path never produces STOP / 工具不可用 wording', () => {
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, LINT_FAIL, { command: 'npm run check' });
  }
  const reason = shouldShortCircuitToolCall(state, 'exec', { command: 'npm run check' });
  assert.ok(reason);
  const msg = formatToolLoopGuardMessage(reason, 'exec');
  assert.doesNotMatch(msg, STOP_RE);
  assert.doesNotMatch(msg, /is not returning usable results/);
});
