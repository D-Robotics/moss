#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installConfiguredPlugins } from '../dist/cli/plugins-runtime.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';

const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-plugin-startup-'));
const pluginDir = path.join(configDir, 'broken-plugin');
await fs.mkdir(pluginDir, { recursive: true });
await fs.writeFile(
  path.join(pluginDir, 'moss.plugin.json'),
  JSON.stringify({
    schemaVersion: 1,
    id: 'broken/startup',
    version: '1.0.0',
    runtime: { module: './plugin.mjs' },
  })
);
await fs.writeFile(
  path.join(pluginDir, 'plugin.mjs'),
  "export default { id: 'broken/startup', setup() { throw new Error('BROKEN_SETUP'); } };\n"
);
const registry = new InstalledPluginRegistry({ configDir });
await registry.add(pluginDir);
await registry.enable('broken/startup');

const agent = new MossAgent({
  llmProvider: {
    id: 'plugin-startup-test',
    displayName: 'Plugin startup test',
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

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.join(' '));
try {
  await installConfiguredPlugins(agent, configDir);
} finally {
  console.error = originalError;
  await agent.close();
}

assert.deepEqual(agent.plugins.inspect().plugins, []);
assert.ok(errors.some((line) => line.includes('broken/startup') && line.includes('isolated')));
console.log('  [PASS] configured plugin setup failures are isolated from runtime startup');

const recoveryConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-plugin-recovery-'));
const recoveryRegistryDir = path.join(recoveryConfigDir, 'plugins');
const lastGoodDir = path.join(recoveryConfigDir, 'last-good');
const candidateDir = path.join(recoveryConfigDir, 'candidate');
await Promise.all([
  fs.mkdir(recoveryRegistryDir, { recursive: true }),
  fs.mkdir(lastGoodDir, { recursive: true }),
  fs.mkdir(candidateDir, { recursive: true }),
]);
for (const [root, version] of [
  [lastGoodDir, '1.0.0'],
  [candidateDir, '2.0.0'],
]) {
  await fs.writeFile(
    path.join(root, 'moss.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'startup/recovery',
      version,
      runtime: { module: './plugin.mjs' },
    })
  );
}
await fs.writeFile(
  path.join(lastGoodDir, 'plugin.mjs'),
  `export default {
    id: 'startup/recovery',
    setup(context) {
      context.registerCommand({
        id: 'last-good-check',
        title: 'Last-good check',
        expand() { return 'last-good-active'; }
      });
    }
  };\n`
);
await fs.writeFile(
  path.join(candidateDir, 'plugin.mjs'),
  `export default {
    id: 'startup/recovery',
    setup(context) {
      context.registerTool({
        name: 'startup_collision',
        description: 'Force host activation failure.',
        metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
        inputSchema: { type: 'object', properties: {} },
        execute() { return 'candidate'; }
      });
    }
  };\n`
);
await fs.writeFile(
  path.join(recoveryRegistryDir, 'installed.json'),
  JSON.stringify({
    schemaVersion: 1,
    plugins: [
      {
        id: 'startup/recovery',
        version: '2.0.0',
        source: 'startup-recovery@2.0.0',
        root: candidateDir,
        enabled: true,
        installedAt: new Date().toISOString(),
        format: 'moss-v1',
        lastGood: {
          version: '1.0.0',
          source: 'startup-recovery@1.0.0',
          root: lastGoodDir,
          format: 'moss-v1',
        },
      },
    ],
  })
);

const recoveryAgent = new MossAgent({
  llmProvider: {
    id: 'plugin-recovery-test',
    displayName: 'Plugin recovery test',
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
recoveryAgent.tools.register({
  name: 'startup_collision',
  description: 'Existing tool.',
  metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
  inputSchema: { type: 'object', properties: {} },
  execute() {
    return 'existing';
  },
});
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));
try {
  await installConfiguredPlugins(recoveryAgent, recoveryConfigDir);
  assert.equal(
    await recoveryAgent.plugins.expandCommand('last-good-check', ''),
    'last-good-active'
  );
  assert.equal(
    (await new InstalledPluginRegistry({ configDir: recoveryConfigDir }).list())[0]?.version,
    '1.0.0'
  );
  assert.ok(warnings.some((line) => line.includes('last-good 1.0.0 was restored')));
} finally {
  console.warn = originalWarn;
  await recoveryAgent.close();
}
console.log('  [PASS] configured plugin host activation restores and loads last-good generation');
