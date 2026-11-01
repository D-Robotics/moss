import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentLoop } from '../dist/core/loop/agent-loop.js';
import { createInitialLoopState } from '../dist/core/loop/agent-loop-state.js';
import { collectNudgeInjections } from '../dist/core/loop/nudges/registry.js';
import { evaluateTodoNudge } from '../dist/core/loop/nudges/todo-nudge.js';

const userText = 'Read three project files, then explain how to fix the bug. Do not change files.';
const todoReminder = 'have not used `todo_write`';
const request = {
  turns: 3,
  totalToolCalls: 3,
  toolCallsByName: { read_file: 3 },
  userText,
  attempts: 0,
};

test('an unavailable todo tool does not cause an impossible checklist instruction', () => {
  assert.equal(evaluateTodoNudge({ ...request, todoWriteAvailable: false }).fire, false);
  assert.equal(evaluateTodoNudge({ ...request, todoWriteAvailable: true }).fire, true);
});

test('an unavailable tool does not consume the registry once-per-run reminder budget', () => {
  const state = createInitialLoopState();
  state.turns = 3;
  state.toolExecutionMetrics.totalToolCalls = 3;
  state.toolExecutionMetrics.toolCallsByName = { read_file: 3 };
  const collect = (todoWriteAvailable) =>
    collectNudgeInjections({
      state,
      currentMessages: [],
      lastUserText: () => userText,
      buildCorrectionMessage: (text) => ({ role: 'user', content: text, timestamp: 1 }),
      todoWriteAvailable,
    });
  assert.equal(JSON.stringify(collect(false)).includes(todoReminder), false);
  assert.equal(state.todoNudgeAttempts, 0);
  assert.equal(JSON.stringify(collect(true)).includes(todoReminder), true);
  assert.equal(state.todoNudgeAttempts, 1);
  assert.equal(JSON.stringify(collect(true)).includes(todoReminder), false);
});

