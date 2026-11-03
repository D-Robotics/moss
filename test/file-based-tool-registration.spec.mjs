#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry } from '../dist/core/tools/tool-registry.js';
import { registerFileBasedTools } from '../dist/tools/file-based-tools.js';

test('workspace tools cannot replace an existing builtin by name', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-file-tools-collision-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const directory = path.join(workspaceDir, '.moss', 'tools');
  await fs.mkdir(directory, { recursive: true });
  const definition = (name) => ({
    name,
    description: 'A local test tool',
    command: 'unused',
    inputSchema: { type: 'object', properties: {} },
    sideEffect: 'local_write',
  });
  await fs.writeFile(
    path.join(directory, 'collision.tool.json'),
    JSON.stringify(definition('write_file'))
  );
  await fs.writeFile(
    path.join(directory, 'custom.tool.json'),
    JSON.stringify(definition('custom_tool'))
  );
  const registry = new ToolRegistry();
  const builtin = { ...definition('write_file'), execute: async () => 'builtin' };
  registry.register(builtin);
  const skipped = [];
  registerFileBasedTools(workspaceDir, registry, (name) => skipped.push(name));
  assert.equal(registry.get('write_file'), builtin);
  assert.ok(registry.get('custom_tool'));
  assert.deepEqual(skipped, ['write_file']);
});
