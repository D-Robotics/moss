#!/usr/bin/env node
/**
 * The capability layer must see the same surface the agent has.
 *
 * Two inventory mismatches were fixed here, both of the same shape — the agent
 * could use a capability that discovery could not see, so a per-task choice was
 * impossible:
 *   1. MCP: only the lazily-registered search meta-tool was visible (fixed by
 *      selecting from the connect-time tools/list catalog and revealing the
 *      matched tools).
 *   2. Skills: the agent loads <workspace>/.moss/skills AND <configDir>/skills,
 *      discovery loaded only the workspace set (fixed by passing configDir).
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

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSkill(root, dirName, frontmatter, body = 'steps') {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${lines.join('\n')}\n---\n${body}\n`);
}

test('a matching goal gets its MCP tool named, and unrelated servers stay out', async (t) => {
  const dir = await tmp('moss-capability-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const layer = await buildCapabilityLayerForGoal('measure camera latency on the RDK board', {
    workspace: dir,
    sessionKey: 'spec',
    agent: AGENT,
  });
  assert.match(layer, /device\/robotics task/);
  assert.match(layer, /mcp__vision__camera_probe/);
  assert.doesNotMatch(layer, /mcp__billing__invoice/, 'unrelated MCP tools must not be advertised');
});

test('an unmatched goal still learns which MCP servers to search', async (t) => {
  const dir = await tmp('moss-capability-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const layer = await buildCapabilityLayerForGoal('refactor the parser module for readability', {
    workspace: dir,
    sessionKey: 'spec',
    agent: AGENT,
  });
  assert.match(layer, /mcp__vision__search/);
  assert.match(layer, /mcp__billing__search/);
});

test('builtin-only matches stay silent (the layer must earn its tokens)', async (t) => {
  const dir = await tmp('moss-capability-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const layer = await buildCapabilityLayerForGoal('measure camera latency', {
    workspace: dir,
    sessionKey: 'spec',
    agent: { tools: { getAll: () => [{ name: 'device_cameras' }] } },
  });
  // device_cameras is already in the provider tool list; restating it in the
  // prompt measured as a net cost in the layer A/B run, so the layer says
  // nothing until it knows something the model cannot already see.
  assert.equal(layer, '');
});

test('user config skills are discoverable, not just workspace skills', async (t) => {
  const workspace = await tmp('moss-ws-');
  const configDir = await tmp('moss-cfg-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));

  await writeSkill(path.join(configDir, 'skills'), 'rdk-camera-tuning', {
    name: 'rdk-camera-tuning',
    description: 'Tune the RDK camera pipeline: ISP parameters, FPS measurement',
    when: 'camera fps or image quality tasks',
  });

  // Without configDir the user skill is invisible (the old behaviour).
  const blind = await buildCapabilityLayerForGoal('optimize the camera fps on the board', {
    workspace,
    sessionKey: 'spec',
    agent: { tools: { getAll: () => [] } },
  });
  assert.doesNotMatch(blind, /rdk-camera-tuning/);

  const aware = await buildCapabilityLayerForGoal('optimize the camera fps on the board', {
    workspace,
    sessionKey: 'spec',
    configDir,
    agent: { tools: { getAll: () => [] } },
  });
  assert.match(aware, /rdk-camera-tuning/, 'the user skill must be selectable per task');
});

test('workspace skills win on a name collision (same precedence as the agent)', async (t) => {
  const workspace = await tmp('moss-ws-');
  const configDir = await tmp('moss-cfg-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));

  await fs.mkdir(path.join(workspace, '.moss', 'skills'), { recursive: true });
  await writeSkill(path.join(workspace, '.moss', 'skills'), 'camera-tuning', {
    name: 'camera-tuning',
    description: 'workspace camera tuning variant',
  });
  await writeSkill(path.join(configDir, 'skills'), 'camera-tuning', {
    name: 'camera-tuning',
    description: 'user camera tuning variant',
  });

  const layer = await buildCapabilityLayerForGoal('tune the camera pipeline', {
    workspace,
    sessionKey: 'spec',
    configDir,
    agent: { tools: { getAll: () => [] } },
  });
  assert.match(layer, /workspace camera tuning variant/);
  assert.doesNotMatch(layer, /user camera tuning variant/);
});
