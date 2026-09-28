#!/usr/bin/env node
/**
 * Provider routing and error handling — tested from the user's perspective:
 * what error messages and routing decisions does the user experience.
 */
import assert from 'node:assert/strict';

import { providerErrorHint, providerError, createCliProvider } from '../dist/cli/providers.js';
import { PROVIDER_PRESETS } from '../dist/cli/config.js';

// ─── PROVIDER_PRESETS ────────────────────────────────────────────────────────

{
  const presets = Object.keys(PROVIDER_PRESETS);
  for (const expected of ['deepseek', 'qwen', 'openai', 'anthropic', 'openai-compatible']) {
    assert.ok(presets.includes(expected), `PROVIDER_PRESETS includes '${expected}'`);
  }
}

// Each preset has a displayName and an id matching its key
for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
  assert.ok(preset.displayName, `${name} preset has a displayName`);
  assert.equal(preset.id, name, `${name} preset id matches its key`);
}

// ─── providerErrorHint ────────────────────────────────────────────────────────

{
  const hint = providerErrorHint(401);
  assert.ok(
    hint.includes('API key') || hint.includes('apiKey'),
    '401 hint points to API key problem'
  );
  assert.ok(
    hint.includes('moss setup') || hint.includes('moss config'),
    '401 hint shows how to fix it'
  );
}

{
  const hint = providerErrorHint(403);
  assert.ok(
    hint.includes('API key') || hint.includes('apiKey'),
    '403 hint points to API key problem'
  );
}

{
  const hint = providerErrorHint(429);
  assert.ok(
    hint.toLowerCase().includes('rate') || hint.toLowerCase().includes('limit'),
    '429 hint mentions rate limiting'
  );
}

{
  const hint = providerErrorHint(500);
  assert.ok(
    hint.toLowerCase().includes('retry') || hint.toLowerCase().includes('gateway'),
    '5xx hint suggests retry'
  );
}

{
  const hint = providerErrorHint(200);
  assert.equal(hint, '', '200 OK has no hint');
}

// ─── providerError ────────────────────────────────────────────────────────────

{
  const err = providerError('DeepSeek', 401, 'Unauthorized');
  assert.ok(err instanceof Error, 'returns an Error instance');
  assert.ok(err.message.includes('401'), 'error message includes HTTP status');
  assert.ok(err.message.includes('DeepSeek'), 'error message includes provider name');
  // The hint should be appended for actionable errors
  assert.ok(
    err.message.includes('moss setup') || err.message.includes('apiKey'),
    'error message includes remediation hint'
  );
}

{
  // JSON error responses should extract the human-readable message
  const jsonBody = JSON.stringify({ error: { message: 'Invalid API key provided' } });
  const err = providerError('OpenAI', 401, jsonBody);
  assert.ok(
    err.message.includes('Invalid API key provided'),
    'extracts human-readable message from JSON body'
  );
  assert.ok(!err.message.includes('"error"'), 'does not include raw JSON keys in message');
}

{
  // Very long error bodies should be truncated
  const longBody = 'x'.repeat(500);
  const err = providerError('Qwen', 500, longBody);
  assert.ok(err.message.length < 600, 'long error bodies are truncated to user-readable length');
}

{
  // 429 from built-in gateway should mention switching to own key
  const err = providerError('OpenAI-compatible', 429, 'quota exceeded');
  assert.ok(
    err.message.includes('rate') || err.message.includes('retry') || err.message.length > 20,
    'rate limit error is informative'
  );
}

// ─── createCliProvider returns a usable LLM provider ─────────────────────────

{
  const provider = createCliProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com/v1',
  });
  assert.ok(typeof provider.stream === 'function', 'provider has stream method');
  assert.ok(typeof provider.complete === 'function', 'provider has complete method');
  assert.equal(provider.capabilities?.streaming, true, 'CLI provider advertises streaming');
}

// OpenAI-compatible SSE path emits content_block_delta as tokens arrive
{
  const chunks = [
    'data: {"id":"c1","choices":[{"delta":{"content":"PO"}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{"content":"NG"},"finish_reason":"stop"}]}\n\n',
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}\n\n',
    'data: [DONE]\n\n',
  ];
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  try {
    const provider = createCliProvider({
      provider: 'openai-compatible',
      apiKey: 'sk-test',
      model: 'test-model',
      baseUrl: 'https://example.invalid/v1',
    });
    const deltas = [];
    const result = await provider.stream(
      {
        model: 'test-model',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 64,
      },
      (e) => {
        if (e.type === 'content_block_delta' && e.text) deltas.push(e.text);
      }
    );
    assert.deepEqual(deltas, ['PO', 'NG'], 'SSE text deltas forwarded in order');
    assert.equal(result.content[0]?.type, 'text');
    assert.equal(result.content[0]?.text, 'PONG');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.usage?.inputTokens, 12);
    assert.equal(result.usage?.outputTokens, 2);
    assert.equal(result.usage?.cacheReadTokens, 8, 'cached_tokens surfaced as cacheReadTokens');
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log('[PASS] Provider routing and error handling');

// ─── anthropic-messages native SSE transport (pi-ai convergence) ────────────

