#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('plugin config validates its schema and redacts writeOnly values in a Windows-safe path', async () => {
  const runtime = await import('../dist/runtime/index.js');
  assert.equal(typeof runtime.MossPluginConfigStore, 'function');
  assert.equal(typeof runtime.readMossPluginConfigSchema, 'function');

  const root = await mkdtemp(path.join(os.tmpdir(), 'moss plugin 配置 '));
  const pluginRoot = path.join(root, 'plugin root with spaces');
  const configDir = path.join(root, 'config root with spaces');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    path.join(pluginRoot, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture/config',
      version: '1.0.0',
      runtime: { module: './plugin.mjs' },
      configSchema: './config.schema.json',
    })
  );
  await writeFile(
    path.join(pluginRoot, 'plugin.mjs'),
    "export default { id: 'fixture/config', setup() {} };\n"
  );
  await writeFile(
    path.join(pluginRoot, 'config.schema.json'),
    JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'apiKey'],
      properties: {
        endpoint: { type: 'string', format: 'uri' },
        retries: { type: 'integer', minimum: 0, maximum: 5 },
        apiKey: { type: 'string', minLength: 8, writeOnly: true },
      },
    })
  );

  const schema = await runtime.readMossPluginConfigSchema(pluginRoot);
  assert.equal(schema?.properties.apiKey.writeOnly, true);
  const store = new runtime.MossPluginConfigStore({ configDir });

  await store.update('fixture/config', schema, {
    endpoint: 'https://example.invalid/api',
    retries: 2,
  });
  await assert.rejects(
    store.update('fixture/config', schema, { retries: 8 }),
    /Number must be <= 5/
  );
  await assert.rejects(
    store.update('fixture/config', schema, { apiKey: 'must-use-secret-api' }),
    /writeOnly/
  );
  await store.putSecret('fixture/config', schema, 'apiKey', 'secret-value');

  const view = await store.getView('fixture/config', schema);
  assert.deepEqual(view.values, {
    endpoint: 'https://example.invalid/api',
    retries: 2,
  });
  assert.deepEqual(view.secrets, { apiKey: { configured: true } });
  assert.doesNotMatch(JSON.stringify(view), /secret-value/);
  assert.equal((await store.loadRuntimeConfig('fixture/config', schema)).apiKey, 'secret-value');

  const storedPath = path.join(
    configDir,
    'plugins',
    'config',
    `${encodeURIComponent('fixture/config')}.json`
  );
  assert.equal(path.dirname(storedPath), path.join(configDir, 'plugins', 'config'));
  assert.equal(path.basename(storedPath).includes('/'), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(storedPath)).mode & 0o777, 0o600);
  }

  await store.deleteSecret('fixture/config', schema, 'apiKey');
  assert.deepEqual((await store.getView('fixture/config', schema)).secrets, {
    apiKey: { configured: false },
  });
  await assert.rejects(
    store.loadRuntimeConfig('fixture/config', schema),
    /Missing required property: "apiKey"/
  );

  await chmod(storedPath, 0o600).catch(() => {});
  const persisted = await readFile(storedPath, 'utf8');
  assert.doesNotMatch(persisted, /secret-value/);
});

test('plugin config schema rejects unsupported keywords before any config is written', async () => {
  const runtime = await import('../dist/runtime/index.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-plugin-invalid-schema-'));
  await writeFile(
    path.join(root, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture/invalid-config',
      version: '1.0.0',
      runtime: { module: './plugin.mjs' },
      configSchema: './config.schema.json',
    })
  );
  await writeFile(
    path.join(root, 'plugin.mjs'),
    "export default { id: 'fixture/invalid-config', setup() {} };\n"
  );
  await writeFile(
    path.join(root, 'config.schema.json'),
    JSON.stringify({ type: 'object', unevaluatedProperties: false })
  );
  const registry = new runtime.InstalledPluginRegistry({ configDir: path.join(root, 'config') });
  await assert.rejects(registry.add(root), /unsupported schema keyword/);
  await assert.rejects(runtime.readMossPluginConfigSchema(root), /unsupported schema keyword/);
});
