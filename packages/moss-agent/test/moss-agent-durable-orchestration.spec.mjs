#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { JsonlExecutionStore } from '../dist/orchestration/index.js';

const provider = {
  id: 'unused',
  displayName: 'unused',
  capabilities: { streaming: false },
  async complete() {
    return { content: [{ type: 'text', text: 'unused' }], stopReason: 'end_turn' };
  },
};

function createAgent(workspaceDir) {
  return new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    enableSteering: false,
  });
}

test('MossAgent defaults to durable execution state shared across restarts', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agent-durable-'));
  const first = createAgent(workspaceDir);
  try {
    assert.ok(first.executionStore instanceof JsonlExecutionStore);
    first.executionStore.create({
      id: 'restartable',
      goal: 'survive restart',
      sessionId: 'session',
      nodes: [],
      policy: { maxConcurrency: 4, maxAttemptsPerNode: 3, strictCompletion: true },
    });
    await first.close();

    const second = createAgent(workspaceDir);
    try {
      assert.equal(second.executionStore.load('restartable').goal, 'survive restart');
      assert.equal(second.planControllerStore.getActivePlanForSession('session'), null);
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
