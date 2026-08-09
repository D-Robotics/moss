#!/usr/bin/env node
import assert from 'node:assert/strict';

import { runAgentLoopLlmTurn } from '../dist/core/loop/agent-loop-stream-helpers.js';

const originalTimeout = process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS;
try {
  process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS = '25';
  let calls = 0;
  const createNeverEndingStream = () => ({
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
    result() {
      return new Promise(() => {});
    },
  });
  const startedAt = Date.now();
  await assert.rejects(
    runAgentLoopLlmTurn({
      stream: { push() {} },
      modelDef: { api: 'test', provider: 'test', id: 'stalled', maxTokens: 128 },
      piContext: { messages: [] },
      streamFn: () => {
        calls += 1;
        return createNeverEndingStream();
      },
      maxLLMRetries: 2,
      abortSignal: new AbortController().signal,
      messagesForModel: [],
      toolsForRun: [],
      sessionKey: 'stalled-first-chunk',
      turn: 1,
      runStartMs: startedAt,
      firstTokenMs: null,
      logDebug() {},
    }),
    /no streaming output.*within 0s/i
  );
  assert.equal(calls, 2, 'a silent first-chunk timeout gets at most one recovery retry');
  assert.ok(
    Date.now() - startedAt < 1000,
    'a provider that ignores AbortSignal cannot hang the loop'
  );
  console.log('[PASS] first-chunk timeout hard-stops an uncooperative provider');
} finally {
  if (originalTimeout === undefined) delete process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS;
  else process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS = originalTimeout;
}
