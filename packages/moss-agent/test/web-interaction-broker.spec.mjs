#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { MossWebInteractionBroker } from '../dist/web-ui/web-interaction-broker.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';
import { authorizedWebFetch } from './web-authorized-fetch.mjs';

test('Web interaction broker exposes approval and question requests until resolved', async () => {
  const broker = new MossWebInteractionBroker();

  const approval = broker.askApproval('Allow once or deny?');
  const question = broker.askQuestion('Choose a target\n  1. Local\n  2. Device');
  const pending = broker.pending();

  assert.deepEqual(
    pending.map(({ kind, prompt, state }) => [kind, prompt, state]),
    [
      ['approval', 'Allow once or deny?', 'pending'],
      ['question', 'Choose a target\n  1. Local\n  2. Device', 'pending'],
    ]
  );

  assert.equal(broker.resolve(pending[0].id, 'allow_once'), true);
  assert.equal(broker.resolve(pending[1].id, '2'), true);
  assert.equal(await approval, 'y');
  assert.equal(await question, '2');
  assert.deepEqual(broker.pending(), []);
  assert.equal(broker.resolve(pending[0].id, 'deny'), false, 'cannot resolve twice');
});

test('Web interaction broker cancellation and abort release the waiting agent call', async () => {
  const broker = new MossWebInteractionBroker();
  const controller = new AbortController();
  const cancelled = broker.askQuestion('What next?');
  const aborted = broker.askApproval('Proceed?', controller.signal);
  const [cancelledRequest, abortedRequest] = broker.pending();

  assert.equal(broker.cancel(cancelledRequest.id), true);
  controller.abort();

  assert.equal(await cancelled, '');
  assert.equal(await aborted, '');
  assert.equal(broker.get(abortedRequest.id)?.state, 'cancelled');
  assert.deepEqual(broker.pending(), []);
});

test('Web interaction broker rejects answers that do not match the interaction kind', async () => {
  const broker = new MossWebInteractionBroker();
  const pending = broker.askApproval('Proceed?');
  const request = broker.pending()[0];

  assert.throws(() => broker.resolve(request.id, 'arbitrary free text'), /approval answer/);
  assert.equal(broker.resolve(request.id, 'deny'), true);
  assert.equal(await pending, 'n');
});

test('two Web servers keep approval prompts and resolutions isolated by agent instance', async () => {
  const create = (id) => {
    const approval = createCliToolApprovalHook('workspace-write', {}, {});
    const agent = new MossAgent({
      llmProvider: {
        id,
        capabilities: { streaming: false },
        async complete() {
          return { stopReason: 'end_turn', content: [] };
        },
      },
      sessionStore: new InMemorySessionStore(),
      hooks: { onBeforeToolExec: approval },
      domainPrompt: false,
      includeLanguagePolicyPrompt: false,
      includeAgentBehaviorPrompt: false,
    });
    return { agent, approval };
  };
  const first = create('first-agent');
  const second = create('second-agent');
  const firstWeb = await startMossWebServer(first.agent, { port: 0 });
  const secondWeb = await startMossWebServer(second.agent, { port: 0 });
  const tool = {
    name: 'remember_test',
    description: 'test',
    metadata: { sideEffectClass: 'memory_write' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'ok';
    },
  };
  try {
    const firstDecision = first.approval({
      tool,
      input: { value: 'first' },
      sessionKey: 'first',
      runId: 'first-run',
      toolCallId: 'first-call',
      abortSignal: new AbortController().signal,
    });
    const secondDecision = second.approval({
      tool,
      input: { value: 'second' },
      sessionKey: 'second',
      runId: 'second-run',
      toolCallId: 'second-call',
      abortSignal: new AbortController().signal,
    });
    const firstBootstrap = await fetch(`${firstWeb.url}/api/bootstrap`).then((response) =>
      response.json()
    );
    const secondBootstrap = await fetch(`${secondWeb.url}/api/bootstrap`).then((response) =>
      response.json()
    );
    const firstPending = await fetch(`${firstWeb.url}/api/interactions`).then((response) =>
      response.json()
    );
    const secondPending = await fetch(`${secondWeb.url}/api/interactions`).then((response) =>
      response.json()
    );
    assert.equal(firstPending.interactions.length, 1);
    assert.equal(secondPending.interactions.length, 1);
    assert.notEqual(firstPending.interactions[0].id, secondPending.interactions[0].id);

    const resolve = (web, csrfToken, interactionId, answer) =>
      fetch(`${web.url}/api/interactions/${interactionId}/resolve`, {
        method: 'POST',
        headers: {
          origin: web.url,
          'x-moss-csrf': csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ answer }),
      });
    assert.equal(
      (
        await resolve(
          firstWeb,
          firstBootstrap.csrfToken,
          firstPending.interactions[0].id,
          'allow_once'
        )
      ).status,
      200
    );
    assert.equal(
      (
        await resolve(
          secondWeb,
          secondBootstrap.csrfToken,
          secondPending.interactions[0].id,
          'deny'
        )
      ).status,
      200
    );
    assert.deepEqual(await firstDecision, { approved: true });
    assert.deepEqual(await secondDecision, {
      approved: false,
      reason: 'User denied remember_test.',
    });
  } finally {
    await Promise.all([firstWeb.close(), secondWeb.close()]);
    await Promise.all([first.agent.close(), second.agent.close()]);
  }
});

