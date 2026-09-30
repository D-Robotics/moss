#!/usr/bin/env node
/**
 * Capability-scoring counterexamples, each one produced by adversarial review
 * against the previous scorer. Every case here was red before the rewrite:
 * generic-word sweeps, blind Chinese goals, stem-order misses, prefix false
 * positives, same-score crowd-out, and the catalog-wins blind spot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchTaskCapabilities, buildCapabilityPromptLayer } from '../dist/core/task/capability.js';
import { buildCapabilityLayerForGoal } from '../dist/cli/task-run.js';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';

const FIXTURE = path.join(process.cwd(), 'test', 'fixtures', 'mcp-catalog-server.mjs');

async function connect() {
  const registry = await McpToolRegistry.connectAll(
    [{ name: 'catalog', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
    { registerTool: () => {} }
  );
  return { registry };
}

test('zh generic words do not sweep (re-review counterexample)', () => {
  const tools = Array.from({ length: 12 }, (_, index) => ({
    name: `mcp__audit__tool_${String(index).padStart(2, '0')}`,
    description: '记录系统信息与任务状态，便于审计',
  }));
  const match = matchTaskCapabilities('列出所有信息并记录任务状态', { mcpTools: tools });
  assert.equal(
    match.candidates.length,
    0,
    `zh document-shape words must not count as matches; got ${match.candidates
      .map((candidate) => candidate.name)
      .join(', ')}`
  );
});

test('a single glossary hit does not recommend destructive tools', () => {
  const match = matchTaskCapabilities('查看任务信息', {
    mcpTools: [
      {
        name: 'mcp__ops__task_queue_purge',
        description: 'purge the task queue, dropping all pending tasks',
      },
    ],
  });
  assert.equal(
    match.candidates.filter((candidate) => candidate.name === 'mcp__ops__task_queue_purge').length,
    0,
    'one zh→en mapping alone must not select a tool it knows nothing about'
  );
});

test('multi-word Chinese goals still select via the glossary', () => {
  const match = matchTaskCapabilities('调整摄像头的曝光和增益', {
    mcpTools: [
      {
        name: 'mcp__catalog__camera_tune',
        description: 'tune camera exposure and gain for the board camera pipeline',
      },
    ],
  });
  assert.ok(match.candidates.some((candidate) => candidate.name === 'mcp__catalog__camera_tune'));
});

test('doubled-consonant stems match: stopped ↔ stop', () => {
  const match = matchTaskCapabilities('the service stopped responding', {
    mcpTools: [{ name: 'mcp__host__stop_leaks', description: 'stop memory leaks fast' }],
  });
  assert.ok(match.candidates.some((candidate) => candidate.name === 'mcp__host__stop_leaks'));
});

test('a repetitive goal cannot bloat the reason string', () => {
  const goal = Array.from({ length: 60 }, () => 'camera').join(' ');
  const match = matchTaskCapabilities(goal, {
    skills: [
      {
        name: 'rdk-camera-tuning',
        description: 'Tune the RDK camera pipeline: ISP parameters, FPS measurement',
        file: '/x/a.md',
      },
    ],
  });
  const layer = buildCapabilityPromptLayer(match);
  const line = layer.split('\n').find((l) => l.includes('rdk-camera-tuning'));
  assert.ok(line, 'skill line rendered');
  assert.ok(line.length < 300, `skill line must stay bounded, got ${line.length}`);
});

test('record/report are generic too (re-review counterexample)', () => {
  const match = matchTaskCapabilities('record the failing tests in a report', {
    mcpTools: ledgerTools,
  });
  assert.equal(match.candidates.length, 0);
});

test('prefix must be inflection completion: compute does not mean computer', () => {
  const match = matchTaskCapabilities('benchmark the compute nodes', {
    mcpTools: [{ name: 'mcp__host__computer_vision', description: 'computer vision inference' }],
  });
  assert.equal(match.candidates.length, 0);
});

test('inflection completion still works: measure ↔ measurement', () => {
  const match = matchTaskCapabilities('check the frame measurement latency', {
    mcpTools: [{ name: 'mcp__host__measure_probe', description: 'measure frame timing' }],
  });
  assert.ok(match.candidates.some((candidate) => candidate.name === 'mcp__host__measure_probe'));
});

test('battery and audio goals select via the glossary', () => {
  const battery = matchTaskCapabilities('查看电池电量', {
    mcpTools: [{ name: 'mcp__power__battery_probe', description: 'battery level and health' }],
  });
  assert.ok(battery.candidates.some((candidate) => candidate.name === 'mcp__power__battery_probe'));

  const audio = matchTaskCapabilities('采集麦克风的音频并保存', {
    mcpTools: [
      { name: 'mcp__sound__audio_capture', description: 'audio capture from a microphone' },
    ],
  });
  assert.ok(audio.candidates.some((candidate) => candidate.name === 'mcp__sound__audio_capture'));
});

test('the layer drops names the reveal did not install', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ghost-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const layer = await buildCapabilityLayerForGoal('tune the camera exposure on the rdk board', {
    workspace,
    sessionKey: 'spec',
    agent: { tools: { getAll: () => [] } },
    mcp: {
      // A stale catalog names a tool the server no longer has.
      catalog: () => [{ name: 'mcp__ghost__camera_tune', description: 'tune camera exposure' }],
      reveal: () => [],
    },
  });
  assert.equal(layer, '', 'a ghost selection must not be advertised as callable');
});

test('a long skill name cannot bloat the layer line', () => {
  const match = matchTaskCapabilities('tune the camera pipeline', {
    skills: [
      {
        name: 'camera-'.repeat(40),
        description: 'Tune the camera pipeline',
        file: '/x/a.md',
      },
    ],
  });
  const layer = buildCapabilityPromptLayer(match);
  const line = layer.split('\n').find((l) => l.includes('Tune the camera'));
  assert.ok(line);
  assert.ok(line.length < 220, `skill line must stay bounded, got ${line.length}`);
});

test('search meta-tool also refuses after closeAll', async () => {
  const { registry } = await connect();
  const searchTool = registry.getTools().find((tool) => tool.name === 'mcp__catalog__search');
  assert.ok(searchTool);
  await registry.closeAll();
  await assert.rejects(
    () => searchTool.execute({}, { workspaceDir: process.cwd(), sessionKey: 'spec' }),
    /not callable: server state is "closed"/
  );
});

const ledgerTools = Array.from({ length: 20 }, (_, index) => ({
  name: `mcp__ledger__tool_${String(index).padStart(2, '0')}`,
  description: 'ledger entry list and file notes record',
}));

test('a generic-word goal does not sweep in unrelated tools', () => {
  const match = matchTaskCapabilities('list all failing tests and write a summary file', {
    mcpTools: ledgerTools,
  });
  assert.equal(
    match.candidates.length,
    0,
    `document-shape words must not count as matches; got ${match.candidates
      .map((candidate) => candidate.name)
      .join(', ')}`
  );
});

test('a Chinese goal selects english-described capabilities (glossary bigrams)', () => {
  const match = matchTaskCapabilities('调整摄像头的曝光和增益', {
    mcpTools: [
      {
        name: 'mcp__catalog__camera_tune',
        description: 'tune camera exposure and gain for the board camera pipeline',
      },
      { name: 'mcp__ledger__invoice_list', description: 'list invoices for the billing system' },
    ],
  });
  assert.ok(match.candidates.some((candidate) => candidate.name === 'mcp__catalog__camera_tune'));
  assert.ok(!match.candidates.some((candidate) => candidate.name === 'mcp__ledger__invoice_list'));
});

test('Chinese matches Chinese directly (bigram overlap)', () => {
  const match = matchTaskCapabilities('调整摄像头的曝光和增益', {
    skills: [
      {
        name: 'rdk-camera-tuning',
        description: '调优摄像头的曝光与增益参数',
        file: '/x/a.md',
      },
    ],
  });
  assert.ok(match.candidates.some((candidate) => candidate.name === 'rdk-camera-tuning'));
});

test('stem variants match: types ↔ type', () => {
  const match = matchTaskCapabilities('fix the failing types in the module', {
    mcpTools: [{ name: 'mcp__host__type_check', description: 'check variable types' }],
  });
  assert.ok(match.candidates.some((candidate) => candidate.name === 'mcp__host__type_check'));
});

test('short-stem prefixes do not fire: REST does not mean restart', () => {
  const match = matchTaskCapabilities('check the REST API response shape', {
    mcpTools: [{ name: 'mcp__host__restart_service', description: 'restarts the service process' }],
  });
  assert.equal(
    match.candidates.filter((candidate) => candidate.name === 'mcp__host__restart_service').length,
    0
  );
});

test('same-score skills cannot crowd out an equally relevant mcp tool', () => {
  const skills = Array.from({ length: 6 }, (_, index) => ({
    name: `mount-guide-${index}`,
    description: 'camera mount notes variant',
    file: '/x/s${index}.md',
  }));
  const match = matchTaskCapabilities('calibrate the camera mount on the robot arm', {
    skills,
    mcpTools: [{ name: 'mcp__catalog__camera_probe', description: 'camera calibration probe' }],
  });
  assert.ok(
    match.candidates.some((candidate) => candidate.kind === 'mcp-tool'),
    'the mcp tool must keep a slot when it scores as well as the skills'
  );
});

test('host-registered mcp tools stay visible when a catalog port is present', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-merge-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const layer = await buildCapabilityLayerForGoal('mount the camera on the robot arm', {
    workspace,
    sessionKey: 'spec',
    agent: {
      tools: {
        getAll: () => [
          { name: 'mcp__host__custom_mount', description: 'custom camera mount helper' },
        ],
      },
    },
    mcp: {
      catalog: () => [{ name: 'mcp__catalog__camera_tune', description: 'tune camera exposure' }],
      reveal: (wireNames) => wireNames,
    },
  });
  assert.match(layer, /mcp__host__custom_mount/, 'the registered view must not be dropped');
  assert.match(layer, /mcp__catalog__camera_tune/);
});
