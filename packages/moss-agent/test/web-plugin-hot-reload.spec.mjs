#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';

function agent() {
  return new MossAgent({
    llmProvider: {
      id: 'web-plugin-test',
      displayName: 'Web plugin test',
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

let csrfToken = '';

async function json(url, init) {
  if (init?.method && !csrfToken) {
    const bootstrap = await fetch(`${new URL(url).origin}/api/bootstrap`);
    csrfToken = (await bootstrap.json()).csrfToken;
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      origin: new URL(url).origin,
      'content-type': 'application/json',
      ...(csrfToken ? { 'x-moss-csrf': csrfToken } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

test('Web plugin mutations hot-apply one composition generation and keep secrets write-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss web plugin 配置 '));
  const configDir = path.join(root, 'config with spaces');
  const pluginRoot = path.join(root, 'plugin with spaces');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    path.join(pluginRoot, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'web/hot-plugin',
      version: '1.0.0',
      runtime: { module: './plugin.mjs' },
      configSchema: './config.schema.json',
    })
  );
  await writeFile(
    path.join(pluginRoot, 'plugin.mjs'),
    `export default { id: 'web/hot-plugin', setup(context) {
      const label = typeof context.config.label === 'string' ? context.config.label : 'unset';
      if (label === 'reject') throw new Error('REJECT_CONFIG_CANDIDATE');
      const secretConfigured = typeof context.config.apiKey === 'string';
      context.registerCommand({ id: 'hot-command', title: 'Hot command', expand: (args) => 'HOT:' + label + ':' + secretConfigured + ':' + args });
    } };\n`
  );
  await writeFile(
    path.join(pluginRoot, 'config.schema.json'),
    JSON.stringify({
      type: 'object',
      properties: {
        label: { type: 'string' },
        apiKey: { type: 'string', writeOnly: true },
      },
    })
  );
  const registry = new InstalledPluginRegistry({ configDir });
  await registry.add(pluginRoot);
  const instance = agent();
  const web = await startMossWebServer(instance, { port: 0, configDir });
  try {
    const before = (await json(`${web.url}/api/plugins`)).generation;
    const enabled = await json(
      `${web.url}/api/plugins/${encodeURIComponent('web/hot-plugin')}/enable`,
      {
        method: 'POST',
      }
    );
    assert.equal(enabled.restartRequired, false);
    assert.equal(enabled.generation, before + 1);
    assert.equal(await instance.plugins.expandCommand('hot-command', 'ok'), 'HOT:unset:false:ok');

    const configured = await json(
      `${web.url}/api/plugins/${encodeURIComponent('web/hot-plugin')}/config`,
      {
        method: 'PUT',
        body: JSON.stringify({ values: { label: 'safe' } }),
      }
    );
    assert.equal(configured.restartRequired, false);
    assert.equal(await instance.plugins.expandCommand('hot-command', 'ok'), 'HOT:safe:false:ok');
    await assert.rejects(
      json(`${web.url}/api/plugins/${encodeURIComponent('web/hot-plugin')}/config`, {
        method: 'PUT',
        body: JSON.stringify({ values: { label: 'reject' } }),
      }),
      /REJECT_CONFIG_CANDIDATE/
    );
    assert.equal(await instance.plugins.expandCommand('hot-command', 'ok'), 'HOT:safe:false:ok');
    assert.deepEqual(
      (await json(`${web.url}/api/plugins/${encodeURIComponent('web/hot-plugin')}/config`)).config
        .values,
      { label: 'safe' }
    );
    const secretUrl = `${web.url}/api/plugins/${encodeURIComponent('web/hot-plugin')}/config/secrets/apiKey`;
    const secret = await json(secretUrl, {
      method: 'PUT',
      body: JSON.stringify({ value: 'SECRET_MUST_NOT_RETURN' }),
    });
    assert.deepEqual(secret.config, {
      values: { label: 'safe' },
      secrets: { apiKey: { configured: true } },
    });
    assert.doesNotMatch(JSON.stringify(secret), /SECRET_MUST_NOT_RETURN/);
    assert.equal(await instance.plugins.expandCommand('hot-command', 'ok'), 'HOT:safe:true:ok');

    const disabled = await json(
      `${web.url}/api/plugins/${encodeURIComponent('web/hot-plugin')}/disable`,
      {
        method: 'POST',
      }
    );
    assert.equal(disabled.restartRequired, false);
    assert.equal(disabled.generation, secret.generation + 1);
    assert.equal(instance.plugins.getCommand('hot-command'), undefined);
  } finally {
    await web.close();
    await instance.close();
  }
});
