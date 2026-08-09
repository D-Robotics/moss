#!/usr/bin/env node
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { PendingToolAbortStore } from '../dist/core/loop/pending-tool-aborts.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { KnowledgeRegistry } from '../dist/knowledge/registry.js';

const provider = {
  id: 'agent-owned-resource-lifecycle',
  capabilities: { streaming: true },
  async complete() {
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
  async stream(options, onEvent) {
    const result = await this.complete(options);
    onEvent({ type: 'content_block_delta', text: 'done' });
    onEvent({ type: 'message_stop' });
    return result;
  },
};

function createAgent(options = {}) {
  return new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    ...options,
  });
}

function createKnowledgeModule(id, prompt) {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'lifecycle test knowledge',
    platforms: ['test-platform'],
    getDeviceProfiles: () => ({}),
    getDocIndex: () => [],
    getPromptFragments: () => [],
    getCommandPatterns: () => [],
    getFailureHints: () => [],
    getEcosystemPrompt: () => prompt,
  };
}

{
  const sharedKnowledge = new KnowledgeRegistry();
  const module = createKnowledgeModule('shared-knowledge', 'SHARED-KNOWLEDGE-MARKER');
  sharedKnowledge.register(module);

  const agent = createAgent({ knowledgeRegistry: sharedKnowledge });
  agent.dispose();

  assert.equal(
    sharedKnowledge.get(module.id),
    module,
    'disposing an agent must not clear a host-injected knowledge registry'
  );
}

{
  const agent = createAgent();
  agent.registerKnowledge(createKnowledgeModule('owned-knowledge', 'OWNED-KNOWLEDGE-MARKER'));
  assert.match(agent.buildSystemPrompt(), /OWNED-KNOWLEDGE-MARKER/);

  agent.dispose();

  assert.doesNotMatch(
    agent.buildSystemPrompt(),
    /OWNED-KNOWLEDGE-MARKER/,
    'disposing an agent clears the knowledge registry it created'
  );
}

{
  const store = new PendingToolAbortStore();
  store.note('consume-session', [{ id: 'tool-1', name: 'exec' }]);
  assert.ok(store.gcTimer, 'noting a pending abort starts garbage collection');

  store.consumeSyntheticMessages('consume-session');

  assert.equal(store.gcTimer, undefined, 'consuming the final entry stops garbage collection');
}

{
  const store = new PendingToolAbortStore();
  store.note('clear-session', [{ id: 'tool-1', name: 'exec' }]);

  store.clear();

  assert.deepEqual(store.consumeSyntheticMessages('clear-session'), []);
  assert.equal(store.gcTimer, undefined, 'clear stops garbage collection immediately');
}

{
  const store = new PendingToolAbortStore();
  store.note('dispose-session', [{ id: 'tool-1', name: 'exec' }]);

  store.dispose();
  store.dispose();
  store.note('dispose-session', [{ id: 'tool-2', name: 'exec' }]);

  assert.deepEqual(store.consumeSyntheticMessages('dispose-session'), []);
  assert.equal(
    store.gcTimer,
    undefined,
    'dispose is terminal, idempotent, and stops garbage collection'
  );
}

{
  const agent = createAgent();
  agent.pendingToolAborts.note('agent-session', [{ id: 'tool-1', name: 'exec' }]);

  agent.dispose();

  assert.deepEqual(agent.pendingToolAborts.consumeSyntheticMessages('agent-session'), []);
  assert.equal(
    agent.pendingToolAborts.gcTimer,
    undefined,
    'disposing an agent clears its pending abort store'
  );
}

console.log('✅ agent-owned-resource-lifecycle.spec.mjs — all tests passed');
