#!/usr/bin/env node
/**
 * String-encoded tool failures must set is_error so completion gates and the
 * tool-loop failure counter treat non-zero exec / Error: returns as real
 * failures (Claude/Codex discipline).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeOneToolCall,
  isStringToolFailureResult,
  outcomeToResult,
} from '../dist/core/tools/execute-tool-call.js';
import { ErrorCode, MossError } from '../dist/errors.js';

test('isStringToolFailureResult detects common failure encodings', () => {
  assert.equal(isStringToolFailureResult('Error: old_string not found'), true);
  assert.equal(isStringToolFailureResult('Command failed (exit 1):\nboom'), true);
  assert.equal(isStringToolFailureResult('exit_code: 1\nFAIL'), true);
  assert.equal(isStringToolFailureResult('exit_code: 0\nok'), false);
  assert.equal(isStringToolFailureResult('Command blocked: dangerous'), true);
  assert.equal(
    isStringToolFailureResult('timed out after 200ms (raise timeout_ms or use exec_background)\n'),
    false,
    'O96: timeout is marked structurally by exec (ctx.markResultError), not by text'
  );
  assert.equal(
    isStringToolFailureResult('Command killed by SIGTERM:\npartial\n'),
    false,
    'O96: signal kill is marked structurally by exec (ctx.markResultError), not by text'
  );
  assert.equal(isStringToolFailureResult('Patch rejected:\nbad hunk'), true);
  assert.equal(isStringToolFailureResult('Test Results: ❌ 2 FAILED\nCommand: npm test\n'), true);
  assert.equal(
    isStringToolFailureResult('Verify Fix: ❌ ISSUES FOUND\nBuild: ✅ pass | Typecheck: ❌ FAIL\n'),
    true
  );
  assert.equal(isStringToolFailureResult('Test Results: ✅ ALL PASSED\n'), false);
  assert.equal(
    isStringToolFailureResult('Command: tsc\nVia: package.json\n\nResult: FAIL\nExit: 2\n'),
    true
  );
  // Successful suites often log assertion text containing "Error:" mid-body —
  // that must NOT be treated as a tool failure.
  assert.equal(
    isStringToolFailureResult(
      'Test Results: ✅ ALL PASSED\nCommand: npm test\n\nError: expected 1 to equal 1 (example log)\n'
    ),
    false,
    'PASS harness output with Error: in body is not a tool failure'
  );
  assert.equal(
    isStringToolFailureResult('hello\nError: something in the middle\n'),
    false,
    'mid-body Error: line alone is not a tool failure prefix'
  );
  assert.equal(
    isStringToolFailureResult(
      'Error: No diagnostic command detected. Checked:\n  - package.json\n'
    ),
    true,
    'code_diagnostics no-command path is a tool failure'
  );
  assert.equal(
    isStringToolFailureResult(
      'Test Results: ⚠️ NO TESTS EXECUTED\nCommand: npm test\nTests: 0 total, 0 passed\n'
    ),
    true,
    'empty suite is not green verification'
  );
  assert.equal(
    isStringToolFailureResult(
      'Verify Fix: ⚠️ NO STEPS EXECUTED\nBuild: ⏭ skipped | Typecheck: ⏭ skipped | Tests: ⏭ skipped\n'
    ),
    true,
    'all-skipped verify_fix is not green verification'
  );
  assert.equal(isStringToolFailureResult('Successfully wrote 10 chars'), false);
  assert.equal(
    isStringToolFailureResult(
      'Error: [Sub-agent ab12] FAILED\nscope: full | turns: 2\n\n(no output)\n'
    ),
    true,
    'create_subagent FAILED banner is a tool failure'
  );
  assert.equal(
    isStringToolFailureResult('[Sub-agent ab12] FAILED\nscope: full\n\nempty\n'),
    true,
    'Sub-agent FAILED without Error: prefix still detected'
  );
  assert.equal(isStringToolFailureResult('[Sub-agent ab12] SUCCESS\nscope: full\n\nok\n'), false);
});

function baseDeps(tools) {
  const abortController = new AbortController();
  return {
    toolsForRun: tools,
    toolCtx: { workspaceDir: process.cwd(), sessionKey: 't' },
    sessionKey: 't',
    abortSignal: abortController.signal,
    toolTimeoutMs: 5_000,
    enableHeartbeat: false,
    heartbeatIntervalMs: 60_000,
    skipHeartbeatToolNames: new Set(['exec']),
    push() {},
  };
}

function wrappedSystemError(code, message, options) {
  const native = Object.assign(new Error(message), { code, errno: -1, ...options });
  return {
    native,
    wrapped: new MossError({
      code: ErrorCode.TOOL_EXECUTION_FAILED,
      message: `filesystem operation failed: ${message}`,
      cause: native,
    }),
  };
}

function systemErrorTool(execute, transientRetry) {
  return {
    name: 'system_error_fixture',
    description: 'Safely exercise structured system errors',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly', transientRetry },
    execute,
  };
}

test('system EAGAIN retries even when the path matches its real error description', async (t) => {
  if (process.env.MOSS_TOOL_RETRY_MAX === '0') {
    t.skip('tool retries are disabled by MOSS_TOOL_RETRY_MAX');
    return;
  }
  const target = 'temporarily unavailable';
  const { wrapped } = wrappedSystemError(
    'EAGAIN',
    `EAGAIN: resource temporarily unavailable, open '${target}'`,
    { syscall: 'open', path: target }
  );
  let attempts = 0;
  const tool = systemErrorTool(async () => {
    attempts++;
    if (attempts === 1) throw wrapped;
    return 'retry succeeded';
  }, true);
  const outcome = await executeOneToolCall(
    { id: 'retry', name: tool.name, input: {} },
    baseDeps([tool])
  );
  assert.equal(attempts, 2);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.text, 'retry succeeded');
});

test('system ETIMEDOUT remains a timeout when the path matches its error description', async () => {
  const target = 'timed out';
  const { native, wrapped } = wrappedSystemError(
    'ETIMEDOUT',
    `ETIMEDOUT: operation timed out, open '${target}'`,
    { syscall: 'open', path: target }
  );
  const tool = systemErrorTool(async () => {
    throw wrapped;
  }, false);
  const outcome = await executeOneToolCall(
    { id: 'timeout', name: tool.name, input: {} },
    baseDeps([tool])
  );
  assert.equal(outcome.isError, true);
  assert.equal(outcome.error?.code, ErrorCode.TOOL_EXECUTION_TIMEOUT);
  assert.deepEqual(outcome.aborted, { by: 'timeout' });
  assert.equal(outcome.text, `Execution error: ${wrapped.message}`);
  assert.equal(outcome.error?.cause, wrapped);
  assert.equal(outcome.error?.cause?.cause, native);
});

test('an explicit tool timeout remains a timeout despite a nested filesystem failure', async () => {
  const { native } = wrappedSystemError('ENOENT', "ENOENT: missing, open 'timed out'", {
    syscall: 'open',
    path: 'timed out',
  });
  const timeout = new MossError({
    code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
    message: 'Operation exceeded its deadline.',
    cause: native,
  });
  const tool = systemErrorTool(async () => {
    throw timeout;
  }, false);
  const outcome = await executeOneToolCall(
    { id: 'explicit-timeout', name: tool.name, input: {} },
    baseDeps([tool])
  );
  assert.equal(outcome.error?.code, ErrorCode.TOOL_EXECUTION_TIMEOUT);
  assert.deepEqual(outcome.aborted, { by: 'timeout' });
  assert.equal(outcome.text, `Execution error: ${timeout.message}`);
  assert.equal(outcome.error?.cause, timeout);
  assert.equal(outcome.error?.cause?.cause, native);
});

test('an explicit timeout with a filesystem cause retains its retry behavior', async (t) => {
  if (process.env.MOSS_TOOL_RETRY_MAX === '0') {
    t.skip('tool retries are disabled by MOSS_TOOL_RETRY_MAX');
    return;
  }
  const { native } = wrappedSystemError('ENOENT', "ENOENT: missing, open 'file'", {
    syscall: 'open',
    path: 'file',
  });
  const timeout = new MossError({
    code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
    message: 'Operation timed out.',
    cause: native,
  });
  let attempts = 0;
  const tool = systemErrorTool(async () => {
    attempts++;
    if (attempts === 1) throw timeout;
    return 'retry succeeded';
  }, true);
  const outcome = await executeOneToolCall(
    { id: 'explicit-timeout-retry', name: tool.name, input: {} },
    baseDeps([tool])
  );
  assert.equal(attempts, 2);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.text, 'retry succeeded');
});

test('a device connection loss is not retried when its cause has a filesystem path', async () => {
  const { native } = wrappedSystemError('ECONNRESET', "ECONNRESET: connection reset, open 'file'", {
    syscall: 'open',
    path: 'file',
  });
  const failure = new MossError({
    code: ErrorCode.TOOL_EXECUTION_FAILED,
    message: `Device connection lost: ${native.message}`,
    cause: native,
  });
  let attempts = 0;
  const tool = systemErrorTool(async () => {
    attempts++;
    throw failure;
  }, true);
  const outcome = await executeOneToolCall(
    { id: 'device-lost', name: tool.name, input: {} },
    baseDeps([tool])
  );
  assert.equal(attempts, 1);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.error, failure);
});

test('a device-loss phrase in a system-error path does not suppress a real retry', async (t) => {
  if (process.env.MOSS_TOOL_RETRY_MAX === '0') {
    t.skip('tool retries are disabled by MOSS_TOOL_RETRY_MAX');
    return;
  }
  const target = 'Device connection lost';
  const { wrapped } = wrappedSystemError(
    'ECONNRESET',
    `ECONNRESET: connection reset, open '${target}'`,
    { syscall: 'open', path: target }
  );
  let attempts = 0;
  const tool = systemErrorTool(async () => {
    attempts++;
    if (attempts === 1) throw wrapped;
    return 'retry succeeded';
  }, true);
  const outcome = await executeOneToolCall(
    { id: 'device-path-retry', name: tool.name, input: {} },
    baseDeps([tool])
  );
  assert.equal(attempts, 2);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.text, 'retry succeeded');
});

test('system ENOENT is not a timeout when source is a prefix of destination', async () => {
  const source = 'folder';
  const dest = 'folder timed out';
  const { native, wrapped } = wrappedSystemError(
    'ENOENT',
    `ENOENT: no such file or directory, rename '${source}' -> '${dest}'`,
    { syscall: 'rename', path: source, dest }
  );
  let attempts = 0;
  const tool = systemErrorTool(async () => {
    attempts++;
    throw wrapped;
  }, true);
  const outcome = await executeOneToolCall(
    { id: 'rename', name: tool.name, input: {} },
    baseDeps([tool])
  );
  assert.deepEqual(
    { attempts, code: outcome.error?.code, aborted: outcome.aborted },
    { attempts: 1, code: ErrorCode.TOOL_EXECUTION_FAILED, aborted: undefined }
  );
  assert.equal(outcome.text, `Execution error: ${wrapped.message}`);
  assert.equal(outcome.error?.cause, native);
});

test('executeOneToolCall marks exec-like string failures as isError', async () => {
  const tool = {
    name: 'exec',
    description: 'test',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    async execute() {
      return 'exit_code: 1\nFAIL suite';
    },
  };
  const outcome = await executeOneToolCall(
    { id: 'c1', name: 'exec', input: { command: 'false' } },
    baseDeps([tool])
  );
  assert.equal(outcome.kind, 'completed');
  if (outcome.kind === 'completed') {
    assert.equal(outcome.isError, true, 'non-zero exit string must be isError');
    assert.equal(outcome.error?.code, ErrorCode.TOOL_EXECUTION_FAILED);
    assert.equal(outcomeToResult(outcome).isError, true);
  }
});

test('executeOneToolCall marks harness run_tests failure text as isError', async () => {
  const tool = {
    name: 'run_tests',
    description: 'test',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'Test Results: ❌ 1 FAILED\nCommand: npm test\nTests: 1 total, 0 passed, 1 failed\n';
    },
  };
  const outcome = await executeOneToolCall(
    { id: 'c3', name: 'run_tests', input: {} },
    baseDeps([tool])
  );
  assert.equal(outcome.kind, 'completed');
  if (outcome.kind === 'completed') {
    assert.equal(outcome.isError, true, 'harness FAIL banner must be isError');
  }
});

test('executeOneToolCall does not mark successful text as isError', async () => {
  const tool = {
    name: 'exec',
    description: 'test',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    async execute() {
      return 'hello\nworld';
    },
  };
  const outcome = await executeOneToolCall(
    { id: 'c2', name: 'exec', input: { command: 'echo' } },
    baseDeps([tool])
  );
  assert.equal(outcome.kind, 'completed');
  if (outcome.kind === 'completed') {
    assert.equal(outcome.isError, false);
  }
});
