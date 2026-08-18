#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';
import { createMossPluginHost } from '../dist/core/plugins/plugin-host.js';

async function fixture(root, id, source) {
  const pluginRoot = path.join(root, id.replace('/', '-'));
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    path.join(pluginRoot, 'moss.plugin.json'),
    JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', runtime: { module: './plugin.mjs' } })
  );
  await writeFile(path.join(pluginRoot, 'plugin.mjs'), source);
  return pluginRoot;
}

test('sync and async setup hangs are terminated before enabled plugins reach the core runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-plugin-hangs-'));
  const configDir = path.join(root, 'config with spaces 配置');
  const asyncRoot = await fixture(
    root,
    'hang/async',
    "export default { id: 'hang/async', async setup() { await new Promise(() => {}); } };\n"
  );
  const syncRoot = await fixture(
    root,
    'hang/sync',
    "export default { id: 'hang/sync', setup() { while (true) {} } };\n"
  );
  const importRoot = await fixture(
    root,
    'hang/import',
    "await new Promise(() => {}); export default { id: 'hang/import', setup() {} };\n"
  );
  const registry = new InstalledPluginRegistry({ configDir, setupTimeoutMs: 50 });
  const asyncEntry = await registry.add(asyncRoot);
  const syncEntry = await registry.add(syncRoot);
  const importEntry = await registry.add(importRoot);
  await mkdir(path.join(configDir, 'plugins'), { recursive: true });
  await writeFile(
    path.join(configDir, 'plugins', 'installed.json'),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [
        { ...asyncEntry, enabled: true },
        { ...syncEntry, enabled: true },
        { ...importEntry, enabled: true },
      ],
    })
  );

  const startedAt = Date.now();
  const loaded = await registry.loadEnabled();
  assert.deepEqual(loaded.plugins, []);
  assert.deepEqual(
    loaded.failures.map(({ id }) => id),
    ['hang/async', 'hang/import', 'hang/sync']
  );
  assert.ok(Date.now() - startedAt < 2_000);
  assert.match(loaded.failures.map(({ message }) => message).join(' '), /timed out/);
});

test('abort signals cross the Worker RPC boundary and release the plugin call lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-plugin-cancel-'));
  const pluginRoot = await fixture(
    root,
    'cancel/worker',
    `export default {
      id: 'cancel/worker',
      setup(context) {
        context.registerTool({
          name: 'wait_for_abort',
          description: 'Wait for cancellation.',
          metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
          inputSchema: { type: 'object', properties: {} },
          async execute(_input, toolContext) {
            await new Promise((resolve) => toolContext.abortSignal.addEventListener('abort', resolve, { once: true }));
            throw new Error('WORKER_ABORT_OBSERVED');
          }
        });
      }
    };\n`
  );
  const registry = new InstalledPluginRegistry({
    configDir: path.join(root, 'config'),
    setupTimeoutMs: 250,
  });
  await registry.add(pluginRoot);
  const plugin = await registry.loadInstalled('cancel/worker');
  const tools = new Map();
  const host = createMossPluginHost({
    hasTool: (name) => tools.has(name),
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
    hasSkill: () => false,
    registerSkill: () => () => {},
    hasExpert: () => false,
    registerExpert: () => () => {},
  });
  try {
    await host.install(plugin);
    const controller = new AbortController();
    const running = tools
      .get('wait_for_abort')
      .execute({}, { workspaceDir: root, sessionKey: 'cancel', abortSignal: controller.signal });
    controller.abort();
    await assert.rejects(running, /plugin call aborted/);
    await host.unload('cancel/worker', { timeoutMs: 250 });
    assert.equal(tools.has('wait_for_abort'), false);
  } finally {
    await host.close();
  }
});

test('an exited plugin Worker closes the RPC boundary for every later call', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-plugin-worker-exit-'));
  const pluginRoot = await fixture(
    root,
    'exit/worker',
    `export default {
      id: 'exit/worker',
      setup(context) {
        context.registerCommand({
          id: 'exit-worker',
          title: 'Exit worker',
          expand() { process.exit(9); }
        });
      }
    };\n`
  );
  const registry = new InstalledPluginRegistry({ configDir: path.join(root, 'config') });
  await registry.add(pluginRoot);
  const plugin = await registry.loadInstalled('exit/worker');
  const host = createMossPluginHost({
    hasTool: () => false,
    registerTool: () => () => {},
    hasSkill: () => false,
    registerSkill: () => () => {},
    hasExpert: () => false,
    registerExpert: () => () => {},
  });
  try {
    await host.install(plugin);
    await assert.rejects(host.expandCommand('exit-worker', ''), /exited with code 9/);
    await assert.rejects(host.expandCommand('exit-worker', ''), /disposed/);
  } finally {
    await host.close();
  }
});
