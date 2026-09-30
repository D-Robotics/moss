#!/usr/bin/env node
/**
 * MCP selection reaches the capability layer (Task OS M12 follow-up).
 *
 * The matcher always supported `mcp-tool` candidates, but the only production
 * caller (`moss task run`) handed it skills + builtins and dropped the MCP
 * inventory entirely — so MCP was never selected per task. This pins the wiring
 * end to end through the exported entry point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCapabilityLayerForGoal } from '../dist/cli/task-run.js';

const AGENT = {
  tools: {
    getAll: () => [
      { name: 'read_file' },
      { name: 'device_cameras' },
      { name: 'mcp__vision__camera_probe', description: 'camera latency and fps probes' },
      { name: 'mcp__vision__search' },
      { name: 'mcp__billing__search' },
      { name: 'mcp__billing__invoice', description: 'invoices' },
    ],
  },
};

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-capability-'));
}

test('a matching goal gets its MCP tool named, and unrelated servers stay out', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const layer = await buildCapabilityLayerForGoal('measure camera latency on the RDK board', {
    workspace: dir,
    agent: AGENT,
  });
  assert.match(layer, /device\/robotics task/);
  assert.match(layer, /mcp__vision__camera_probe/);
  assert.doesNotMatch(layer, /mcp__billing__invoice/, 'unrelated MCP tools must not be advertised');
});

test('an unmatched goal still learns which MCP servers to search', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const layer = await buildCapabilityLayerForGoal('refactor the parser module for readability', {
    workspace: dir,
    agent: AGENT,
  });
  assert.match(layer, /mcp__vision__search/);
  assert.match(layer, /mcp__billing__search/);
});

test('no MCP tools registered → no MCP section invented', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const layer = await buildCapabilityLayerForGoal('measure camera latency', {
    workspace: dir,
    agent: { tools: { getAll: () => [{ name: 'device_cameras' }] } },
  });
  assert.doesNotMatch(layer, /MCP/);
  assert.match(layer, /device_cameras/);
});
