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
import {
  executeOneToolCall,
  isStringToolFailureResult,
  outcomeToResult,
} from '../dist/core/tools/execute-tool-call.js';
import { execTool } from '../dist/tools/builtin.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function execCallDeps(tools) {
  const abortController = new AbortController();
  return {
    toolsForRun: tools,
    toolCtx: { workspaceDir: process.cwd(), sessionKey: 'o96-e2e' },
    sessionKey: 'o96-e2e',
    abortSignal: abortController.signal,
    toolTimeoutMs: 30_000,
    enableHeartbeat: false,
    heartbeatIntervalMs: 60_000,
    skipHeartbeatToolNames: new Set(['exec']),
    push() {},
  };
}

test('e2e: production-shaped timed out after → is_error, byToolFailure, 超时 copy', async () => {
  // Same shape as builtin.ts ProcessError timeout (historically is_error=false).
  const PROD_TIMEOUT = 'timed out after 200ms (raise timeout_ms or use exec_background)';
  assert.equal(
    isStringToolFailureResult(PROD_TIMEOUT),
    true,
    'isStringToolFailureResult must recognize production timeout text'
  );

  const mockExec = {
    name: 'exec',
    description: 'test',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
      required: ['command'],
    },
    async execute() {
      return PROD_TIMEOUT;
    },
  };
  const deps = execCallDeps([mockExec]);
  const state = createToolLoopGuardState();

  for (let i = 0; i < 3; i++) {
    const outcome = await executeOneToolCall(
      {
        id: `t${i}`,
        name: 'exec',
        input: { command: 'sleep 5', timeout_ms: 200 },
      },
      deps
    );
    assert.equal(outcome.kind, 'completed');
    const { text, isError } = outcomeToResult(outcome);
    assert.equal(isError, true, `attempt ${i}: is_error must be true for timed out after`);
    assert.match(text, /timed out after 200ms/);
    // Feed the REAL isError from executeOneToolCall (the e2e wiring UX failed on).
    recordToolLoopOutcome(state, 'exec', isError, text, {
      command: 'sleep 5',
      timeout_ms: 200,
    });
  }

  assert.equal(state.byToolFailure.get('exec'), 3, 'byToolFailure must count real timeouts');
  assert.equal(state.lastShellFaultKind.get('exec'), 'timeout');

  const blocked = shouldShortCircuitToolCall(state, 'exec', {
    command: 'sleep 5',
    timeout_ms: 200,
  });
  assert.ok(blocked, 'must short-circuit after 3 timeouts');
  assert.match(blocked, /timed out 3 time/i);
  assert.doesNotMatch(blocked, /identical input was already requested/i);
  assert.doesNotMatch(blocked, /same check failed repeatedly/i);
  const msg = formatToolLoopGuardMessage(blocked, 'exec');
  assert.match(msg, /超时|timed out/i);
  assert.doesNotMatch(msg, STOP_RE);
});

test('e2e: real execTool sleep+timeout_ms through executeOneToolCall counts as timeout', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o96-e2e-'));
  const deps = execCallDeps([execTool]);
  deps.toolCtx = { workspaceDir, sessionKey: 'o96-real' };
  deps.sessionKey = 'o96-real';
  const state = createToolLoopGuardState();

  for (let i = 0; i < 3; i++) {
    const outcome = await executeOneToolCall(
      {
        id: `r${i}`,
        name: 'exec',
        input: { command: 'sleep 2', timeout_ms: 200 },
      },
      deps
    );
    assert.equal(outcome.kind, 'completed');
    const { text, isError } = outcomeToResult(outcome);
    assert.match(text, /timed out after 200ms/);
    assert.equal(isError, true, `real exec timeout ${i} must be is_error`);
    recordToolLoopOutcome(state, 'exec', isError, text, {
      command: 'sleep 2',
      timeout_ms: 200,
    });
  }

  assert.equal(state.byToolFailure.get('exec'), 3);
  const blocked = shouldShortCircuitToolCall(state, 'exec', {
    command: 'sleep 2',
    timeout_ms: 200,
  });
  assert.ok(blocked);
  assert.match(blocked, /timed out 3 time/i);
  const msg = formatToolLoopGuardMessage(blocked, 'exec');
  assert.match(msg, /超时/);
  assert.match(msg, /timed out/i);
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// QA #97 913354c4: fault-looking text in child stdout must never count as a tool fault.
// is_error comes from execute-tool-call (anchored isStringToolFailureResult).
const NEG_CASES = [
  {
    name: '(a) exit 1, node:test prints "test timed out after 100ms"',
    text: "exit_code: 1\nnot ok 1 - slow case\n  error: 'test timed out after 100ms'\n# fail 1\n",
    isError: true,
    kind: 'normal_nonzero',
  },
  {
    name: '(b) exit 1, jest test name contains "timed out after"',
    text: 'exit_code: 1\nFAIL src/net.test.ts\n  ✕ retries when socket timed out after 3 attempts (12 ms)\nTests: 1 failed, 4 passed\n',
    isError: true,
    kind: 'normal_nonzero',
  },
  {
    name: '(c) exit 0, log "connection timed out after 5s"',
    text: 'exit_code: 0\n[warn] connection timed out after 5s, retrying\nok\n',
    isError: false,
    kind: 'other',
  },
  {
    name: '(d) exit 0, warning line containing ENOENT',
    text: "exit_code: 0\nnpm warn optional: ENOENT: no such file or directory, open '.npmrc'\ndone\n",
    isError: false,
    kind: 'other',
  },
];

for (const c of NEG_CASES) {
  test(`negative ${c.name} → no byToolFailure across 3 runs, no STOP`, () => {
    assert.equal(
      isStringToolFailureResult(c.text),
      c.isError,
      'is_error as execute-tool-call sets it'
    );
    assert.equal(classifyShellToolFailure(c.text), c.kind);
    const state = createToolLoopGuardState();
    for (let i = 0; i < 3; i++) {
      recordToolLoopOutcome(state, 'exec', c.isError, c.text, { command: 'npm test' });
    }
    assert.equal(state.byToolFailure.get('exec') ?? 0, 0);
    const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'npm run lint' });
    if (blocked) {
      assert.doesNotMatch(formatToolLoopGuardMessage(blocked, 'exec'), /STOP calling|工具不可用/i);
    }
  });
}

test('fault patterns anchored to first line (ENOENT / command not found / timeout / killed)', () => {
  assert.equal(classifyShellToolFailure('timed out after 200ms (raise timeout_ms)\np'), 'timeout');
  assert.equal(classifyShellToolFailure('Command killed by SIGKILL:\np'), 'killed');
  assert.equal(
    classifyShellToolFailure('Execution error: spawnSync foo ENOENT\n'),
    'start_failure'
  );
  assert.equal(classifyShellToolFailure('bash: foo: command not found\n'), 'start_failure');
  assert.equal(
    classifyShellToolFailure('Command failed (exit 1):\nENOENT foo\n'),
    'normal_nonzero'
  );
  assert.equal(
    classifyShellToolFailure('Command failed (exit 127):\nsh: x: command not found\n'),
    'normal_nonzero'
  );
  assert.equal(
    classifyShellToolFailure('Command failed (exit 2):\nkilled by SIGTERM\n'),
    'normal_nonzero'
  );
  assert.equal(classifyShellToolFailure('exit_code: 3\ntimed out after 1ms\n'), 'normal_nonzero');
});
