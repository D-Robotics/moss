#!/usr/bin/env node
/** The first model request waits until the proxy dispatcher is installed. */
import assert from 'node:assert/strict';
import { getGlobalDispatcher } from 'undici';

import { runAgentLoop } from '../dist/core/loop/agent-loop.js';

const saved = process.env.HTTPS_PROXY;
process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
delete process.env.MOSS_DISABLE_CONN_WARMUP;

const before = getGlobalDispatcher().constructor.name;
let seen = before;

const assistant = {
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  api: 'openai-completions',
  provider: 'openai',
  model: 'm',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
};

const stream = runAgentLoop({
  runId: 'proxy-1',
  sessionKey: 'proxy-session',
  agentId: 'proxy-agent',
  currentMessages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  compactionSummary: undefined,
  systemPrompt: 'system',
  toolsForRun: [],
  toolCtx: { workspaceDir: '/tmp', sessionKey: 'proxy-session' },
  modelDef: { api: 'openai-completions', provider: 'openai', id: 'm' },
  streamFn: () => {
    seen = getGlobalDispatcher().constructor.name;
    return {
      async *[Symbol.asyncIterator]() {},
      result: async () => assistant,
    };
  },
  maxTurns: 1,
  contextTokens: 100_000,
  appendMessage: async () => {},
  prepareCompaction: async () => ({}),
  abortSignal: new AbortController().signal,
});

try {
  await stream.result();
} finally {
  if (saved === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = saved;
}

assert.notEqual(seen, before, 'dispatcher changed before the model request');
assert.equal(seen, 'EnvHttpProxyAgent');
console.log('[PASS] keep-alive dispatcher before first request');
