#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import {
  activateWebPluginCandidate,
  disableWebPlugin,
} from '../dist/web-ui/web-plugin-lifecycle.js';

function plugin() {
  return {
    id: 'fixture/transaction',
    setup(context) {
      context.registerCommand({
        id: 'transaction-command',
        title: 'Transaction command',
        expand: () => 'LAST_GOOD',
      });
    },
  };
}

function agent() {
  return new MossAgent({
    llmProvider: {
      id: 'plugin-transaction-test',
      displayName: 'Plugin transaction test',
      capabilities: { streaming: false },
      async complete() {
        return { stopReason: 'end_turn', content: [] };
      },
      async stream() {
        throw new Error('streaming disabled');
      },
    },
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
}

test('failed registry disable restores the last-good runtime generation', async () => {
  const instance = agent();
  await instance.plugins.install(plugin());
  const generation = instance.plugins.inspect().generation;
  const registry = {
    async disable() {
      throw new Error('REGISTRY_COMMIT_FAILED');
    },
    async loadInstalled() {
      return plugin();
    },
  };
  try {
    await assert.rejects(
      disableWebPlugin(instance, registry, 'fixture/transaction'),
      /REGISTRY_COMMIT_FAILED/
    );
    assert.equal(await instance.plugins.expandCommand('transaction-command', ''), 'LAST_GOOD');
    assert.equal(instance.plugins.inspect().generation, generation + 2);
  } finally {
    await instance.close();
  }
});

test('failed same-id candidate setup rolls the registry back without draining last-good', async () => {
  const instance = agent();
  await instance.plugins.install(plugin());
  let rolledBack = false;
  const registry = {
    async loadInstalled() {
      throw new Error('CANDIDATE_SETUP_FAILED');
    },
    async rollback() {
      rolledBack = true;
    },
  };
  try {
    await assert.rejects(
      activateWebPluginCandidate(
        instance,
        registry,
        {
          id: 'fixture/transaction',
          version: '2.0.0',
          source: 'fixture@2.0.0',
          root: '/immutable/candidate',
          enabled: true,
          installedAt: new Date(0).toISOString(),
          lastGood: {
            version: '1.0.0',
            source: 'fixture@1.0.0',
            root: '/immutable/last-good',
          },
        },
        true
      ),
      /CANDIDATE_SETUP_FAILED/
    );
    assert.equal(rolledBack, true);
    assert.equal(await instance.plugins.expandCommand('transaction-command', ''), 'LAST_GOOD');
  } finally {
    await instance.close();
  }
});
