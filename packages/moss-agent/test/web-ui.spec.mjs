#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';
import { WEB_HTML } from '../dist/web-ui/web-assets.js';
import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';
import { installConfiguredPlugins } from '../dist/cli/plugins-runtime.js';

test('browser shell mounts the bundled React workbench and stable design system', () => {
  assert.match(WEB_HTML, /id="moss-web-root"/);
  assert.match(WEB_HTML, /data-moss-surface="workbench"/);
  assert.match(WEB_HTML, /href="\/assets\/workbench\.css"/);
  assert.match(WEB_HTML, /type="module" src="\/assets\/workbench\.js"/);
  assert.doesNotMatch(WEB_HTML, /class="rail"/);
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

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { host } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
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
    assert.match(page, /id="moss-web-root"/);
    const clientScript = await fetch(`${web.url}/assets/workbench.js`);
    assert.equal(clientScript.status, 200);
    assert.match(clientScript.headers.get('content-type') ?? '', /javascript/);
    assert.doesNotMatch(await clientScript.text(), /\bprocess\.env\b/);
    const clientStyles = await fetch(`${web.url}/assets/workbench.css`).then((response) =>
      response.text()
    );
    assert.match(clientStyles, /--moss-color-surface:/);
    assert.match(clientStyles, /--moss-space-4:/);
    assert.match(clientStyles, /--moss-radius-panel:/);
    const componentRules = clientStyles.replace(/:root[^{]*{[^}]*}/gs, '');
    assert.doesNotMatch(
      componentRules,
      /#[\da-f]{3,8}\b/i,
      'component rules consume design tokens instead of parallel hard-coded colors'
    );
    const bootstrap = await fetch(`${web.url}/api/bootstrap`).then((response) => response.json());
    assert.ok(bootstrap.tools.includes('web_fixture'));
    assert.equal(bootstrap.model, 'Configured model');
    assert.doesNotMatch(JSON.stringify(bootstrap), /apiKey|Authorization|secret/i);

    const sessions = await fetch(`${web.url}/api/sessions`).then((response) => response.json());
    assert.equal(sessions.sessions.length, 0);

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
    assert.match(stream, /"type":"run"/);
    assert.match(stream, /"type":"done","stopReason":"end_turn"/);
    assert.match(stream, /"status":"completed"/);
    assert.match(stream, /"verification":"unverified"/);

    const resumedSessions = await fetch(`${web.url}/api/sessions`).then((response) =>
      response.json()
    );
    assert.equal(resumedSessions.sessions.length, 1);
    assert.equal(resumedSessions.sessions[0].sessionId, created.sessionId);
    assert.equal(resumedSessions.sessions[0].title, 'Use the fixture.');

    const timeline = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}/messages`
    ).then((response) => response.json());
    assert.ok(
      timeline.items.some((item) => item.kind === 'user' && item.text === 'Use the fixture.')
    );
    assert.ok(
      timeline.items.some(
        (item) =>
          item.kind === 'tool' && item.name === 'web_fixture' && item.result === 'WEB_FIXTURE_OK'
      )
    );
    assert.ok(
      timeline.items.some((item) => item.kind === 'assistant' && item.text === 'WEB_FIXTURE_OK')
    );

    const terminal = stream
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'done');
    const history = await fetch(`${web.url}/api/runs/${terminal.run.id}`).then((response) =>
      response.json()
    );
    assert.equal(history.run.evidenceCount, 1);
    assert.deepEqual(
      history.events.map((event) => event.type),
      ['run.created', 'run.started', 'tool.started', 'tool.succeeded', 'run.completed']
    );
    const resumed = await fetch(`${web.url}/api/runs/${terminal.run.id}?after=3`).then((response) =>
      response.json()
    );
    assert.deepEqual(
      resumed.events.map((event) => event.type),
      ['tool.succeeded', 'run.completed']
    );

    const denied = await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: { origin: 'https://example.invalid' },
    });
    assert.equal(denied.status, 403);

    const otherLocalPort = await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:65535' },
    });
    assert.equal(otherLocalPort.status, 403);

    const wrongScheme = await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: { origin: web.url.replace('http:', 'https:') },
    });
    assert.equal(wrongScheme.status, 403);

    const secondStream = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Run the newer turn.' }),
      }
    ).then((response) => response.text());
    const secondTerminal = secondStream
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'done');
    const sessionsAfterSecondTurn = await fetch(`${web.url}/api/sessions`).then((response) =>
      response.json()
    );
    assert.equal(sessionsAfterSecondTurn.sessions[0].runId, secondTerminal.run.id);
    assert.equal(sessionsAfterSecondTurn.sessions[0].title, 'Run the newer turn.');
  } finally {
    await web.close();
    await agent.close();
  }
});

test('web host formats an IPv6 loopback origin when the platform supports it', async (context) => {
  const agent = makeAgent({
    id: 'web-ipv6-test',
    displayName: 'Web IPv6 test',
    capabilities: { streaming: false },
    async complete() {
      return { stopReason: 'end_turn', content: [] };
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  });
  let web;
  try {
    web = await startMossWebServer(agent, { port: 0, host: '::1' });
  } catch (error) {
    await agent.close();
    if (error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAFNOSUPPORT') {
      context.skip('IPv6 loopback is unavailable');
      return;
    }
    throw error;
  }
  try {
    assert.match(web.url, /^http:\/\/\[::1\]:\d+$/);
    assert.equal(await requestWithHost(`${web.url}/api/bootstrap`, `[::1]:${web.port}`), 200);
  } finally {
    await web.close();
    await agent.close();
  }
});

test('web host projects provider failures and records a failed run', async () => {
  const agent = makeAgent({
    id: 'web-error-test',
    displayName: 'Web error test',
    capabilities: { streaming: false },
    async complete() {
      throw new Error('WEB_PROVIDER_FAILURE');
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
    const stream = await fetch(`${web.url}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Fail this turn.' }),
    }).then((response) => response.text());
    assert.match(stream, /"type":"error".*WEB_PROVIDER_FAILURE/);
    assert.match(stream, /"type":"done","stopReason":"error"/);
    const runs = await fetch(`${web.url}/api/runs`).then((response) => response.json());
    assert.equal(runs.runs[0].status, 'failed');
    assert.equal(runs.runs[0].title, 'Fail this turn.');
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
    const concurrent = await fetch(`${web.url}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Do not overlap.' }),
    });
    assert.equal(concurrent.status, 409);
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

test('web plugin settings expose redacted inventory and require local-origin mutation', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'moss-web-plugins-'));
  const pluginDir = path.join(configDir, 'fixture-plugin');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture/plugin',
      version: '1.0.0',
      runtime: { module: './plugin.mjs' },
      web: {
        contributions: [
          { id: 'fixture-settings', slot: 'settings.plugin', module: './settings.js' },
        ],
      },
    })
  );
  await writeFile(
    path.join(pluginDir, 'plugin.mjs'),
    "export default { id: 'fixture/plugin', setup() {} };\n"
  );
  await writeFile(
    path.join(pluginDir, 'settings.js'),
    "export default { mount(root) { root.textContent = 'FIXTURE_PLUGIN_UI'; } };\n"
  );
  const pluginRegistry = new InstalledPluginRegistry({ configDir });
  await pluginRegistry.add(pluginDir);
  await pluginRegistry.enable('fixture/plugin');
  const brokenPluginDir = path.join(configDir, 'broken-web-plugin');
  await mkdir(brokenPluginDir, { recursive: true });
  await writeFile(
    path.join(brokenPluginDir, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'zz/broken-web',
      version: '1.0.0',
      runtime: { module: './plugin.mjs' },
      web: {
        contributions: [
          { id: 'broken-settings', slot: 'settings.plugin', module: './settings.js' },
        ],
      },
    })
  );
  await writeFile(
    path.join(brokenPluginDir, 'plugin.mjs'),
    "import { isMainThread } from 'node:worker_threads'; export default { id: 'zz/broken-web', setup() { if (isMainThread) throw new Error('BROKEN_WEB_SETUP'); } };\n"
  );
  await writeFile(
    path.join(brokenPluginDir, 'settings.js'),
    "export default { mount(root) { root.textContent = 'MUST_NOT_LOAD'; } };\n"
  );
  await pluginRegistry.add(brokenPluginDir);
  await pluginRegistry.enable('zz/broken-web');
  const agent = makeAgent({
    id: 'web-plugin-test',
    displayName: 'Web plugin test',
    capabilities: { streaming: false },
    async complete() {
      return { stopReason: 'end_turn', content: [] };
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await installConfiguredPlugins(agent, configDir);
  } finally {
    console.error = originalError;
  }
  const web = await startMossWebServer(agent, { port: 0, configDir });
  try {
    const inventory = await fetch(`${web.url}/api/plugins`).then((response) => response.json());
    assert.equal(inventory.installed[0].id, 'fixture/plugin');
    assert.equal(inventory.contributions[0].slot, 'settings.plugin');
    assert.equal(
      inventory.contributions.some(({ pluginId }) => pluginId === 'zz/broken-web'),
      false
    );
    assert.doesNotMatch(JSON.stringify(inventory), /secret|apiKey|Authorization/i);
    assert.equal('root' in inventory.installed[0], false);
    assert.equal('source' in inventory.installed[0], false);
    const pluginAsset = await fetch(`${web.url}${inventory.contributions[0].moduleUrl}`);
    assert.equal(pluginAsset.status, 200);
    assert.match(await pluginAsset.text(), /FIXTURE_PLUGIN_UI/);
    await writeFile(
      path.join(pluginDir, 'settings.js'),
      "export default { mount(root) { root.textContent = 'CHANGED_AFTER_START'; } };\n"
    );
    const brokenAsset = await fetch(`${web.url}/plugin-assets/zz%2Fbroken-web/broken-settings.js`);
    assert.equal(brokenAsset.status, 404);

    assert.equal(await requestWithHost(`${web.url}/api/bootstrap`, 'attacker.example'), 403);

    const denied = await fetch(`${web.url}/api/plugins/fixture%2Fplugin/disable`, {
      method: 'POST',
      headers: { origin: 'https://example.invalid' },
    });
    assert.equal(denied.status, 403);

    const disabled = await fetch(`${web.url}/api/plugins/fixture%2Fplugin/disable`, {
      method: 'POST',
    }).then((response) => response.json());
    assert.equal(disabled.restartRequired, true);
    const refreshed = await fetch(`${web.url}/api/plugins`).then((response) => response.json());
    assert.equal(refreshed.installed[0].enabled, false);
    assert.equal(refreshed.contributions[0].pluginId, 'fixture/plugin');
    const retainedAsset = await fetch(`${web.url}${refreshed.contributions[0].moduleUrl}`);
    assert.equal(retainedAsset.status, 200);
    assert.match(await retainedAsset.text(), /FIXTURE_PLUGIN_UI/);
  } finally {
    await web.close();
    await agent.close();
  }
});
