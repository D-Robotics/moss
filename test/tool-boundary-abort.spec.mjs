#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms));
}

function createToolAgent(options = {}) {
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('abort-boundary', 'Abort Boundary', [
      { toolCalls: [{ name: 'blocked_tool', input: {} }] },
      { text: 'should not continue' },
    ]),
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 3,
    ...options,
  });
  let executions = 0;
  agent.tools.register({
    name: 'blocked_tool',
    description: 'test tool',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      executions += 1;
      return 'executed';
    },
  });
  return { agent, executions: () => executions };
}

async function abortChatAtBoundary(agent, onStarted) {
  const controller = new AbortController();
  const chat = agent
    .chat('abort-boundary', 'use the tool', { abortSignal: controller.signal })
    .catch((error) => error);
  await onStarted;
  controller.abort(new Error('user stop'));
  const result = await Promise.race([chat, timeout(500, 'chat remained pending after abort')]);
  assert.equal(result?.stopReason, 'aborted_by_user');
  assert.doesNotMatch(JSON.stringify(result), /denied by user/i);
}

test('approval promises are abortable and never execute the tool', async () => {
  let started;
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const { agent, executions } = createToolAgent({
    hooks: {
      onBeforeToolExec: async () => {
        started();
        return new Promise(() => {});
      },
    },
  });
  await abortChatAtBoundary(agent, startedGate);
  assert.equal(executions(), 0);
});

test('pre-tool hooks are abortable and never execute the tool', async () => {
  let started;
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const { agent, executions } = createToolAgent();
  agent.registerPreToolHook({
    name: 'hang-pre',
    priority: 1,
    async check() {
      started();
      return new Promise(() => {});
    },
  });
  await abortChatAtBoundary(agent, startedGate);
  assert.equal(executions(), 0);
});

test('post-tool hooks are abortable after one completed execution', async () => {
  let started;
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const { agent, executions } = createToolAgent();
  agent.registerPostToolHook({
    name: 'hang-post',
    priority: 1,
    async process() {
      started();
      return new Promise(() => {});
    },
  });
  await abortChatAtBoundary(agent, startedGate);
  assert.equal(executions(), 1);
});
