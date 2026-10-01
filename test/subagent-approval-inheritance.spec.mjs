#!/usr/bin/env node
/**
 * F23 regression: a sub-agent must inherit the parent's approval policy.
 *
 * Incident (2026-10-01, /tmp/moss-arena-task): the parent run was
 * non-interactive without auto-approve; write_file/exec/apply_patch were all
 * denied, then create_subagent (scope=full, writePaths=['hello.txt']) performed
 * the same write successfully — the child loop never consulted an approval
 * gate because createSubAgentRunner did not forward checkToolApproval into the
 * child's runAgentLoop.
 *
 * Contract under test:
 *  - SubAgentRunnerDeps accepts checkToolApproval.
 *  - The child loop consults it before executing a mutating tool.
 *  - A deny decision prevents execution (the tool body never runs).
 */
import assert from 'node:assert/strict';
import { createSubAgentRunner } from '../dist/core/subagent/subagent-runner.js';
import { createSpawnProfileRegistryFromDefaults } from '../dist/core/subagent/spawn-profile.js';

const parentModelDef = {
  id: 'parent-model',
  name: 'parent-model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

/** Fake mutating tool: records execution so a bypass is observable. */
const executedCalls = [];
const scratchWriteTool = {
  name: 'scratch_write',
  description: 'test-only mutating tool',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path'],
  },
  metadata: { sideEffectClass: 'workspace_mutation' },
  async execute(input) {
    executedCalls.push(input);
    return `wrote ${input.path}`;
  },
};

/**
 * Stateful fake provider stream.
 * Turn 1: model asks for the mutating tool call (mirrors the incident where
 * the child was told to write the file).
 * Turn 2+: model emits a final text summary via the result() content tail.
 */
function createFakeStreamFn() {
  let callCount = 0;
  return () => {
    callCount += 1;
    const first = callCount === 1;
    return {
      async *[Symbol.asyncIterator]() {
        if (first) {
          yield {
            type: 'toolcall_end',
            toolCall: {
              id: 'tc-scratch-1',
              name: 'scratch_write',
              arguments: { path: 'sentinel.txt', content: 'BYPASSED\n' },
            },
          };
        }
      },
      async result() {
        if (first) {
          return {
            stopReason: 'toolUse',
            responseModel: 'parent-model',
            usage: { input: 12, output: 4 },
          };
        }
        return {
          stopReason: 'end',
          responseModel: 'parent-model',
          usage: { input: 16, output: 3 },
          content: [{ type: 'text', text: 'child finished' }],
        };
      },
      push() {},
      end() {},
    };
  };
}

// Scenario: parent runs non-interactively without auto-approve — every
// mutating tool call is denied with the headless policy reason.
const approvalCalls = [];
const checkToolApproval = async (call) => {
  approvalCalls.push({ name: call.name, sessionKey: call.sessionKey, runId: call.runId });
  return {
    approved: false,
    decision: 'deny',
    reason:
      `Tool "${call.name}" requires approval, but Moss is running non-interactively. ` +
      'Use an explicit autonomous/auto-approve policy only when unattended mutations are intended.',
  };
};

const runner = createSubAgentRunner({
  parentTools: [scratchWriteTool],
  streamFn: createFakeStreamFn(),
  modelDef: parentModelDef,
  systemPrompt: 'You are a test subagent.',
  maxOutputTokens: 512,
  contextTokens: 32_000,
  spawnRegistry: createSpawnProfileRegistryFromDefaults(),
  workspaceDir: process.cwd(),
  checkToolApproval,
});

const result = await runner(
  {
    runId: 'sub-approval-1',
    parentRunId: 'parent-approval-1',
    scope: 'full',
    writePaths: ['sentinel.txt'],
    task: 'Create sentinel.txt with content BYPASSED using scratch_write.',
    maxTurns: 2,
    timeoutMs: 30_000,
  },
  new AbortController().signal
);

// 1. The child loop must consult the inherited approval gate.
assert.ok(
  approvalCalls.length >= 1,
  `child loop never consulted checkToolApproval (calls: ${approvalCalls.length}) — ` +
    'the sub-agent runs without any approval gate (F23 bypass)'
);
assert.equal(approvalCalls[0].name, 'scratch_write');

// 2. A denied mutating call must never reach the tool implementation.
assert.deepEqual(
  executedCalls,
  [],
  `mutating tool executed despite denial: ${JSON.stringify(executedCalls)} — ` +
    'full-scope sub-agent bypassed the non-interactive approval gate (F23)'
);

// 3. The child still completes and reports (denial is a tool result, not a crash).
assert.equal(typeof result.summary, 'string');
assert.ok(result.summary.length > 0, 'child produced no summary');

console.log('[PASS] subagent approval inheritance (F23): denied in child, never executed');
