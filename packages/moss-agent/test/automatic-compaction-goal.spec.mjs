#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';

function createProvider(systemPrompts, hooks = {}) {
  let compactions = 0;
  return {
    id: 'automatic-compaction-goal',
    capabilities: { streaming: true },
    get compactions() {
      return compactions;
    },
    async complete(options) {
      if (options.systemPrompt.includes('上下文摘要助手')) {
        compactions += 1;
        await hooks.onCompaction?.();
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '<summary>Compacted history.</summary>' }],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      systemPrompts.push(options.systemPrompt);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
    async stream(options, onEvent) {
      const response = await this.complete(options);
      onEvent({ type: 'message_start' });
      for (const block of response.content) {
        onEvent({ type: 'content_block_start' });
        onEvent({ type: 'content_block_delta', text: block.text });
        onEvent({ type: 'content_block_stop' });
      }
      onEvent({ type: 'message_delta', stopReason: response.stopReason, usage: response.usage });
      onEvent({ type: 'message_stop' });
      return response;
    },
  };
}

function createAgent(store, provider) {
  return new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'You are a coding agent.',
    domainPrompt: false,
    contextTokens: 1_000,
    maxTokens: 100,
    compactionSettings: {
      enabled: true,
      reserveTokens: 100,
      keepRecentTokens: 80,
      restoreFileContents: false,
    },
    enableSteering: false,
    enableFollowUpGuard: false,
  });
}

test('automatic compaction preserves one active goal checkpoint across restart and resume', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-auto-compact-goal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionKey = 'automatic-goal';
  const objective = 'Finish the automatic compaction regression safely';
  const firstPrompts = [];
  const firstStore = new JsonlSessionStore({ dir });
  const firstProvider = createProvider(firstPrompts);
  const firstAgent = createAgent(firstStore, firstProvider);

  for (let index = 0; index < 12; index++) {
    await firstStore.appendMessage(sessionKey, {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `history-${index} ${'filler '.repeat(100)}`,
    });
  }
  await firstAgent.setGoal(sessionKey, objective);
  await firstAgent.chat(sessionKey, 'Continue the active goal.');

  assert.ok(
    firstProvider.compactions > 0,
    'the public chat path must trigger automatic compaction'
  );
  const afterCompaction = await firstStore.loadMessages(sessionKey);
  const checkpoints = afterCompaction.filter((message) =>
    JSON.stringify(message.content).includes('moss_goal_checkpoint')
  );
  assert.equal(checkpoints.length, 1, 'automatic compaction persists exactly one goal checkpoint');

  const resumedPrompts = [];
  const resumedStore = new JsonlSessionStore({ dir });
  const resumedProvider = createProvider(resumedPrompts);
  const resumedAgent = createAgent(resumedStore, resumedProvider);

  assert.equal((await resumedAgent.getGoal(sessionKey))?.objective, objective);
  await resumedAgent.chat(sessionKey, 'Resume after restart.');
  assert.match(resumedPrompts.at(-1) ?? '', new RegExp(objective));
});

test('a concurrent goal update wins over the run-start snapshot during compaction', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-auto-compact-goal-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionKey = 'automatic-goal-race';
  const store = new JsonlSessionStore({ dir });
  let agent;
  let updated = false;
  const provider = createProvider([], {
    onCompaction: async () => {
      if (updated) return;
      updated = true;
      await agent.pauseGoal(sessionKey, 'user paused while compaction was running');
    },
  });
  agent = createAgent(store, provider);

  for (let index = 0; index < 12; index++) {
    await store.appendMessage(sessionKey, {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `history-${index} ${'filler '.repeat(100)}`,
    });
  }
  await agent.setGoal(sessionKey, 'Keep the latest goal state');
  await agent.chat(sessionKey, 'Continue the active goal.');

  const goal = await agent.getGoal(sessionKey);
  assert.equal(goal?.status, 'paused');
  assert.equal(goal?.statusReason, 'user paused while compaction was running');
  const persisted = await store.loadMessages(sessionKey);
  assert.equal(
    persisted.filter((message) => JSON.stringify(message.content).includes('moss_goal_checkpoint'))
      .length,
    1
  );
});
