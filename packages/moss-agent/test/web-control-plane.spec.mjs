#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authorizedWebFetch as fetch } from './web-authorized-fetch.mjs';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { MossWebInteractionBroker } from '../dist/web-ui/web-interaction-broker.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';

function createAgent(workspaceDir) {
  return new MossAgent({
    llmProvider: {
      id: 'web-control-plane-test',
      capabilities: { streaming: false },
      async complete() {
        return { stopReason: 'end_turn', content: [] };
      },
    },
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    model: 'control-model',
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
}

test('Web control plane resolves interactions and drives runtime and settings owners', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-control-plane-'));
  const agent = createAgent(tempDir);
  agent.executionStore.create({ id: 'web-task', goal: 'Visible in every surface', nodes: [] });
  const broker = new MossWebInteractionBroker();
  const web = await startMossWebServer(agent, {
    port: 0,
    configDir: path.join(tempDir, 'config'),
    interactionBroker: broker,
  });
  try {
    const waiting = broker.askQuestion('Which target?');
    const interactions = await fetch(`${web.url}/api/interactions`).then((response) =>
      response.json()
    );
    assert.equal(interactions.interactions[0].kind, 'question');
    const resolved = await fetch(
      `${web.url}/api/interactions/${interactions.interactions[0].id}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'Device' }),
      }
    );
    assert.equal(resolved.status, 200);
    assert.equal(await waiting, 'Device');

    const session = await fetch(`${web.url}/api/sessions`, { method: 'POST' }).then((response) =>
      response.json()
    );
    const queued = await fetch(`${web.url}/api/sessions/${session.sessionId}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Run next', delivery: 'queue' }),
    });
    assert.equal(queued.status, 201);
    assert.equal(
      (
        await fetch(`${web.url}/api/sessions/${session.sessionId}/inbox`).then((response) =>
          response.json()
        )
      ).entries[0].prompt,
      'Run next'
    );

    const mode = await fetch(`${web.url}/api/runtime/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    }).then((response) => response.json());
    assert.equal(mode.mode, 'plan');

    const tasks = await fetch(`${web.url}/api/tasks`).then((response) => response.json());
    assert.equal(tasks.tasks[0].id, 'web-task');
    assert.equal(tasks.tasks[0].revision, 1);
    const resumedTask = await fetch(`${web.url}/api/tasks/web-task/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((response) => response.json());
    assert.equal(resumedTask.task.status, 'running');
    assert.equal(resumedTask.task.revision, 2);

    const goal = await fetch(`${web.url}/api/sessions/${session.sessionId}/goal`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set', objective: 'Complete control plane' }),
    }).then((response) => response.json());
    assert.equal(goal.goal.objective, 'Complete control plane');

    const saved = await fetch(`${web.url}/api/settings/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values: { safetyMode: 'workspace-write', approvalPolicy: 'prompt' },
      }),
    });
    assert.equal(saved.status, 200);
    const secretWrite = await fetch(`${web.url}/api/settings/credentials/apiKey`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'control-plane-secret' }),
    });
    assert.equal(secretWrite.status, 200);
    const modelSettings = await fetch(`${web.url}/api/settings/models`).then((response) =>
      response.json()
    );
    assert.equal(modelSettings.credentials.apiKey.configured, true);
    assert.equal(JSON.stringify(modelSettings).includes('control-plane-secret'), false);
  } finally {
    await web.close();
    await agent.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
