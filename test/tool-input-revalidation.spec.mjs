#!/usr/bin/env node
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';
import { ToolHookRegistry } from '../dist/core/tools/tool-hooks.js';
import {
  clearPreToolHooksForTests,
  registerPreToolHook,
} from '../dist/core/tools/tool-pipeline.js';

afterEach(() => clearPreToolHooksForTests());

function deps(tool, overrides = {}) {
  return {
    toolsForRun: [tool],
    toolCtx: { workspaceDir: '/workspace', sessionKey: 'schema-revalidation' },
    sessionKey: 'schema-revalidation',
    abortSignal: new AbortController().signal,
    toolTimeoutMs: 1_000,
    enableHeartbeat: false,
    heartbeatIntervalMs: 1_000,
    skipHeartbeatToolNames: new Set(),
    push() {},
    ...overrides,
  };
}

function stringPathTool(onExecute) {
  return {
    name: 'publish_artifact',
    description: 'publish a validated path',
    metadata: {
      sideEffectClass: 'external_message',
      planMode: 'requires_user_confirmation',
    },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async execute(input) {
      onExecute(input);
      return 'published';
    },
  };
}

test('global pre-tool hook cannot invalidate schema before approval', async () => {
  let executions = 0;
  let approvals = 0;
  const tool = stringPathTool(() => {
    executions += 1;
  });
  registerPreToolHook(async ({ input }) => ({ ok: true, input: { ...input, path: 42 } }));

  const outcome = await executeOneToolCall(
    { id: 'global-hook', name: tool.name, input: { path: '/safe/input' } },
    deps(tool, {
      async checkToolApproval() {
        approvals += 1;
        return { approved: true, decision: 'allow-once' };
      },
    })
  );

  assert.equal(outcome.kind, 'pre-blocked');
  assert.match(outcome.text, /parameter "path" should be string/);
  assert.equal(approvals, 0, 'invalid rewritten input is rejected before approval');
  assert.equal(executions, 0, 'invalid rewritten input never reaches the tool');
});

test('registry pre-hook modification is revalidated before approval and execution', async () => {
  let executions = 0;
  let approvals = 0;
  const tool = stringPathTool(() => {
    executions += 1;
  });
  const toolHooks = new ToolHookRegistry();
  toolHooks.registerPre({
    name: 'path-normalizer',
    priority: 10,
    async check({ input }) {
      return { action: 'modify', input: { ...input, path: '/normalized/input' } };
    },
  });
  toolHooks.registerPre({
    name: 'malicious-normalizer',
    priority: 20,
    async check({ input }) {
      assert.equal(input.path, '/normalized/input', 'hooks receive the prior hook output');
      return { action: 'modify', input: { ...input, path: 42 } };
    },
  });

  const outcome = await executeOneToolCall(
    { id: 'registry-hook', name: tool.name, input: { path: '/safe/input' } },
    deps(tool, {
      toolHooks,
      async checkToolApproval() {
        approvals += 1;
        return { approved: true, decision: 'allow-once' };
      },
    })
  );

  assert.equal(outcome.kind, 'pre-blocked');
  assert.match(outcome.text, /parameter "path" should be string/);
  assert.equal(approvals, 0, 'approval binds only the final validated input');
  assert.equal(executions, 0);
});

test('registry pre-hook chain returns its final valid input to approval and execution', async () => {
  let approvedInput;
  let executedInput;
  const tool = stringPathTool((input) => {
    executedInput = input;
  });
  const toolHooks = new ToolHookRegistry();
  toolHooks.registerPre({
    name: 'trim-path',
    priority: 10,
    async check({ input }) {
      return { action: 'modify', input: { ...input, path: input.path.trim() } };
    },
  });
  toolHooks.registerPre({
    name: 'prefix-path',
    priority: 20,
    async check({ input }) {
      return { action: 'modify', input: { ...input, path: `/workspace${input.path}` } };
    },
  });

  const outcome = await executeOneToolCall(
    { id: 'registry-valid-chain', name: tool.name, input: { path: ' /artifact ' } },
    deps(tool, {
      toolHooks,
      async checkToolApproval(request) {
        approvedInput = request.input;
        return { approved: true, decision: 'allow-once' };
      },
    })
  );

  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(approvedInput, { path: '/workspace/artifact' });
  assert.deepEqual(executedInput, approvedInput);
});

test('transient retry is limited to tools explicitly classified as readonly', async () => {
  let executions = 0;
  const tool = {
    ...stringPathTool(() => {}),
    metadata: {
      sideEffectClass: 'external_message',
      planMode: 'requires_user_confirmation',
      transientRetry: true,
    },
    async execute() {
      executions += 1;
      throw new Error('request timed out');
    },
  };

  const outcome = await executeOneToolCall(
    { id: 'no-side-effect-retry', name: tool.name, input: { path: '/safe/input' } },
    deps(tool)
  );

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.isError, true);
  assert.equal(executions, 1, 'a side-effecting tool is never retried automatically');
});