async function driveLoop(mode) {
  let reads = 0;
  let calls = 0;
  let todoExecutions = 0;
  let steeringPollsAfterThirdRead = 0;
  const steered = mode === 'steering-drop' || mode === 'steering-reveal';
  let available = mode === 'steering-drop' || mode === 'after-snapshot-drop';
  const providerCalls = [];
  const readTool = {
    name: 'read_file',
    description: 'Read an owned test file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    metadata: { sideEffectClass: 'readonly', noReplay: true },
    execute: async () => {
      reads += 1;
      return 'owned test content';
    },
  };
  const todoTool = {
    name: 'todo_write',
    description: 'Write a task checklist.',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'runtime_state' },
    execute: async () => {
      todoExecutions += 1;
      return 'unexpected checklist mutation';
    },
  };
  const staticTools = mode === 'filtered' ? [readTool, todoTool] : [readTool];
  const getToolsForRun =
    steered || mode === 'after-snapshot-drop'
      ? () => (available ? [readTool, todoTool] : [readTool])
      : mode === 'filtered'
        ? () => [readTool]
        : mode === 'revealed'
          ? () => (reads >= 3 ? [readTool, todoTool] : [readTool])
          : undefined;
  const stream = runAgentLoop({
    runId: `todo-capability-${mode}`,
    sessionKey: `todo-capability-${mode}`,
    agentId: 'test-agent',
    currentMessages: [{ role: 'user', content: userText, timestamp: 1 }],
    compactionSummary: undefined,
    systemPrompt: 'Use only the offered tools and do not change files.',
    toolsForRun: staticTools,
    ...(getToolsForRun ? { getToolsForRun } : {}),
    ...(steered
      ? {
          getSteeringMessages: async () => {
            // The executor polls once after the third read; the next poll is the
            // awaited host update immediately before preparing the model request.
            if (reads === 3 && ++steeringPollsAfterThirdRead >= 2) {
              available = mode === 'steering-reveal';
            }
            return [];
          },
        }
      : {}),
    toolCtx: { workspaceDir: process.cwd(), sessionKey: `todo-capability-${mode}` },
    modelDef: { api: 'openai-completions', provider: 'openai', id: 'test-model' },
    streamFn: (_model, context) => {
      calls += 1;
      providerCalls.push({
        messages: JSON.stringify(context.messages),
        names: context.tools.map((tool) => tool.name),
      });
      const revokedCall = mode === 'after-snapshot-drop' && calls === 4;
      if (revokedCall) available = false;
      const toolCall = {
        id: `read-${calls}`,
        name: revokedCall ? 'todo_write' : 'read_file',
        arguments: revokedCall ? {} : { path: `file-${calls}` },
      };
      const usingTool = calls <= 3 || revokedCall;
      const assistant = {
        role: 'assistant',
        content: usingTool
          ? [{ type: 'toolCall', ...toolCall }]
          : [{ type: 'text', text: 'Analysis complete.' }],
        api: 'openai-completions',
        provider: 'openai',
        model: 'test-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: usingTool ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() {
          if (usingTool) yield { type: 'toolcall_end', toolCall };
        },
        result: async () => assistant,
      };
    },
    maxTurns: 5,
    contextTokens: 100_000,
    platform: { quiet: true },
    appendMessage: async () => {},
    prepareCompaction: async () => ({}),
    abortSignal: new AbortController().signal,
  });
  const events = [];
  const consume = (async () => {
    for await (const event of stream) events.push(event);
  })();
  const result = await stream.result();
  await consume;
  assert.equal(reads, 3, 'the real loop must execute the three harmless tools');
  const expectedCalls = mode === 'after-snapshot-drop' ? 5 : 4;
  assert.equal(calls, expectedCalls, 'the scripted run must finish normally');
  assert.equal(todoExecutions, 0, 'revoked checklist tools must never execute');
  assert.equal(result.finalText, 'Analysis complete.');
  assert.equal(result.turns, expectedCalls);
  assert.equal(result.totalToolCalls, mode === 'after-snapshot-drop' ? 4 : 3);
  assert.ok(events.some((event) => event.type === 'agent_end'));
  assert.ok(events.every((event) => event.type !== 'agent_error'));
  return providerCalls;
}

for (const mode of ['static', 'filtered']) {
  test(`the real loop omits impossible todo reminders from ${mode} tool surfaces`, async () => {
    const calls = await driveLoop(mode);
    assert.ok(calls.every((call) => !call.names.includes('todo_write')));
    assert.ok(calls.every((call) => !call.messages.includes(todoReminder)));
  });
}

test('a dynamically revealed tool can still receive its legitimate reminder', async () => {
  const calls = await driveLoop('revealed');
  assert.ok(calls.slice(0, 3).every((call) => !call.names.includes('todo_write')));
  assert.ok(calls[3].names.includes('todo_write'));
  assert.ok(calls[3].messages.includes(todoReminder));
});

test('an awaited steering update can revoke the tool before the model request', async () => {
  const calls = await driveLoop('steering-drop');
  assert.ok(calls.slice(0, 3).every((call) => call.names.includes('todo_write')));
  assert.ok(!calls[3].names.includes('todo_write'));
  assert.ok(!calls[3].messages.includes(todoReminder));
});

test('an awaited steering update can reveal the tool before the model request', async () => {
  const calls = await driveLoop('steering-reveal');
  assert.ok(calls.slice(0, 3).every((call) => !call.names.includes('todo_write')));
  assert.ok(calls[3].names.includes('todo_write'));
  assert.ok(calls[3].messages.includes(todoReminder));
});

test('a provider tool snapshot does not freeze execution permission after revocation', async () => {
  const calls = await driveLoop('after-snapshot-drop');
  assert.ok(calls[3].names.includes('todo_write'));
  assert.ok(!calls[4].names.includes('todo_write'));
  assert.match(calls[4].messages, /tool[^\n]*not[^\n]*(?:found|available)|unknown tool/i);
});
