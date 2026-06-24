#!/usr/bin/env node
/**
 * Real-model disclosure tests.
 *
 * The bundled gateway advertises the billing placeholder "Moss" as its model
 * name; the real backing model only appears in the chat-completion response's
 * top-level `model` field. These tests cover the three pieces that turn that
 * into an honest answer:
 *   1. providers capture `response.model` into LLMResponse.model
 *   2. resolveRealModel probes once (on ask), caches, and is a no-op when the
 *      user configured their own (already-truthful) model
 *   3. the current_model tool + identity guidance disclose it
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/cli-real-model.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCliProvider } from '../dist/cli/providers.js';
import { resolveRealModel, readCachedRealModel } from '../dist/cli/model-resolution.js';
import { createModelInfoTool } from '../dist/cli/model-info-tool.js';
import { buildMossCliIdentity } from '../dist/cli/identity.js';

function freshConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-realmodel-'));
  return { MOSS_CONFIG_DIR: dir };
}

function mockProvider(model, counter = { n: 0 }) {
  return {
    counter,
    async complete() {
      counter.n += 1;
      return { content: [], stopReason: 'end_turn', ...(model ? { model } : {}) };
    },
  };
}

test('callOpenAI captures the response top-level model into LLMResponse.model', async () => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // The gateway echoes the real backing model even though the request asked
      // for the "Moss" placeholder.
      res.end(JSON.stringify({
        model: 'deepseek-v4-flash',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const provider = createCliProvider({
      provider: 'openai-compatible',
      apiKey: 'k',
      model: 'Moss',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      usingBundledDefault: true,
    });
    const resp = await provider.complete({
      model: 'Moss',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1,
    });
    assert.equal(resp.model, 'deepseek-v4-flash', 'real backing model must be surfaced on the response');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('resolveRealModel probes once on ask, then serves from cache (no repeat probe)', async () => {
  const env = freshConfigDir();
  const provider = mockProvider('deepseek-v4-flash');
  const config = { baseUrl: 'http://gw.example/v1', model: 'Moss', usingBundledDefault: true };

  const first = await resolveRealModel(provider, config, { env });
  assert.equal(first, 'deepseek-v4-flash');
  assert.equal(provider.counter.n, 1, 'exactly one probe on first ask');

  const second = await resolveRealModel(provider, config, { env });
  assert.equal(second, 'deepseek-v4-flash');
  assert.equal(provider.counter.n, 1, 'second ask is served from cache — no extra request');

  // Synchronous render-path read sees the cached value with no network.
  assert.equal(readCachedRealModel(config, { env }), 'deepseek-v4-flash');
});

test('resolveRealModel is a no-op for user-configured (non-bundled) providers', async () => {
  const env = freshConfigDir();
  const provider = mockProvider('should-not-be-used');
  const config = { baseUrl: 'http://api.example/v1', model: 'gpt-4o', usingBundledDefault: false };

  const real = await resolveRealModel(provider, config, { env });
  assert.equal(real, 'gpt-4o', 'configured model is already truthful');
  assert.equal(provider.counter.n, 0, 'must not probe when the user configured their own model');
  assert.equal(readCachedRealModel(config, { env }), 'gpt-4o');
});

test('resolveRealModel returns null when the probe fails (caller falls back)', async () => {
  const env = freshConfigDir();
  const failing = { async complete() { throw new Error('gateway unreachable'); } };
  const real = await resolveRealModel(failing, { baseUrl: 'http://down.example/v1', model: 'Moss', usingBundledDefault: true }, { env });
  assert.equal(real, null);
  assert.equal(readCachedRealModel({ baseUrl: 'http://down.example/v1', usingBundledDefault: true }, { env }), null);
});

test('current_model tool reports the real backing model', async () => {
  const env = freshConfigDir();
  const config = { baseUrl: 'http://gw.example/v1', model: 'Moss', usingBundledDefault: true };
  // Pre-cache so the tool resolves without env threading (tool uses process env).
  process.env.MOSS_CONFIG_DIR = env.MOSS_CONFIG_DIR;
  try {
    const tool = createModelInfoTool({ provider: mockProvider('deepseek-v4-flash'), config });
    const out = await tool.execute({}, {});
    assert.match(out, /deepseek-v4-flash/);
    assert.match(out, /built-in/i);
  } finally {
    delete process.env.MOSS_CONFIG_DIR;
  }
});

test('identity guides the agent to the current_model tool only on the bundled gateway', () => {
  const bundled = buildMossCliIdentity({ usingBundledDefault: true, model: 'Moss' });
  assert.match(bundled, /current_model/, 'bundled identity points at the tool');
  assert.match(bundled, /built-in model gateway/);

  const userModel = buildMossCliIdentity({ model: 'gpt-4o' });
  assert.doesNotMatch(userModel, /current_model/, 'user-configured identity already names the real model');
  assert.match(userModel, /gpt-4o/);
});
