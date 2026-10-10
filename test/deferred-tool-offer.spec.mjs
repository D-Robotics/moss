#!/usr/bin/env node
/**
 * Sub-agent schemas stay off the default request until tool_search reveals them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { registerBuiltinTools } from '../dist/tools/builtin.js';

test('tool_search reveals the five subagent tools on the next model call', async () => {
  const calls = [];
  let n = 0;
  const agent = new MossAgent({
    llmProvider: {
      id: 'deferred-tools',
      displayName: 'deferred-tools',
      capabilities: { streaming: true },
      async complete() {
        throw new Error('unused');
      },
      async stream(request, onEvent) {
        calls.push((request.tools ?? []).map((tool) => tool.name));
        n += 1;
        const response =
          n === 1
            ? {
                stopReason: 'tool_use',
                content: [
                  {
                    type: 'tool_use',
                    id: 'load-subagent',
                    name: 'tool_search',
                    input: { group: 'subagent' },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            : {
                stopReason: 'end_turn',
                content: [{ type: 'text', text: 'schemas loaded' }],
                usage: { inputTokens: 1, outputTokens: 1 },
              };
        onEvent?.({ type: 'message_start' });
        onEvent?.({ type: 'message_delta', stopReason: response.stopReason });
        onEvent?.({ type: 'message_stop' });
        return response;
      },
    },
    sessionStore: new InMemorySessionStore(),
    model: 'deferred-tools',
    baseSystemPrompt: 'Load tools only when needed.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
  });
  registerBuiltinTools(agent);
  const result = await agent.chat('deferred', 'Review this in parallel.');
  assert.match(result.response, /schemas loaded/);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('tool_search'), 'meta-tool is on the default list');
  for (const name of [
    'create_subagent',
    'fan_out_subagents',
    'subagent_status',
    'subagent_stop',
    'merge_subagent_patch',
  ]) {
    assert.equal(calls[0].includes(name), false, `${name} stays off the first request`);
    assert.ok(calls[1].includes(name), `${name} is offered after tool_search`);
  }
  await agent.close();
});

function lastUserText(messages) {
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((block) => block.text ?? '').join('\n');
    }
  }
  return '';
}

test('use 3 subagents in parallel loads them through tool_search group=subagent', async () => {
  const calls = [];
  const agent = new MossAgent({
    llmProvider: {
      id: 'deferred-tools',
      displayName: 'deferred-tools',
      capabilities: { streaming: true },
      async complete() {
        throw new Error('unused');
      },
      async stream(request, onEvent) {
        const user = lastUserText(request.messages);
        const guided = String(request.systemPrompt ?? '').includes('tool_search group=subagent');
        const parallel = /use 3 subagents in parallel/i.test(user);
        calls.push({
          guided,
          parallel,
          tools: (request.tools ?? []).map((tool) => tool.name),
        });
        const response =
          parallel && guided && calls.length === 1
            ? {
                stopReason: 'tool_use',
                content: [
                  {
                    type: 'tool_use',
                    id: 'load-subagent',
                    name: 'tool_search',
                    input: { group: 'subagent' },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            : {
                stopReason: 'end_turn',
                content: [{ type: 'text', text: 'loaded' }],
                usage: { inputTokens: 1, outputTokens: 1 },
              };
        onEvent?.({ type: 'message_start' });
        onEvent?.({ type: 'message_delta', stopReason: response.stopReason });
        onEvent?.({ type: 'message_stop' });
        return response;
      },
    },
    sessionStore: new InMemorySessionStore(),
    model: 'deferred-tools',
    baseSystemPrompt: 'You are Moss.',
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
  });
  registerBuiltinTools(agent);
  const result = await agent.chat(
    'parallel-subagents',
    'use 3 subagents in parallel to review the parser'
  );
  assert.match(result.response, /loaded/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].guided, true, 'system prompt tells the model how to load sub-agents');
  assert.equal(calls[0].parallel, true);
  assert.ok(calls[0].tools.includes('tool_search'));
  assert.equal(calls[0].tools.includes('fan_out_subagents'), false);
  assert.equal(calls[0].tools.includes('create_subagent'), false);
  assert.ok(calls[1].tools.includes('fan_out_subagents'));
  assert.ok(calls[1].tools.includes('create_subagent'));
  await agent.close();
});
