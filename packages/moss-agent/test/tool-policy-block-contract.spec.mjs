import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, MossError } from '../dist/errors.js';
import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';
import { toolError } from '../dist/tools/tool-helpers.js';

test('tool error decoration preserves MossError policy metadata', () => {
  const decorated = toolError('Error reading file', new MossError({
    code: ErrorCode.TOOL_NOT_ALLOWED,
    message: 'Path escapes workspace: /tmp/outside-workspace',
  }));

  assert.ok(decorated instanceof MossError);
  assert.equal(decorated.code, ErrorCode.TOOL_NOT_ALLOWED);
  assert.match(decorated.message, /^Error reading file: Path escapes workspace/);
});

test('tool policy errors are blocked outcomes and never imply target state', async () => {
  const abortController = new AbortController();
  const outcome = await executeOneToolCall(
    { id: 'read-outside', name: 'read_file', input: { path: '/tmp/outside-workspace' } },
    {
      toolsForRun: [{
        name: 'read_file',
        description: 'test reader',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        async execute() {
          throw toolError('Error reading file', new MossError({
            code: ErrorCode.TOOL_NOT_ALLOWED,
            message: 'Path escapes workspace: /tmp/outside-workspace',
          }));
        },
      }],
      toolCtx: { workspaceDir: '/workspace', sessionKey: 'policy-test' },
      sessionKey: 'policy-test',
      abortSignal: abortController.signal,
      toolTimeoutMs: 1000,
      enableHeartbeat: false,
      heartbeatIntervalMs: 1000,
      skipHeartbeatToolNames: new Set(),
      push() {},
    },
  );

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.outcome, 'blocked');
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /did not inspect the target/i);
  assert.match(outcome.text, /existence is unknown/i);
  assert.doesNotMatch(outcome.text, /does not exist|not found|不存在/i);
});
