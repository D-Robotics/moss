#!/usr/bin/env node
/**
 * Prefix-cache stability invariants (v0.8 roadmap A2/A3).
 *
 * Implicit prefix caches (DashScope et al.) match the messages array from the
 * front; anything volatile ahead of the history invalidates the whole cached
 * prefix. These specs lock the invariants that keep the prefix byte-stable:
 *  1. system prompt identical across turns regardless of extraContext
 *  2. volatile extraContext rides ONLY the current turn's user message
 *  3. the persisted history stays clean (resume/compaction never see it)
 *  4. tools serialization identical across turns (order + schema bytes)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

function capturingProvider(captured) {
  const respond = () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  return {
    id: 'capture',
    displayName: 'capture',
    capabilities: { streaming: true },
    async complete(opts) {
      captured.push(opts);
      return respond();
    },
    async stream(opts, onEvent) {
      captured.push(opts);
      onEvent?.({ type: 'message_start' });
      return respond();
    },
  };
}

test('system prompt and tools stay byte-identical across turns; extraContext rides the current user message only', async () => {
  const captured = [];
  const store = new InMemorySessionStore();
  const agent = new MossAgent({
    llmProvider: capturingProvider(captured),
    sessionStore: store,
    model: 'prefix-stability',
    baseSystemPrompt: 'You are Moss. Stable persona.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 4,
  });
  agent.tools.register({
    name: 'probe_a',
    description: 'Probe A.',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    async execute() {
      return 'a';
    },
  });
  agent.tools.register({
    name: 'probe_b',
    description: 'Probe B.',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'b';
    },
  });

  const sessionKey = 'prefix-stability';
  for await (const _ of agent.streamChat(sessionKey, 'first question', {
    extraContext: 'git: clean tree @ abc123',
  })) {
    void _;
  }
  for await (const _ of agent.streamChat(sessionKey, 'second question', {
    extraContext: 'git: dirty tree @ def456 (M src/x.ts)',
  })) {
    void _;
  }

  assert.equal(captured.length, 2, 'two model calls captured');

  // 1. system prompt byte-identical, no volatile context inside
  assert.equal(captured[0].systemPrompt, captured[1].systemPrompt, 'system identical across turns');
  assert.ok(!captured[0].systemPrompt.includes('git:'), 'no git snapshot in system');
  assert.ok(captured[0].systemPrompt.length > 0, 'system prompt non-empty');

  // 2. extraContext appears only in the CURRENT turn's last user message
  const last1 = captured[0].messages[captured[0].messages.length - 1];
  const last2 = captured[1].messages[captured[1].messages.length - 1];
  const textOf = (m) =>
    typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('\n');
  assert.match(
    textOf(last1),
    /<turn-context>\s*git: clean tree @ abc123\s*<\/turn-context>/,
    'turn 1 context attached to its user message'
  );
  assert.match(
    textOf(last2),
    /<turn-context>\s*git: dirty tree @ def456[^\n]*\s*<\/turn-context>/,
    'turn 2 context attached to its user message'
  );
  // turn 2's request must NOT carry turn 1's context anywhere in history
  assert.ok(
    !JSON.stringify(captured[1].messages.slice(0, -1)).includes('abc123'),
    'previous volatile context absent from later history'
  );

  // 3. persisted history stays clean
  const stored = await store.loadMessages(sessionKey);
  assert.ok(
    !JSON.stringify(stored).includes('<turn-context>'),
    'persisted history never contains turn context'
  );

  // 4. tools serialization identical across turns
  assert.equal(
    JSON.stringify(captured[0].tools),
    JSON.stringify(captured[1].tools),
    'tools JSON byte-identical across turns'
  );
  const toolNames = captured[0].tools.map((t) => t.name);
  assert.deepEqual(toolNames, ['probe_a', 'probe_b'], 'tool order follows registration order');

  // 5. prompt cache parts: stable present, dynamic absent
  assert.equal(
    captured[0].systemPromptParts?.stable,
    captured[0].systemPrompt,
    'parts.stable === system'
  );
  assert.equal(captured[0].systemPromptParts?.dynamic, undefined, 'no dynamic tail');
});

console.log('[PASS] prefix-cache stability invariants');
