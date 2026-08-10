import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, MossError } from '../dist/errors.js';
import { createMossAgentLoopEventAdapter } from '../dist/core/agent/index.js';
import { executeOneToolCall, outcomeToResult } from '../dist/core/tools/execute-tool-call.js';
import { toolError } from '../dist/tools/tool-helpers.js';

test('tool error decoration preserves MossError policy metadata', () => {
  const decorated = toolError(
    'Error reading file',
    new MossError({
      code: ErrorCode.TOOL_NOT_ALLOWED,
      message: 'Path escapes workspace: /tmp/outside-workspace',
    })
  );

  assert.ok(decorated instanceof MossError);
  assert.equal(decorated.code, ErrorCode.TOOL_NOT_ALLOWED);
  assert.match(decorated.message, /^Error reading file: Path escapes workspace/);
});

test('tool policy errors are blocked outcomes and never imply target state', async () => {
  const abortController = new AbortController();
  const outcome = await executeOneToolCall(
    { id: 'read-outside', name: 'read_file', input: { path: '/tmp/outside-workspace' } },
    {
      toolsForRun: [
        {
          name: 'read_file',
          description: 'test reader',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          async execute() {
            throw toolError(
              'Error reading file',
              new MossError({
                code: ErrorCode.TOOL_NOT_ALLOWED,
                message: 'Path escapes workspace: /tmp/outside-workspace',
              })
            );
          },
        },
      ],
      toolCtx: { workspaceDir: '/workspace', sessionKey: 'policy-test' },
      sessionKey: 'policy-test',
      abortSignal: abortController.signal,
      toolTimeoutMs: 1000,
      enableHeartbeat: false,
      heartbeatIntervalMs: 1000,
      skipHeartbeatToolNames: new Set(),
      push() {},
    }
  );

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.outcome, 'blocked');
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /did not inspect the target/i);
  assert.match(outcome.text, /existence is unknown/i);
  assert.doesNotMatch(outcome.text, /does not exist|not found|不存在/i);
});

test('tool execution failures preserve structured error metadata and cause', async () => {
  const nativeCause = new Error('socket closed');
  const structuredError = new MossError({
    code: ErrorCode.TOOL_EXECUTION_FAILED,
    message: 'Device command failed.',
    hint: 'Reconnect the device and retry.',
    recoverable: true,
    cause: nativeCause,
    context: { tool: 'device_exec' },
  });
  const abortController = new AbortController();
  const outcome = await executeOneToolCall(
    { id: 'structured-failure', name: 'device_exec', input: {} },
    {
      toolsForRun: [
        {
          name: 'device_exec',
          description: 'test executor',
          inputSchema: { type: 'object', properties: {}, required: [] },
          async execute() {
            throw structuredError;
          },
        },
      ],
      toolCtx: { workspaceDir: '/workspace', sessionKey: 'policy-test' },
      sessionKey: 'policy-test',
      abortSignal: abortController.signal,
      toolTimeoutMs: 1000,
      enableHeartbeat: false,
      heartbeatIntervalMs: 1000,
      skipHeartbeatToolNames: new Set(),
      push() {},
    }
  );

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.error?.code, ErrorCode.TOOL_EXECUTION_FAILED);
  assert.equal(outcome.error?.cause, nativeCause);
  assert.equal(outcome.error?.hint, 'Reconnect the device and retry.');
  assert.deepEqual(outcome.error?.context, { tool: 'device_exec' });
  assert.equal(outcomeToResult(outcome).error?.cause, nativeCause);
});

test('public tool events retain structured failure metadata', () => {
  const error = {
    code: ErrorCode.TOOL_EXECUTION_FAILED,
    message: 'Device command failed.',
    hint: 'Reconnect and retry.',
    recoverable: true,
  };
  const adapter = createMossAgentLoopEventAdapter();
  const events = adapter.onMiniEvent({
    type: 'tool_execution_end',
    toolCallId: 'structured-failure',
    toolName: 'device_exec',
    result: 'Execution error: Device command failed.',
    isError: true,
    error,
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].error, error);
});
