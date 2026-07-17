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

test('isStringToolFailureResult detects common failure encodings', () => {
  assert.equal(isStringToolFailureResult('Error: old_string not found'), true);
  assert.equal(isStringToolFailureResult('Command failed (exit 1):\nboom'), true);
  assert.equal(isStringToolFailureResult('exit_code: 1\nFAIL'), true);
  assert.equal(isStringToolFailureResult('exit_code: 0\nok'), false);
  assert.equal(isStringToolFailureResult('Command blocked: dangerous'), true);
  assert.equal(isStringToolFailureResult('Patch rejected:\nbad hunk'), true);
  assert.equal(
    isStringToolFailureResult('Test Results: ❌ 2 FAILED\nCommand: npm test\n'),
    true,
  );
  assert.equal(
    isStringToolFailureResult('Verify Fix: ❌ ISSUES FOUND\nBuild: ✅ pass | Typecheck: ❌ FAIL\n'),
    true,
  );
  assert.equal(isStringToolFailureResult('Test Results: ✅ ALL PASSED\n'), false);
  assert.equal(
    isStringToolFailureResult('Command: tsc\nVia: package.json\n\nResult: FAIL\nExit: 2\n'),
    true,
  );
  assert.equal(isStringToolFailureResult('Successfully wrote 10 chars'), false);
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

test('executeOneToolCall marks exec-like string failures as isError', async () => {
  const tool = {
    name: 'exec',
    description: 'test',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async execute() {
      return 'exit_code: 1\nFAIL suite';
    },
  };
  const outcome = await executeOneToolCall(
    { id: 'c1', name: 'exec', input: { command: 'false' } },
    baseDeps([tool]),
  );
  assert.equal(outcome.kind, 'completed');
  if (outcome.kind === 'completed') {
    assert.equal(outcome.isError, true, 'non-zero exit string must be isError');
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
    baseDeps([tool]),
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
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async execute() {
      return 'hello\nworld';
    },
  };
  const outcome = await executeOneToolCall(
    { id: 'c2', name: 'exec', input: { command: 'echo' } },
    baseDeps([tool]),
  );
  assert.equal(outcome.kind, 'completed');
  if (outcome.kind === 'completed') {
    assert.equal(outcome.isError, false);
  }
});
