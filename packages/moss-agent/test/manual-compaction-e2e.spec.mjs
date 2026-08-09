import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { estimateMessagesTokens } from '../dist/context/tokens.js';

function providerWithSummaryAndContinuation() {
  const calls = [];
  return {
    calls,
    id: 'compact-e2e',
    displayName: 'compact-e2e',
    async complete(options) {
      calls.push(options);
      if (options.systemPrompt.includes('上下文摘要助手')) {
        return {
          stopReason: 'end_turn',
          content: [
            {
              type: 'text',
              text: '<summary>Goal: fix parser. Decision: preserve strict mode. Next: add regression test. Marker: BANANA-7749.</summary>',
            },
          ],
          usage: { inputTokens: 500, outputTokens: 40 },
        };
      }
      const serialized = JSON.stringify(options.messages);
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text:
              serialized.includes('BANANA-7749') && serialized.includes('add regression test')
                ? 'continued with preserved context'
                : 'missing context',
          },
        ],
        usage: { inputTokens: 600, outputTokens: 10 },
      };
    },
    async stream(options, onEvent) {
      const response = await this.complete(options);
      onEvent({ type: 'message_start' });
      for (const block of response.content) {
        onEvent({ type: 'content_block_start' });
        if (block.type === 'text') onEvent({ type: 'content_block_delta', text: block.text });
        onEvent({ type: 'content_block_stop' });
      }
      onEvent({ type: 'message_delta', stopReason: response.stopReason, usage: response.usage });
      onEvent({ type: 'message_stop' });
      return response;
    },
  };
}

test('manual compaction preserves task facts for the next real chat turn', async () => {
  const store = new InMemorySessionStore();
  const provider = providerWithSummaryAndContinuation();
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'You are a coding agent.',
    domainPrompt: false,
    contextTokens: 4_000,
    maxTokens: 500,
    compactionSettings: {
      enabled: true,
      reserveTokens: 500,
      keepRecentTokens: 200,
      restoreFileContents: false,
    },
    enableSteering: false,
    enableFollowUpGuard: false,
  });

  for (let index = 0; index < 10; index++) {
    await store.appendMessage('main', {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index === 0 ? 'Goal fix parser BANANA-7749. ' : ''}${'history '.repeat(120)}`,
    });
  }
  await agent.setGoal('main', 'Finish parser fix BANANA-7749 without losing progress');

  const compacted = await agent.compactSession(
    'main',
    'Preserve goal, decisions, and next action.'
  );
  assert.equal(compacted.compacted, true);
  assert.match(compacted.summary, /BANANA-7749/);
  assert.ok(compacted.droppedMessages > 0);
  const persistedAfterCompaction = await store.loadMessages('main');
  assert.equal(
    compacted.tokensAfter,
    estimateMessagesTokens(persistedAfterCompaction),
    'reported tokensAfter matches the actual persisted context, including the goal checkpoint'
  );

  const continued = await agent.chat('main', 'What should I do next?');
  assert.equal(continued.response, 'continued with preserved context');
});

test('manual compaction keeps the latest user instruction after the goal checkpoint', async () => {
  const store = new InMemorySessionStore();
  const provider = providerWithSummaryAndContinuation();
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'You are a coding agent.',
    domainPrompt: false,
    contextTokens: 4_000,
    maxTokens: 500,
    compactionSettings: {
      enabled: true,
      reserveTokens: 500,
      keepRecentTokens: 120,
      restoreFileContents: false,
    },
    enableSteering: false,
    enableFollowUpGuard: false,
  });

  for (let index = 0; index < 8; index++) {
    await store.appendMessage('ordered', {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `old history ${index} ${'filler '.repeat(140)}`,
    });
  }
  await agent.setGoal('ordered', 'Finish the parser task');
  await store.appendMessage('ordered', {
    role: 'user',
    content: 'LATEST-CONSTRAINT: do not modify package.json',
  });

  const compacted = await agent.compactSession('ordered', 'Preserve the latest constraint.');
  assert.equal(compacted.compacted, true);
  const persisted = await store.loadMessages('ordered');
  const goalIndex = persisted.findIndex((message) =>
    JSON.stringify(message.content).includes('moss_goal_checkpoint')
  );
  const latestIndex = persisted.findIndex((message) =>
    JSON.stringify(message.content).includes('LATEST-CONSTRAINT')
  );
  assert.ok(goalIndex >= 0, 'goal checkpoint survives');
  assert.ok(latestIndex >= 0, 'latest user instruction survives');
  assert.ok(
    goalIndex < latestIndex,
    'goal checkpoint must not become newer than the latest user instruction'
  );
});

test('manual compaction records its provider usage for workspace cost reporting', async () => {
  const store = new InMemorySessionStore();
  const provider = providerWithSummaryAndContinuation();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-compact-usage-'));
  const usageLogPath = path.join(tempDir, 'llm-usage.jsonl');
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'compact-e2e-model',
    baseSystemPrompt: 'You are a coding agent.',
    domainPrompt: false,
    contextTokens: 4_000,
    maxTokens: 500,
    compactionSettings: {
      enabled: true,
      reserveTokens: 500,
      keepRecentTokens: 200,
      restoreFileContents: false,
    },
    recordLlmUsage: true,
    llmUsageLogPath: usageLogPath,
    enableSteering: false,
    enableFollowUpGuard: false,
  });

  for (let index = 0; index < 10; index++) {
    await store.appendMessage('usage', {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index === 0 ? 'Remember BANANA-7749. ' : ''}${'history '.repeat(120)}`,
    });
  }

  const compacted = await agent.compactSession('usage');
  assert.equal(compacted.compacted, true);
  const records = (await fs.readFile(usageLogPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.length >= 1, 'every compaction provider call must appear in the usage log');
  assert.ok(records.every((record) => record.inputTokens === 500));
  assert.ok(records.every((record) => record.outputTokens === 40));
  assert.ok(records.every((record) => record.model === 'compact-e2e-model'));
  assert.ok(records.every((record) => /^compact:usage:/.test(record.runId)));
});

