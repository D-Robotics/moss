#!/usr/bin/env node
/**
 * Steering guides the next turn. It does not skip tool calls the model
 * already emitted in this response. The total-call ceiling works the same
 * way: the in-flight batch runs, and the next response is blocked.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAgentLoopToolCalls } from '../dist/core/loop/agent-loop-tool-execution.js';
import { createInitialLoopState } from '../dist/core/loop/agent-loop-state.js';
import { createToolLoopGuardState } from '../dist/core/tools/tool-loop-guard.js';
import { PendingToolAbortStore } from '../dist/core/loop/pending-tool-aborts.js';

function lookupTool(executed) {
  return {
    name: 'lookup',
    description: 'Look up a page.',
    metadata: { sideEffectClass: 'local_write' },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    async execute(input) {
      executed.push(input.q);
      return `page ${input.q}`;
    },
  };
}

function calls(ids) {
  return ids.map((id) => ({ id, name: 'lookup', input: { q: id } }));
}

async function runBatch(params) {
  const events = [];
  const state = params.state ?? createInitialLoopState();
  const result = await executeAgentLoopToolCalls({
    runId: 'r',
    sessionKey: 's',
    turnIndex: 9,
    currentMessages: params.currentMessages ?? [],
    assistantContent: calls(params.ids).map((call) => ({ type: 'tool_use', ...call })),
    toolCalls: calls(params.ids),
    resolveToolsForRun: () => [params.tool],
    toolCtx: { workspaceDir: '/tmp', sessionKey: 's' },
    abortSignal: new AbortController().signal,
    toolTimeoutMs: 5_000,
    toolHeartbeatIntervalMs: 60_000,
    skipHeartbeatToolNames: new Set(),
    parallelSafeTools: new Set(),
    toolLoopGuard: params.toolLoopGuard,
    state,
    metrics: state.toolExecutionMetrics,
    evaluateSteering: params.evaluateSteering,
    appendMessage: async () => {},
    push: (event) => events.push(event),
    pendingToolAborts: new PendingToolAbortStore(),
  });
  return { result, events, state };
}

test('steering does not skip tool calls already emitted in this response', async () => {
  const executed = [];
  const tool = lookupTool(executed);
  const guard = createToolLoopGuardState();
  const { result, events } = await runBatch({
    ids: ['a', 'b', 'c'],
    tool,
    toolLoopGuard: guard,
    evaluateSteering: () => [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[Steering] Extended tool loop detected — you have been executing tools for many turns.',
          },
        ],
        timestamp: 1,
      },
    ],
  });
  assert.deepEqual(executed, ['a', 'b', 'c']);
  assert.equal(events.filter((event) => event.type === 'tool_skipped').length, 0);
  const guidance = JSON.stringify(result.pendingMessages);
  assert.match(guidance, /Extended tool loop detected/);
  assert.equal(guidance.includes('Skipped due to queued user message'), false);
});

test('total-call limit runs the in-flight batch, then blocks the next response', async () => {
  const prev = process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT;
  process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT = '1';
  const executed = [];
  const tool = lookupTool(executed);
  const guard = createToolLoopGuardState();
  const state = createInitialLoopState();
  try {
    await runBatch({
      ids: ['a', 'b', 'c'],
      tool,
      toolLoopGuard: guard,
      state,
      evaluateSteering: () => [],
    });
    assert.deepEqual(executed, ['a', 'b', 'c']);
    await runBatch({
      ids: ['d'],
      tool,
      toolLoopGuard: guard,
      state,
      evaluateSteering: () => [],
    });
    assert.deepEqual(executed, ['a', 'b', 'c'], 'the next response does not run another lookup');
  } finally {
    if (prev === undefined) delete process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT;
    else process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT = prev;
  }
});
