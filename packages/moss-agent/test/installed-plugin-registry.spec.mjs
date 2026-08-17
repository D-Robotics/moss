#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  InstalledPluginRegistry,
  readMossPluginManifest,
} from '../dist/plugins/installed-plugin-registry.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'moss-plugin-registry-'));
const configDir = path.join(root, 'config');
const pluginDir = path.join(root, 'sample-plugin');
await mkdir(pluginDir, { recursive: true });
await writeFile(
  path.join(pluginDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'sample/plugin',
    version: '1.2.3',
    runtime: { module: './plugin.mjs', export: 'plugin' },
    web: { contributions: [{ id: 'sample-settings', slot: 'settings.plugin', module: './ui.js' }] },
    configSchema: './config.schema.json',
  })
);
await writeFile(
  path.join(pluginDir, 'plugin.mjs'),
  "export const plugin = { id: 'sample/plugin', setup() {} };\n"
);
await writeFile(path.join(pluginDir, 'ui.js'), 'export default { mount() {} };\n');
await writeFile(path.join(pluginDir, 'config.schema.json'), '{"type":"object"}\n');

const manifest = await readMossPluginManifest(pluginDir);
assert.equal(manifest.id, 'sample/plugin');
assert.equal(manifest.web?.contributions[0]?.slot, 'settings.plugin');

const registry = new InstalledPluginRegistry({ configDir });
const installed = await registry.add(pluginDir);
assert.equal(installed.id, 'sample/plugin');
assert.equal(installed.enabled, false);
assert.equal((await registry.list()).length, 1);

await registry.enable('sample/plugin');

const loaded = await registry.loadEnabled();
assert.equal(loaded.plugins.length, 1);
assert.equal(loaded.plugins[0]?.id, 'sample/plugin');
assert.deepEqual(loaded.failures, []);

const report = await registry.doctor();
assert.equal(report[0]?.status, 'ok');
assert.ok(report[0]?.message.includes('1.2.3'));

const persisted = JSON.parse(
  await readFile(path.join(configDir, 'plugins', 'installed.json'), 'utf8')
);
assert.equal(persisted.schemaVersion, 1);
assert.equal(persisted.plugins[0]?.source, pluginDir);

await registry.remove('sample/plugin');
assert.deepEqual(await registry.list(), []);

await assert.rejects(
  () => readMossPluginManifest(path.join(root, 'missing')),
  /moss\.plugin\.json/
);
await assert.rejects(() => registry.add('example-plugin'), /npm plugins require an exact version/);

const duplicateWebDir = path.join(root, 'duplicate-web-plugin');
await mkdir(duplicateWebDir, { recursive: true });
await writeFile(
  path.join(duplicateWebDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'sample/duplicate-web',
    version: '1.0.0',
    runtime: { module: './plugin.mjs' },
    web: {
      contributions: [
        { id: 'duplicate', slot: 'settings.plugin', module: './ui.js' },
        { id: 'duplicate', slot: 'conversation.header', module: './ui.js' },
      ],
    },
  })
);
await writeFile(
  path.join(duplicateWebDir, 'plugin.mjs'),
  "export default { id: 'sample/duplicate-web', setup() {} };\n"
);
await writeFile(path.join(duplicateWebDir, 'ui.js'), 'export default { mount() {} };\n');
await assert.rejects(
  () => readMossPluginManifest(duplicateWebDir),
  /duplicate web contribution id/
);

const throwingPluginDir = path.join(root, 'throwing-plugin');
await mkdir(throwingPluginDir, { recursive: true });
await writeFile(
  path.join(throwingPluginDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'sample/throwing',
    version: '1.0.0',
    runtime: { module: './plugin.mjs' },
  })
);
await writeFile(
  path.join(throwingPluginDir, 'plugin.mjs'),
  "export default { id: 'sample/throwing', setup() { throw new Error('SETUP_FAILED'); } };\n"
);
await registry.add(throwingPluginDir);
const throwingReport = await registry.doctor();
assert.equal(throwingReport[0]?.status, 'error');
assert.match(throwingReport[0]?.message ?? '', /SETUP_FAILED/);
await assert.rejects(() => registry.enable('sample/throwing'), /SETUP_FAILED/);
assert.equal((await registry.list())[0]?.enabled, false);

