#!/usr/bin/env node
/**
 * LLM protocol routing: a provider preset resolves to the correct wire protocol
 * (Anthropic Messages vs OpenAI-compatible Chat), and the router dispatches to
 * the registered handler.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { protocolIdForProvider, createProtocolRouter } from '../dist/core/llm/protocol-route.js';

// Anthropic speaks its Messages API; everything else is OpenAI-compatible Chat.
assert.equal(protocolIdForProvider('anthropic'), 'anthropic-messages');
for (const preset of ['openai', 'deepseek', 'qwen', 'openai-compatible']) {
  assert.equal(protocolIdForProvider(preset), 'openai-chat', `${preset} -> openai-chat`);
}

let lastCalled = '';
const router = createProtocolRouter([
  { id: 'anthropic-messages', handle: async () => ((lastCalled = 'anthropic-messages'), {}) },
  { id: 'openai-chat', handle: async () => ((lastCalled = 'openai-chat'), {}) },
]);

assert.equal(router.resolve('anthropic').id, 'anthropic-messages');
assert.equal(router.resolve('deepseek').id, 'openai-chat');
assert.deepEqual(router.ids().sort(), ['anthropic-messages', 'openai-chat']);

// resolve(...).handle(...) dispatches to the matching protocol.
await router.resolve('anthropic').handle({}, {}, () => {});
assert.equal(lastCalled, 'anthropic-messages');
await router.resolve('qwen').handle({}, {}, () => {});
assert.equal(lastCalled, 'openai-chat');

// An unregistered protocol id is a clear error, not a silent undefined dispatch.
assert.throws(() => createProtocolRouter([]).resolve('anthropic'), /No LLM protocol registered/);

console.log('[PASS] LLM protocol router resolves wire protocol by provider preset and dispatches');
