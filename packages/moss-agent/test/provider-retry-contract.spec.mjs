#!/usr/bin/env node
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

function makeAgent(provider, maxLLMRetries = 1) {
  return new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxLLMRetries,
  });
}

{
  let calls = 0;
  const provider = {
    id: 'no-retry',
    displayName: 'no-retry',
    async complete() {
      throw new Error('not used');
    },
    async stream() {
      calls++;
      const error = new Error('rate limit exceeded');
      error.status = 429;
      throw error;
    },
  };
  const agent = makeAgent(provider, 0);
  await assert.rejects(() => agent.chat('no-retry', 'hello'), /rate limit exceeded/);
  assert.equal(calls, 1, 'maxLLMRetries=0 disables retry');
}

{
  let calls = 0;
  const provider = {
    id: 'one-retry-fails',
    displayName: 'one-retry-fails',
    async complete() {
      throw new Error('not used');
    },
    async stream() {
      calls++;
      const error = new Error('rate limit exceeded');
      error.status = 429;
      throw error;
    },
  };
  const agent = makeAgent(provider, 1);
  await assert.rejects(() => agent.chat('one-retry-fails', 'hello'), /rate limit exceeded/);
  assert.equal(calls, 2, 'maxLLMRetries=1 means initial call plus exactly one retry');
}

{
  let calls = 0;
  const provider = {
    id: 'auth-fail',
    displayName: 'auth-fail',
    async complete() {
      throw new Error('not used');
    },
    async stream() {
      calls++;
      const error = new Error('Invalid API key');
      error.status = 401;
      throw error;
    },
  };
  const agent = makeAgent(provider);
  await assert.rejects(() => agent.chat('auth', 'hello'), /Invalid API key/);
  assert.equal(calls, 1, '401 is never retried by either provider or agent loop');
}

{
  let calls = 0;
  const provider = {
    id: 'rate-limit',
    displayName: 'rate-limit',
    async complete() {
      throw new Error('not used');
    },
    async stream(_options, onEvent) {
      calls++;
      if (calls === 1) {
        const error = new Error('rate limit exceeded');
        error.status = 429;
        throw error;
      }
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_start' });
      onEvent({ type: 'content_block_delta', text: 'recovered' });
      onEvent({ type: 'content_block_stop' });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'recovered' }] };
    },
  };
  const agent = makeAgent(provider);
  let result;
  try {
    result = await agent.chat('rate', 'hello');
  } catch (error) {
    error.message += ` [provider calls=${calls}]`;
    throw error;
  }
  assert.equal(result.response, 'recovered');
  assert.equal(calls, 2, '429 gets one bounded retry, not nested retry loops');
}

{
  let calls = 0;
  const provider = {
    id: 'missing-terminal-marker',
    displayName: 'missing-terminal-marker',
    async complete() {
      throw new Error('not used');
    },
    async stream(_options, onEvent) {
      calls++;
      if (calls === 1) {
        throw new Error('LLM stream incomplete: Stream ended without finish_reason');
      }
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_start' });
      onEvent({ type: 'content_block_delta', text: 'recovered after truncated stream' });
      onEvent({ type: 'content_block_stop' });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'recovered after truncated stream' }],
      };
    },
  };
  const agent = makeAgent(provider);
  const result = await agent.chat('missing-terminal-marker', 'hello');
  assert.equal(result.response, 'recovered after truncated stream');
  assert.equal(calls, 2, 'a stream missing finish_reason is retried inside the same agent run');
}

console.log('[PASS] provider auth and rate-limit retry contracts');
