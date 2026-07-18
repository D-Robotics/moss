#!/usr/bin/env node
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

let calls = 0;
const provider = {
  id: 'single-turn-test',
  capabilities: { streaming: true },
  async complete() {
    calls += 1;
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { inputTokens: 10, outputTokens: 1 },
    };
  },
  async stream(options, onEvent) {
    calls += 1;
    onEvent({ type: 'content_block_delta', text: 'done' });
    onEvent({ type: 'message_stop' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { inputTokens: 10, outputTokens: 1 },
    };
  },
};

const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: 'single-turn-test',
  baseSystemPrompt: 'Answer directly.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  maxAgentTurns: 8,
});

const result = await agent.chat('single-turn', 'reply once');
assert.equal(result.response, 'done');
assert.equal(calls, 1, 'a visible end_turn response must stop the loop after one provider call');
console.log('[PASS] visible end_turn stops after one provider call');

let thinkingCalls = 0;
const thinkingOnlyProvider = {
  id: 'thinking-only-test',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('not used');
  },
  async stream(options, onEvent) {
    thinkingCalls += 1;
    onEvent({ type: 'content_block_delta', text: 'still reasoning', deltaRole: 'thinking' });
    onEvent({ type: 'message_stop' });
    return {
      stopReason: 'end_turn',
      content: [],
      thinking: ['still reasoning'],
      usage: { inputTokens: 10, outputTokens: 1 },
    };
  },
};

const thinkingAgent = new MossAgent({
  llmProvider: thinkingOnlyProvider,
  sessionStore: new InMemorySessionStore(),
  model: 'thinking-only-test',
  baseSystemPrompt: 'Answer directly.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  maxAgentTurns: 8,
});

await assert.rejects(
  thinkingAgent.chat('thinking-only', 'reply visibly'),
  /visible answer/i,
);
assert.equal(thinkingCalls, 2, 'thinking-only output gets one corrective retry, then fails honestly');
console.log('[PASS] thinking-only output is bounded to one corrective retry');

let emptyCalls = 0;
const emptyProvider = {
  id: 'empty-response-test',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('not used');
  },
  async stream(options, onEvent) {
    emptyCalls += 1;
    onEvent({ type: 'message_stop' });
    return {
      stopReason: 'end_turn',
      content: [],
      usage: { inputTokens: 10, outputTokens: 700 },
    };
  },
};

const emptyAgent = new MossAgent({
  llmProvider: emptyProvider,
  sessionStore: new InMemorySessionStore(),
  model: 'empty-response-test',
  baseSystemPrompt: 'Answer directly.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  maxAgentTurns: 8,
});

await assert.rejects(
  emptyAgent.chat('empty-response', 'reply visibly'),
  /empty response/i,
);
assert.equal(emptyCalls, 2, 'empty output gets one corrective retry, then fails honestly');
console.log('[PASS] empty output is bounded to one corrective retry');
