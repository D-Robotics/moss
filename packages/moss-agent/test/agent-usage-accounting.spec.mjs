#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { runProactiveWindowCompaction } from '../dist/core/loop/agent-loop-compaction.js';
import { readUsageLog } from '../dist/observability/llm-usage.js';

function addUsage(total, usage) {
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.cacheReadTokens += usage.cacheReadTokens ?? 0;
  total.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  return total;
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function createProvider(actualUsages) {
  let callIndex = 0;
  return {
    id: 'usage-accounting-fixture',
    capabilities: { streaming: true },
    async complete(options) {
      callIndex += 1;
      const isCompaction = options.systemPrompt.includes('上下文摘要助手');
      const usage = isCompaction
        ? {
            inputTokens: 100 + callIndex,
            outputTokens: 20 + callIndex,
            cacheReadTokens: 5,
            cacheCreationTokens: 3,
          }
        : {
            inputTokens: 600 + callIndex,
            outputTokens: 30 + callIndex,
            cacheReadTokens: 11,
            cacheCreationTokens: 7,
          };
      actualUsages.push(usage);
      return {
        stopReason: 'end_turn',
        content: [{
          type: 'text',
          text: isCompaction ? '<summary>Preserved working context.</summary>' : 'done',
        }],
        usage,
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

test('automatic compaction usage is consistent across stream, ChatResult, and JSONL', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-usage-accounting-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const usageLogPath = path.join(dir, 'usage.jsonl');
  const store = new InMemorySessionStore();
  const actualUsages = [];
  const agent = new MossAgent({
    llmProvider: createProvider(actualUsages),
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
    recordLlmUsage: true,
    llmUsageLogPath: usageLogPath,
  });
  t.after(() => agent.dispose());

  for (let index = 0; index < 12; index++) {
    await store.appendMessage('usage', {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `history-${index} ${'filler '.repeat(100)}`,
    });
  }

  const streamUsage = zeroUsage();
  let compactions = 0;
  let result;
  for await (const event of agent.streamChat('usage', 'Continue.')) {
    if (event.type === 'llm_usage') addUsage(streamUsage, event);
    if (event.type === 'compaction') compactions += 1;
    if (event.type === 'done') result = event.result;
  }

  assert.ok(compactions > 0, 'the fixture must exercise automatic compaction');
  assert.ok(actualUsages.length > 1, 'provider must receive compaction and answer calls');
  const expected = actualUsages.reduce(addUsage, zeroUsage());
  assert.deepEqual(streamUsage, expected, 'stream usage includes every provider call');
  assert.deepEqual(
    {
      inputTokens: result?.usage?.inputTokens ?? 0,
      outputTokens: result?.usage?.outputTokens ?? 0,
      cacheReadTokens: result?.usage?.cacheReadTokens ?? 0,
      cacheCreationTokens: result?.usage?.cacheCreationTokens ?? 0,
    },
    expected,
    'ChatResult usage includes automatic compaction work',
  );

  const logged = await readUsageLog({ logPath: usageLogPath });
  const loggedTotal = logged.reduce(addUsage, zeroUsage());
  assert.equal(logged.length, actualUsages.length, 'JSONL records each provider call exactly once');
  assert.deepEqual(loggedTotal, expected, 'workspace log and current request report the same usage');
});

test('a failed compaction attempt still emits usage for the provider call', async () => {
  const events = [];
  const outcome = await runProactiveWindowCompaction({
    sessionKey: 'failed-compaction',
    runId: 'failed-compaction-run',
    currentMessages: [],
    rawTotalChars: 1_000,
    promptUnitsForWindow: 500,
    prepareCompaction: async () => ({
      usage: [{ inputTokens: 321, outputTokens: 4, cacheReadTokens: 9 }],
    }),
    persistCurrentMessages: async () => {},
    push: (event) => events.push(event),
  });

  assert.equal(outcome.succeeded, false);
  assert.deepEqual(events, [{
    type: 'llm_usage',
    inputTokens: 321,
    outputTokens: 4,
    cacheReadTokens: 9,
  }]);
});
