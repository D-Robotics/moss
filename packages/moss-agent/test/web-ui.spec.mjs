#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';
import { WEB_JS } from '../dist/web-ui/web-assets.js';

test('browser asset is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(WEB_JS));
});

function makeAgent(provider) {
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
  agent.tools.register({
    name: 'web_fixture',
    description: 'Return Web UI fixture evidence.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'WEB_FIXTURE_OK';
    },
  });
  return agent;
}

test('web host boots on loopback and streams real tool evidence', async () => {
  let turn = 0;
  const agent = makeAgent({
    id: 'web-test',
    displayName: 'Web test',
    capabilities: { streaming: false },
    async complete() {
      if (turn++ === 0) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'web-tool-1', name: 'web_fixture', input: {} }],
        };
      }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'WEB_FIXTURE_OK' }] };
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  });
  const web = await startMossWebServer(agent, { port: 0 });
  try {
    assert.equal(web.host, '127.0.0.1');
    const page = await fetch(web.url).then((response) => response.text());
    assert.match(page, /Build with an agent that shows its work/);
    assert.match(page, /Capabilities/);
    const bootstrap = await fetch(`${web.url}/api/bootstrap`).then((response) => response.json());
    assert.ok(bootstrap.tools.includes('web_fixture'));
    assert.doesNotMatch(JSON.stringify(bootstrap), /apiKey|Authorization|secret/i);

    const created = await fetch(`${web.url}/api/sessions`, { method: 'POST' }).then((response) =>
      response.json()
    );
    const stream = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Use the fixture.' }),
      }
    ).then((response) => response.text());
    assert.match(stream, /"state":"start".*"name":"web_fixture"/);
    assert.match(stream, /"state":"end".*WEB_FIXTURE_OK/);
    assert.match(stream, /"type":"text","delta":"WEB_FIXTURE_OK"/);
    assert.match(stream, /"type":"done","stopReason":"end_turn"/);

    const denied = await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: { origin: 'https://example.invalid' },
    });
    assert.equal(denied.status, 403);
  } finally {
    await web.close();
    await agent.close();
  }
});

test('web cancellation aborts an active model turn', async () => {
  let started;
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const agent = makeAgent({
    id: 'web-cancel-test',
    displayName: 'Web cancel test',
    capabilities: { streaming: false },
    async complete(options) {
      started();
      await new Promise((resolve, reject) =>
        options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), {
          once: true,
        })
      );
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  });
  const web = await startMossWebServer(agent, { port: 0 });
  try {
    const { sessionId } = await fetch(`${web.url}/api/sessions`, { method: 'POST' }).then(
      (response) => response.json()
    );
    const pending = fetch(`${web.url}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Wait.' }),
    }).then((response) => response.text());
    await startedGate;
    const cancelled = await fetch(`${web.url}/api/sessions/${sessionId}/cancel`, {
      method: 'POST',
    }).then((response) => response.json());
    assert.equal(cancelled.cancelled, true);
    assert.match(await pending, /"type":"done"|"type":"error"/);
  } finally {
    await web.close();
    await agent.close();
  }
});
