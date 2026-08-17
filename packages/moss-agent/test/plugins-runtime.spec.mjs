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
  "import { isMainThread } from 'node:worker_threads'; export default { id: 'broken/startup', setup() { if (isMainThread) throw new Error('BROKEN_SETUP'); } };\n"
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