const concurrentConfigDir = path.join(root, 'concurrent-config');
const concurrentPluginDirs = [];
for (const suffix of ['one', 'two']) {
  const directory = path.join(root, `concurrent-${suffix}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: `concurrent/${suffix}`,
      version: '1.0.0',
      runtime: { module: './plugin.mjs' },
    })
  );
  await writeFile(
    path.join(directory, 'plugin.mjs'),
    `export default { id: 'concurrent/${suffix}', setup() {} };\n`
  );
  concurrentPluginDirs.push(directory);
}
const workerPath = path.join(root, 'add-plugin-worker.mjs');
await writeFile(
  workerPath,
  `import { InstalledPluginRegistry } from ${JSON.stringify(new URL('../dist/plugins/installed-plugin-registry.js', import.meta.url).href)};
await new InstalledPluginRegistry({ configDir: process.argv[2] }).add(process.argv[3]);\n`
);
const runWorker = (pluginRoot) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, concurrentConfigDir, pluginRoot], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`plugin worker exited ${code}: ${stderr}`))
    );
  });
await Promise.all([runWorker(concurrentPluginDirs[0]), runWorker(concurrentPluginDirs[1])]);
assert.deepEqual(
  (await new InstalledPluginRegistry({ configDir: concurrentConfigDir }).list()).map(
    ({ id }) => id
  ),
  ['concurrent/one', 'concurrent/two']
);

const heartbeatConfigDir = path.join(root, 'heartbeat-config');
const slowPluginDir = path.join(root, 'slow-plugin');
const quickPluginDir = path.join(root, 'quick-plugin');
const setupMarker = path.join(root, 'slow-setup-started');
for (const directory of [slowPluginDir, quickPluginDir]) {
  await mkdir(directory, { recursive: true });
}
await writeFile(
  path.join(slowPluginDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'concurrent/slow',
    version: '1.0.0',
    runtime: { module: './plugin.mjs' },
  })
);
await writeFile(
  path.join(slowPluginDir, 'plugin.mjs'),
  `import { writeFileSync } from 'node:fs';
export default {
  id: 'concurrent/slow',
  async setup() {
    writeFileSync(${JSON.stringify(setupMarker)}, 'started');
    await new Promise((resolve) => setTimeout(resolve, 6200));
  }
};
`
);
await writeFile(
  path.join(quickPluginDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'concurrent/quick',
    version: '1.0.0',
    runtime: { module: './plugin.mjs' },
  })
);
await writeFile(
  path.join(quickPluginDir, 'plugin.mjs'),
  "export default { id: 'concurrent/quick', setup() {} };\n"
);
const heartbeatRegistry = new InstalledPluginRegistry({ configDir: heartbeatConfigDir });
await heartbeatRegistry.add(slowPluginDir);
const enabling = heartbeatRegistry.enable('concurrent/slow');
for (let attempts = 0; ; attempts += 1) {
  try {
    await access(setupMarker);
    break;
  } catch (error) {
    if (attempts >= 100) throw error;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const addingWhileLeaseRenews = new InstalledPluginRegistry({
  configDir: heartbeatConfigDir,
}).add(quickPluginDir);
await Promise.all([enabling, addingWhileLeaseRenews]);
assert.deepEqual(
  (await heartbeatRegistry.list()).map(({ id, enabled }) => [id, enabled]),
  [
    ['concurrent/quick', false],
    ['concurrent/slow', true],
  ]
);

const compromisedConfigDir = path.join(root, 'compromised-config');
const compromisedRegistry = new InstalledPluginRegistry({ configDir: compromisedConfigDir });
await compromisedRegistry.add(slowPluginDir);
await rm(setupMarker, { force: true });
const compromisedEnable = compromisedRegistry.enable('concurrent/slow');
for (let attempts = 0; ; attempts += 1) {
  try {
    await access(setupMarker);
    break;
  } catch (error) {
    if (attempts >= 100) throw error;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
await rm(path.join(compromisedConfigDir, 'plugins.lock'), {
  recursive: true,
  force: true,
});
await assert.rejects(compromisedEnable, /lock was compromised/);
assert.deepEqual(
  (await compromisedRegistry.list()).map(({ id, enabled }) => [id, enabled]),
  [['concurrent/slow', false]]
);

const hangingPluginDir = path.join(root, 'hanging-plugin');
await mkdir(hangingPluginDir, { recursive: true });
await writeFile(
  path.join(hangingPluginDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'sample/hanging',
    version: '1.0.0',
    runtime: { module: './plugin.mjs' },
  })
);
await writeFile(
  path.join(hangingPluginDir, 'plugin.mjs'),
  `export default {
  id: 'sample/hanging',
  setup() {
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  }
};
`
);
const hangingConfigDir = path.join(root, 'hanging-config');
const hangingRegistry = new InstalledPluginRegistry({ configDir: hangingConfigDir });
await hangingRegistry.add(hangingPluginDir);
await assert.rejects(
  hangingRegistry.enable('sample/hanging'),
  /setup validation timed out after 15 seconds/
);
assert.equal((await hangingRegistry.list())[0]?.enabled, false);

const escapedPluginDir = path.join(root, 'escaped-plugin');
const outsideRuntimeDir = path.join(root, 'outside-runtime');
await mkdir(escapedPluginDir, { recursive: true });
await mkdir(outsideRuntimeDir, { recursive: true });
await writeFile(
  path.join(outsideRuntimeDir, 'plugin.mjs'),
  "export default { id: 'sample/escaped', setup() {} };\n"
);
await symlink(
  outsideRuntimeDir,
  path.join(escapedPluginDir, 'linked-runtime'),
  process.platform === 'win32' ? 'junction' : 'dir'
);
await writeFile(
  path.join(escapedPluginDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'sample/escaped',
    version: '1.0.0',
    runtime: { module: './linked-runtime/plugin.mjs' },
  })
);
await assert.rejects(() => readMossPluginManifest(escapedPluginDir), /escapes plugin root/);

const invalidVersionDir = path.join(root, 'invalid-version-plugin');
await mkdir(invalidVersionDir, { recursive: true });
await writeFile(
  path.join(invalidVersionDir, 'plugin.mjs'),
  "export default { id: 'sample/invalid-version', setup() {} };\n"
);
for (const version of ['01.2.3', '1.2.3-.']) {
  await writeFile(
    path.join(invalidVersionDir, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'sample/invalid-version',
      version,
      runtime: { module: './plugin.mjs' },
    })
  );
  await assert.rejects(() => readMossPluginManifest(invalidVersionDir), /semantic version/);
}

const corruptConfigDir = path.join(root, 'corrupt-config');
await mkdir(path.join(corruptConfigDir, 'plugins'), { recursive: true });
await writeFile(
  path.join(corruptConfigDir, 'plugins', 'installed.json'),
  JSON.stringify({ schemaVersion: 1, plugins: [null] })
);
await assert.rejects(
  () => new InstalledPluginRegistry({ configDir: corruptConfigDir }).list(),
  /unable to read/
);

console.log('  [PASS] installed plugin registry: manifest, lifecycle, isolation');
