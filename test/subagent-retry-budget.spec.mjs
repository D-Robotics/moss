import assert from 'node:assert/strict';
import { createSubAgentRunner } from '../dist/core/subagent/subagent-runner.js';
import { createSpawnProfileRegistryFromDefaults } from '../dist/core/subagent/spawn-profile.js';

const modelDef = {
  id: 'model',
  name: 'model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 512,
};
function emptyResponse() {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Evidence collected but output contract not followed.' }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', message };
    },
    async result() {
      return message;
    },
    push() {},
    end() {},
  };
}
for (const failAt of [1, 2]) {
  let calls = 0;
  const runner = createSubAgentRunner({
    parentTools: [],
    modelDef,
    systemPrompt: 'Investigate',
    maxOutputTokens: 512,
    contextTokens: 32000,
    maxLLMRetries: 0,
    spawnRegistry: createSpawnProfileRegistryFromDefaults(),
    workspaceDir: process.cwd(),
    streamFn() {
      calls++;
      if (calls >= failAt) {
        const error = new Error('429 rate limited');
        error.status = 429;
        throw error;
      }
      return emptyResponse();
    },
  });
  const result = await runner(
    {
      runId: `retry-${failAt}`,
      parentRunId: 'parent',
      scope: 'explore',
      task: 'SUBTASK_CONTRACT v1 CHECKS: EVIDENCE: VERDICT: PASS|FAIL|PARTIAL',
      maxTurns: 1,
    },
    new AbortController().signal
  );
  assert.equal(
    calls,
    failAt,
    'zero retry budget covers work and forced finalization without repairing a failed provider'
  );
  assert.equal(result.success, false);
}
console.log('subagent-retry-budget: work and finalization make no implicit retry');

// Exercise the public parent agent: its config must reach the real child runner.
{
  const { MossAgent, InMemorySessionStore } = await import('../dist/index.js');
  let rootCalls = 0,
    childCalls = 0;
  const agent = new MossAgent({
    model: 'parent',
    sessionStore: new InMemorySessionStore(),
    maxLLMRetries: 0,
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    llmProvider: {
      id: 'inheritance',
      capabilities: { streaming: false },
      async complete(options) {
        if (options.model === 'child') {
          childCalls++;
          const error = new Error('429 rate limited');
          error.status = 429;
          throw error;
        }
        rootCalls++;
        return rootCalls === 1
          ? {
              stopReason: 'tool_use',
              content: [{ type: 'tool_use', id: 'spawn', name: 'spawn_test', input: {} }],
            }
          : {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'Child failure reported.' }],
            };
      },
    },
  });
  agent.tools.register({
    name: 'spawn_test',
    description: 'Run child',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly' },
    async execute(_input, context) {
      return JSON.stringify(
        await context.spawnSubagent({
          mode: 'single',
          task: 'Investigate',
          scope: 'explore',
          model: 'child',
        })
      );
    },
  });
  try {
    await agent.chat('parent-session', 'Investigate');
    assert.equal(childCalls, 1, 'parent maxLLMRetries reaches the real child runner');
  } finally {
    await agent.close();
  }
}
