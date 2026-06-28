#!/usr/bin/env node
/**
 * Model context-window resolution — API query, name-based fallback, and
 * the combined resolver chain.
 */
import assert from 'node:assert/strict';

import { resolveModelContextWindow } from '../dist/cli/config.js';
import {
  resolveModelContextWindowFromApi,
  resolveContextTokensForModel,
} from '../dist/cli/model-catalog.js';

// ─── 1. resolveModelContextWindow — expanded name patterns ─────────────

{
  const cases = [
    ['gpt-4o', 128_000],
    ['gpt-4o-mini', 128_000],
    ['claude-sonnet-4-20250514', 200_000],
    ['llama-3.1-70b-instruct', 128_000],
    ['mistral-large-latest', 32_000],
    ['mixtral-8x7b-instruct', 32_000],
    ['gemma-2-9b', 8_000],
    ['command-r-plus', 128_000],
    ['phi-3-mini', 4_000],
    ['yi-34b-chat', 32_000],
    ['glm-4-plus', 128_000],
    ['deepseek-chat', 64_000],
    ['qwen2.5-72b-instruct', 32_000],
    ['some-unknown-model', 1_000_000],
  ];

  for (const [model, expected] of cases) {
    const got = resolveModelContextWindow(model);
    assert.equal(
      got,
      expected,
      `resolveModelContextWindow("${model}") should be ${expected}, got ${got}`
    );
  }
}

// ─── 2. resolveModelContextWindowFromApi — Ollama /api/show ─────────────

{
  // Mock fetch that returns an Ollama-style /api/show response
  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/show')) {
      const body = JSON.parse(init?.body ?? '{}');
      if (body.name === 'llama3.1:70b') {
        return {
          ok: true,
          json: async () => ({
            model_info: {
              'general.architecture': 'llama',
              'llama.context_length': 131072,
              'llama.embedding_length': 4096,
            },
          }),
        };
      }
    }
    return { ok: false, json: async () => ({}) };
  };

  const result = await resolveModelContextWindowFromApi({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.1:70b',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  assert.equal(result, 131072, `Ollama /api/show should return 131072, got ${result}`);
}

{
  // Ollama with gemma model — different architecture key
  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/show')) {
      return {
        ok: true,
        json: async () => ({
          model_info: {
            'general.architecture': 'gemma2',
            'gemma2.context_length': 8192,
          },
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  const result = await resolveModelContextWindowFromApi({
    baseUrl: 'http://localhost:11434/v1',
    model: 'gemma2:9b',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  assert.equal(result, 8192, `Ollama gemma2 should return 8192, got ${result}`);
}

// ─── 3. resolveModelContextWindowFromApi — vLLM max_model_len ───────────

{
  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/v1/models')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'llama-3.1-70b', max_model_len: 131072 },
            { id: 'qwen2.5-7b', max_model_len: 32768 },
          ],
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  const result = await resolveModelContextWindowFromApi({
    baseUrl: 'http://vllm-server:8000',
    apiKey: 'fake-key',
    model: 'llama-3.1-70b',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  assert.equal(result, 131072, `vLLM max_model_len should return 131072, got ${result}`);
}

{
  // Test context_length field (some gateways use this instead of max_model_len)
  const mockFetch = async (url) => {
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: 'custom-model', context_length: 65536 },
        ],
      }),
    };
  };

  const result = await resolveModelContextWindowFromApi({
    baseUrl: 'http://gateway:8000',
    apiKey: 'fake-key',
    model: 'custom-model',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  assert.equal(result, 65536, `context_length field should return 65536, got ${result}`);
}

// ─── 4. resolveModelContextWindowFromApi — returns undefined on failure ──

{
  // Network error → undefined
  const mockFetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  const result = await resolveModelContextWindowFromApi({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.1:70b',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  assert.equal(result, undefined, `Network error should return undefined, got ${result}`);
}

{
  // HTTP 404 → undefined
  const mockFetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'not found' }),
  });

  const result = await resolveModelContextWindowFromApi({
    baseUrl: 'http://localhost:11434',
    model: 'nonexistent',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  assert.equal(result, undefined, `HTTP 404 should return undefined, got ${result}`);
}

{
  // No context window info in response → undefined
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{ id: 'some-model' }], // no max_model_len, no context_length
    }),
  });

  const result = await resolveModelContextWindowFromApi({
    baseUrl: 'http://localhost:8000',
    apiKey: 'fake-key',
    model: 'some-model',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  assert.equal(result, undefined, `No context window info should return undefined, got ${result}`);
}

// ─── 5. resolveContextTokensForModel — fallback chain ───────────────────

{
  // Explicit override takes precedence
  const result = await resolveContextTokensForModel({
    model: 'llama-3.1-70b',
    explicitOverride: 999_999,
  });
  assert.equal(result.contextTokens, 999_999);
  assert.equal(result.source, 'user-override');
}

{
  // API returns a value → use it
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{ id: 'llama-3.1-70b', max_model_len: 131072 }],
    }),
  });

  const result = await resolveContextTokensForModel({
    model: 'llama-3.1-70b',
    baseUrl: 'http://vllm:8000',
    apiKey: 'fake-key',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });
  assert.equal(result.contextTokens, 131072);
  assert.equal(result.source, 'provider-api');
}

{
  // API fails → fall back to name matching
  const mockFetch = async () => { throw new Error('timeout'); };

  const result = await resolveContextTokensForModel({
    model: 'llama-3.1-70b',
    baseUrl: 'http://vllm:8000',
    apiKey: 'fake-key',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });
  assert.equal(result.contextTokens, 128_000);
  assert.equal(result.source, 'name-matching');
}

{
  // No baseUrl → skip API, go straight to name matching
  const result = await resolveContextTokensForModel({
    model: 'claude-sonnet-4-20250514',
  });
  assert.equal(result.contextTokens, 200_000);
  assert.equal(result.source, 'name-matching');
}

{
  // Unknown model → name matching returns 1M default
  const result = await resolveContextTokensForModel({
    model: 'totally-unknown-model',
  });
  assert.equal(result.contextTokens, 1_000_000);
  assert.equal(result.source, 'name-matching');
}

console.log('✓ model-context-window: all tests passed');