test('Web runtime mode controls only its own agent approval hook', async () => {
  const create = (id) => {
    const approval = createCliToolApprovalHook('workspace-write', {}, {});
    const agent = new MossAgent({
      llmProvider: {
        id,
        capabilities: { streaming: false },
        async complete() {
          return { stopReason: 'end_turn', content: [] };
        },
      },
      sessionStore: new InMemorySessionStore(),
      hooks: { onBeforeToolExec: approval },
      domainPrompt: false,
      includeLanguagePolicyPrompt: false,
      includeAgentBehaviorPrompt: false,
    });
    return { agent, approval };
  };
  const first = create('first-mode-agent');
  const second = create('second-mode-agent');
  const firstWeb = await startMossWebServer(first.agent, { port: 0 });
  const secondWeb = await startMossWebServer(second.agent, { port: 0 });
  const tool = {
    name: 'remember_mode_test',
    description: 'test',
    metadata: { sideEffectClass: 'memory_write' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'ok';
    },
  };
  const request = (value) => ({
    tool,
    input: { value },
    sessionKey: value,
    runId: `${value}-run`,
    toolCallId: `${value}-call`,
    abortSignal: new AbortController().signal,
  });
  try {
    const switched = await authorizedWebFetch(`${firstWeb.url}/api/runtime/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    });
    assert.equal(switched.status, 200);

    const firstDecision = await first.approval(request('first'));
    assert.equal(firstDecision.approved, false);
    assert.match(firstDecision.reason, /Plan mode/);

    const secondDecision = second.approval(request('second'));
    const firstPending = await fetch(`${firstWeb.url}/api/interactions`).then((response) =>
      response.json()
    );
    const secondPending = await fetch(`${secondWeb.url}/api/interactions`).then((response) =>
      response.json()
    );
    assert.equal(firstPending.interactions.length, 0);
    assert.equal(secondPending.interactions.length, 1);
    const secondBootstrap = await fetch(`${secondWeb.url}/api/bootstrap`).then((response) =>
      response.json()
    );
    const resolved = await fetch(
      `${secondWeb.url}/api/interactions/${secondPending.interactions[0].id}/resolve`,
      {
        method: 'POST',
        headers: {
          origin: secondWeb.url,
          'x-moss-csrf': secondBootstrap.csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ answer: 'deny' }),
      }
    );
    assert.equal(resolved.status, 200);
    assert.equal((await secondDecision).approved, false);
  } finally {
    await Promise.all([firstWeb.close(), secondWeb.close()]);
    await Promise.all([first.agent.close(), second.agent.close()]);
  }
});
