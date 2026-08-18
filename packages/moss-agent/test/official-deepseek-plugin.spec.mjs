#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMossPluginHost } from '../dist/core/plugins/plugin-host.js';
import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';
import { SkillRegistry } from '../dist/skills/registry.js';

const configDir = await mkdtemp(path.join(os.tmpdir(), 'moss-official-plugin-'));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'moss-official-workspace-'));
const installed = new InstalledPluginRegistry({ configDir });
const entry = await installed.add('official:deepseek-harness');
assert.equal(entry.id, 'deepseek/harness');
assert.equal(entry.enabled, false);

await installed.enable(entry.id);
const loaded = await installed.loadEnabled();
assert.deepEqual(loaded.failures, []);
assert.equal(loaded.plugins.length, 1);

const skills = new SkillRegistry({ workspaceDir, includeBuiltin: false });
const host = createMossPluginHost({
  hasTool: () => false,
  registerTool: () => () => {},
  hasSkill: (id) => skills.hasStableId(id),
  registerSkill: (skill) => skills.registerInline(skill),
  hasExpert: () => false,
  registerExpert: () => () => {},
});
await host.install(loaded.plugins[0]);
const skill = skills.list().find(({ stableId }) => stableId === 'deepseek-harness');
assert.ok(skill);
assert.match(skill.body ?? '', /reasoning_content/);
assert.match(skill.body ?? '', /parallel tool-call deltas/);
assert.match(
  await host.getCommand('deepseek-protocol')?.expand('Review this provider'),
  /Review this provider/
);
assert.deepEqual(host.getMcpPreset('deepseek-harness')?.server, {
  command: 'npx',
  args: ['-y', '@deepseek-harness/mcp@0.2.0'],
  requestTimeoutMs: 30_000,
});
await host.close();
assert.equal(skills.hasStableId('deepseek-harness'), false);
assert.equal(host.getCommand('deepseek-protocol'), undefined);
assert.equal(host.getMcpPreset('deepseek-harness'), undefined);

console.log('  [PASS] official DeepSeek Harness plugin owns its skill, command, and MCP preset');