test('manual compaction honors a pre-aborted signal before calling the provider', async () => {
  const store = new InMemorySessionStore();
  const provider = providerWithSummaryAndContinuation();
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'You are a coding agent.',
    domainPrompt: false,
    contextTokens: 4_000,
    maxTokens: 500,
    compactionSettings: {
      enabled: true,
      reserveTokens: 500,
      keepRecentTokens: 200,
      restoreFileContents: false,
    },
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  for (let index = 0; index < 10; index++) {
    await store.appendMessage('aborted', {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${'history '.repeat(120)}`,
    });
  }
  const controller = new AbortController();
  controller.abort(new Error('compaction cancelled'));

  await assert.rejects(
    agent.compactSession('aborted', undefined, { abortSignal: controller.signal }),
    /compaction cancelled/
  );
  assert.equal(provider.calls.length, 0, 'pre-aborted compaction must not call the provider');
});

test('manual compaction persists complete tool use and result pairs across resume', async () => {
  const store = new InMemorySessionStore();
  const provider = providerWithSummaryAndContinuation();
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'You are a coding agent.',
    domainPrompt: false,
    contextTokens: 100_000,
    maxTokens: 500,
    compactionSettings: {
      enabled: true,
      reserveTokens: 500,
      keepRecentTokens: 1,
      restoreFileContents: false,
    },
    enableSteering: false,
    enableFollowUpGuard: false,
  });

  await store.appendMessage('tool-pair', { role: 'user', content: 'old request' });
  await store.appendMessage('tool-pair', { role: 'assistant', content: 'old answer' });
  await store.appendMessage('tool-pair', { role: 'user', content: 'inspect the README next' });
  await store.appendMessage('tool-pair', {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'README.md' } }],
  });
  await store.appendMessage('tool-pair', {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'read-1', name: 'read_file', content: 'README contents' },
    ],
  });
  await store.appendMessage('tool-pair', { role: 'assistant', content: 'I inspected the README.' });
  await store.appendMessage('tool-pair', { role: 'user', content: 'continue from that evidence' });
  await store.appendMessage('tool-pair', { role: 'assistant', content: 'I will continue.' });

  const compacted = await agent.compactSession('tool-pair');
  assert.equal(compacted.compacted, true);
  const persisted = await store.loadMessages('tool-pair');
  const serialized = JSON.stringify(persisted);
  assert.match(serialized, /"type":"tool_result","tool_use_id":"read-1"/);
  assert.match(serialized, /"type":"tool_use","id":"read-1"/);
  assert.ok(
    serialized.indexOf('"type":"tool_use","id":"read-1"') <
      serialized.indexOf('"type":"tool_result","tool_use_id":"read-1"'),
    'tool_use remains before its result in persisted compacted history'
  );
});
