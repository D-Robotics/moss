#!/usr/bin/env node
/**
 * Capability discovery selects MCP tools per task — and the selection is real.
 *
 * The registry caches every server's tools/list at connect time, but real tools
 * are registered lazily (deliberately: 50 schemas must not enter the prompt).
 * That design left capability discovery able to see only the search meta-tool,
 * so "per-task MCP selection" could name servers but never tools.
 *
 * These cases pin the standard: match against the full catalog, reveal exactly
 * the matched tools, leave the rest uncallable, and never invent a selection for
 * an unrelated goal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';
import { buildCapabilityLayerForGoal } from '../dist/cli/task-run.js';
import { matchTaskCapabilities, buildCapabilityPromptLayer } from '../dist/core/task/capability.js';

const FIXTURE = path.join(process.cwd(), 'test', 'fixtures', 'mcp-catalog-server.mjs');

async function connect() {
  const registered = new Map();
  const registry = await McpToolRegistry.connectAll(
    [{ name: 'catalog', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
    { registerTool: (tool) => registered.set(tool.name, tool) }
  );
  return { registry, registered };
}

function port(registry, revealed) {
  return {
    catalog: () =>
      registry.getCatalog().map((entry) => ({
        name: entry.wireName,
        description: entry.description,
      })),
    reveal: (wireNames) => {
      const installed = registry.revealTools(wireNames);
      revealed.push(...installed);
      return installed;
    },
  };
}

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-mcp-select-'));
}

test('the connect-time tools/list becomes a selectable catalog', async (t) => {
  const { registry } = await connect();
  t.after(() => registry.closeAll());

  const catalog = registry.getCatalog();
  assert.equal(catalog.length, 7, 'every server tool is selectable');
  const camera = catalog.find((entry) => entry.tool === 'camera_tune');
  assert.equal(camera.server, 'catalog');
  assert.equal(camera.wireName, 'mcp__catalog__camera_tune');
  assert.match(camera.description, /exposure and gain/);
  // The catalog is metadata only: nothing was registered into the host.
  assert.equal(registry.getTools().length, 1, 'only the search meta-tool is eager');
});

test('revealTools installs exactly the selected tools', async (t) => {
  const { registry, registered } = await connect();
  t.after(() => registry.closeAll());

  const revealed = registry.revealTools(['mcp__catalog__gpio_read']);
  assert.deepEqual(revealed, ['mcp__catalog__gpio_read']);
  assert.ok(registered.has('mcp__catalog__gpio_read'), 'selected tool is callable');
  assert.ok(!registered.has('mcp__catalog__camera_tune'), 'unselected tools stay uncallable');

  // Idempotent: a repeated selection must not register twice or throw.
  assert.deepEqual(registry.revealTools(['mcp__catalog__gpio_read']), ['mcp__catalog__gpio_read']);
  // Unknown wire names are ignored, not fatal.
  assert.deepEqual(registry.revealTools(['mcp__catalog__nope']), []);
});

test('a camera goal selects the camera tool and makes it callable', async (t) => {
  const { registry, registered } = await connect();
  t.after(() => registry.closeAll());
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const revealed = [];
  const layer = await buildCapabilityLayerForGoal('tune the camera exposure on the rdk board', {
    workspace: dir,
    sessionKey: 'spec',
    agent: { tools: { getAll: () => [] } },
    mcp: port(registry, revealed),
  });

  assert.match(layer, /mcp__catalog__camera_tune/, 'the layer names the matched tool');
  assert.ok(
    revealed.includes('mcp__catalog__camera_tune'),
    `the matched tool must become callable, revealed: ${revealed.join(', ')}`
  );
  assert.ok(registered.has('mcp__catalog__camera_tune'), 'registered in the host tool list');
  assert.ok(
    !registered.has('mcp__catalog__invoice_list'),
    'an unrelated tool must not be loaded and must not cost prompt tokens'
  );
});

test('MOSS_CAPABILITY_LAYER=off disables discovery entirely (A/B switch)', async (t) => {
  const { registry } = await connect();
  t.after(() => registry.closeAll());
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const revealed = [];
  const previous = process.env.MOSS_CAPABILITY_LAYER;
  process.env.MOSS_CAPABILITY_LAYER = 'off';
  t.after(() => {
    if (previous === undefined) delete process.env.MOSS_CAPABILITY_LAYER;
    else process.env.MOSS_CAPABILITY_LAYER = previous;
  });

  const layer = await buildCapabilityLayerForGoal('tune the camera exposure on the rdk board', {
    workspace: dir,
    sessionKey: 'spec',
    agent: { tools: { getAll: () => [] } },
    mcp: port(registry, revealed),
  });
  assert.equal(layer, '');
  assert.deepEqual(revealed, [], 'nothing may be revealed while the layer is off');
});

test('an unrelated goal reveals nothing (no context bloat, no invented selection)', async (t) => {
  const { registry, registered } = await connect();
  t.after(() => registry.closeAll());
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const revealed = [];
  await buildCapabilityLayerForGoal('reorganize the build scripts', {
    workspace: dir,
    sessionKey: 'spec',
    agent: { tools: { getAll: () => [] } },
    mcp: port(registry, revealed),
  });

  assert.deepEqual(revealed, [], 'nothing matched, so nothing is revealed');
  for (const name of registered.keys()) {
    assert.match(name, /__search$/, `only the meta-tool may be registered, saw ${name}`);
  }
});

test('production wiring: an unmatched goal still names the server to search', async (t) => {
  const { registry } = await connect();
  t.after(() => registry.closeAll());
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const revealed = [];
  const layer = await buildCapabilityLayerForGoal('reorganize the build scripts', {
    workspace: dir,
    sessionKey: 'spec',
    agent: {
      tools: {
        getAll: () =>
          registry.getTools().map((tool) => ({ name: tool.name, description: tool.description })),
      },
    },
    mcp: port(registry, revealed),
  });
  assert.match(
    layer,
    /mcp__catalog__search/,
    'the catalog-only path must not kill the search fallback'
  );
  assert.deepEqual(revealed, []);
});

test('a verbose server description cannot blow the revealed tool schema', async (t) => {
  const { registry, registered } = await connect();
  t.after(() => registry.closeAll());

  registry.revealTools(['mcp__catalog__verbose_tool']);
  const tool = registered.get('mcp__catalog__verbose_tool');
  assert.ok(tool, 'verbose tool was revealed');
  assert.ok(
    tool.description.length < 700,
    `revealed description must stay bounded, got ${tool.description.length}`
  );
});

test('a revealed tool refuses cleanly after closeAll', async (t) => {
  const { registry, registered } = await connect();
  registry.revealTools(['mcp__catalog__gpio_read']);
  const tool = registered.get('mcp__catalog__gpio_read');
  assert.ok(tool);
  await registry.closeAll();

  await assert.rejects(
    () => tool.execute({}, { workspaceDir: process.cwd(), sessionKey: 'spec' }),
    /not callable: server state is "closed"/
  );
});

test('a hostile description cannot blow the planning prompt', () => {
  const match = matchTaskCapabilities('measure camera latency', {
    mcpTools: [
      {
        name: 'mcp__catalog__camera_probe',
        description: `camera latency probe ${'x'.repeat(5000)}`,
      },
    ],
  });
  const layer = buildCapabilityPromptLayer(match);
  const line = layer.split('\n').find((l) => l.includes('mcp__catalog__camera_probe'));
  assert.ok(line, 'the candidate is rendered');
  assert.ok(line.length <= 220, `candidate line must stay bounded, got ${line.length}`);
  assert.match(line, /…$/, 'the cap must be visible, not a silent cut');
});

test('without the mcp port the layer falls back to registered tools', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const layer = await buildCapabilityLayerForGoal('measure camera latency', {
    workspace: dir,
    sessionKey: 'spec',
    agent: {
      tools: {
        getAll: () => [
          { name: 'mcp__catalog__camera_probe', description: 'measure camera frame rate' },
        ],
      },
    },
  });
  assert.match(layer, /mcp__catalog__camera_probe/);
});