// Full assistant turn over mocked SSE: thinking + text + tool_use assembled
// from input_json_delta, usage incl. cache tokens, cache-control injected via
// the systemPromptParts onPayload hook.
{
  const frames = [
    'data: ' +
      JSON.stringify({
        type: 'message_start',
        message: {
          usage: { input_tokens: 100, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
        },
      }),
    'data: ' +
      JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      }),
    'data: ' +
      JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think.' },
      }),
    'data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }),
    'data: ' +
      JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
    'data: ' +
      JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Answ' },
      }),
    'data: ' +
      JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'ering.' },
      }),
    'data: ' + JSON.stringify({ type: 'content_block_stop', index: 1 }),
    'data: ' +
      JSON.stringify({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'exec' },
      }),
    'data: ' +
      JSON.stringify({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"command":"echo' },
      }),
    'data: ' +
      JSON.stringify({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: ' hi"}' },
      }),
    'data: ' + JSON.stringify({ type: 'content_block_stop', index: 2 }),
    'data: ' +
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 25 },
      }),
    'data: ' + JSON.stringify({ type: 'message_stop' }),
  ].join('\n\n');

  let captured;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  };
  try {
    const provider = createCliProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4',
      baseUrl: 'https://api.anthropic.test',
    });
    const events = [];
    const result = await provider.stream(
      {
        model: 'claude-sonnet-4',
        systemPrompt: 'BASE DYNAMIC',
        systemPromptParts: { stable: 'BASE', dynamic: 'DYNAMIC' },
        messages: [
          { role: 'user', content: 'run echo and ls' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu_a', name: 'exec', input: { command: 'echo hi' } },
              { type: 'tool_use', id: 'tu_b', name: 'exec', input: { command: 'ls' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu_a', content: 'hi', is_error: false },
              { type: 'tool_result', tool_use_id: 'tu_b', content: 'x\ny', is_error: false },
            ],
          },
        ],
        tools: [{ name: 'exec', description: 'run', input_schema: { type: 'object' } }],
        maxTokens: 128,
      },
      (e) => events.push(e)
    );

    // wire shape: anthropic messages endpoint, auth headers, body conversion
    assert.ok(captured.url.endsWith('/v1/messages'), 'hits the anthropic messages endpoint');
    assert.equal(captured.headers['x-api-key'], 'sk-ant-test', 'x-api-key header');
    assert.equal(captured.headers['anthropic-version'], '2023-06-01', 'anthropic-version header');
    assert.equal(captured.body.model, 'claude-sonnet-4', 'model in body');
    assert.equal(captured.body.stream, true, 'native streaming requested');
    assert.deepEqual(
      captured.body.tools[0].input_schema,
      { type: 'object' },
      'tools use input_schema'
    );
    // cache-control injection via systemPromptParts
    assert.ok(Array.isArray(captured.body.system), 'system split into blocks');
    assert.deepEqual(
      captured.body.system[0].cache_control,
      { type: 'ephemeral' },
      'stable system block gets cache_control'
    );
    assert.equal(captured.body.system[0].text, 'BASE', 'stable block first');
    assert.equal(captured.body.system[1].text, 'DYNAMIC', 'dynamic block second');

    // stream events: thinking then visible text, in order
    const deltas = events.filter((e) => e.type === 'content_block_delta');
    assert.equal(deltas[0].deltaRole, 'thinking', 'thinking delta forwarded first');
    assert.equal(deltas[1].deltaRole, 'visible', 'text delta follows');
    assert.equal(deltas[1].text, 'Answ', 'text delta order preserved');

    // assembled response: text + tool_use with streamed-args parsed
    const textBlock = result.content.find((b) => b.type === 'text');
    assert.equal(textBlock.text, 'Answering.', 'text assembled across deltas');
    const toolBlock = result.content.find((b) => b.type === 'tool_use');
    assert.equal(toolBlock.id, 'tu_1', 'tool_use id');
    assert.equal(toolBlock.name, 'exec', 'tool_use name');
    assert.deepEqual(
      toolBlock.input,
      { command: 'echo hi' },
      'input_json_delta assembled into parsed args'
    );
    assert.equal(result.stopReason, 'tool_use', 'stop_reason mapped');
    assert.equal(result.usage.inputTokens, 100, 'usage input tokens');
    assert.equal(result.usage.outputTokens, 25, 'usage output tokens from message_delta');
    assert.equal(result.usage.cacheReadTokens, 7, 'cache read tokens surfaced');
    assert.equal(result.usage.cacheCreationTokens, 3, 'cache creation tokens surfaced');
    assert.ok(result.thinking?.includes('Let me think.'), 'thinking round-tripped');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// anthropic HTTP error mapping keeps the spec-locked providerError contract
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
  try {
    const provider = createCliProvider({
      provider: 'anthropic',
      apiKey: 'bad',
      model: 'claude-sonnet-4',
      baseUrl: 'https://api.anthropic.test',
    });
    await assert.rejects(
      () =>
        provider.stream(
          {
            model: 'claude-sonnet-4',
            systemPrompt: 's',
            messages: [{ role: 'user', content: 'x' }],
            maxTokens: 8,
          },
          () => {}
        ),
      (err) => err.message.includes('401') && err.message.includes('invalid x-api-key'),
      'anthropic 401 surfaces providerError with status + extracted message'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
}
