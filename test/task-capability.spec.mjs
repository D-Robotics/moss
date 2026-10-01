#!/usr/bin/env node
/**
 * Task OS M7 — capability discovery: goal text scores against skill
 * manifests and registered tools; device signals detected; the planner gets
 * a focused layer instead of the user hand-picking tools.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchTaskCapabilities, buildCapabilityPromptLayer } from '../dist/core/task/capability.js';

const SKILLS = [
  {
    name: 'rdk-camera-tuning',
    description: 'Tune RDK camera pipeline: ISP parameters, buffer counts, FPS measurement',
    when: 'camera fps or image quality tasks on RDK boards',
    file: '/x/a.md',
  },
  {
    name: 'ros2-navigation',
    description: 'ROS 2 navigation stack: nodes, topics, goal posing, safety limits',
    when: 'navigation and odometry tasks',
    file: '/x/b.md',
  },
  {
    name: 'model-quantization',
    description: 'Quantize and deploy models on RDK BPU runtimes',
    file: '/x/c.md',
  },
];

test('camera goal surfaces the camera skill and camera device tools first', () => {
  const match = matchTaskCapabilities('optimize the RDK camera FPS to at least 30', {
    skills: SKILLS,
    builtinTools: ['device_cameras', 'device_exec', 'device_deploy', 'write_file', 'web_search'],
  });
  assert.equal(match.deviceTask, true);
  const top = match.candidates[0];
  assert.equal(top.kind, 'skill');
  assert.equal(top.name, 'rdk-camera-tuning');
  // Builtin tools are no longer candidates: the provider tool list always
  // carries them, so narrowing them adds cost without information.
  assert.ok(!match.candidates.some((c) => c.kind === 'builtin-tool'));
  assert.ok(!match.candidates.some((c) => c.name === 'ros2-navigation'));

  const layer = buildCapabilityPromptLayer(match);
  assert.match(layer, /## Task capability discovery/);
  assert.match(layer, /device\/robotics task/);
  assert.match(layer, /- rdk-camera-tuning — Tune RDK camera pipeline/);
  // Builtin tool names are not rendered in the layer (they are already in the
  // provider tool list); the matcher still ranks them as candidates.
  assert.doesNotMatch(layer, /Relevant tools/);
});

test('ROS navigation goal surfaces the ros skill, not the camera one', () => {
  const match = matchTaskCapabilities('make the robot navigate to the charging dock safely', {
    skills: SKILLS,
    builtinTools: ['device_exec', 'device_robotics_status'],
  });
  assert.equal(match.deviceTask, true);
  assert.ok(match.candidates.some((c) => c.name === 'ros2-navigation'));
  assert.ok(!match.candidates.some((c) => c.name === 'rdk-camera-tuning'));
});

test('plain coding goal: no device signal, sparse candidates, honest layer', () => {
  const match = matchTaskCapabilities('refactor the parser module for readability', {
    skills: SKILLS,
    builtinTools: ['write_file', 'edit_file'],
  });
  assert.equal(match.deviceTask, false);
  const layer = buildCapabilityPromptLayer(match);
  if (match.candidates.length === 0) {
    assert.equal(layer, '');
  }
});

test('mcp tools match on name and description', () => {
  const match = matchTaskCapabilities('measure camera latency', {
    mcpTools: [
      { name: 'mcp__vision__camera_probe', description: 'camera latency and fps probes' },
      { name: 'mcp__billing__invoice', description: 'invoices' },
    ],
  });
  assert.ok(
    match.candidates.some((c) => c.kind === 'mcp-tool' && c.name === 'mcp__vision__camera_probe')
  );
  assert.ok(!match.candidates.some((c) => c.name === 'mcp__billing__invoice'));
});

test('mcp servers stay reachable even when no tool name matches', () => {
  const match = matchTaskCapabilities('regenerate the quarterly report', {
    mcpTools: [
      { name: 'mcp__vision__search' },
      { name: 'mcp__billing__search', description: 'search billing tools' },
    ],
  });
  assert.ok(
    !match.candidates.some((c) => c.name.endsWith('__search')),
    'the meta search tool is an entry point, not a capability candidate'
  );
  assert.deepEqual(match.mcpServers, ['vision', 'billing']);
  const layer = buildCapabilityPromptLayer(match);
  assert.match(layer, /mcp__billing__search/);
  assert.match(layer, /mcp__vision__search/);
});

test('matched mcp tools are named with their server, per task', () => {
  const match = matchTaskCapabilities('measure camera latency on the board', {
    mcpTools: [
      {
        name: 'mcp__vision__camera_probe',
        description: 'camera latency and fps probes\nsecond line',
      },
      { name: 'mcp__billing__invoice', description: 'invoices' },
      { name: 'mcp__vision__search' },
    ],
  });
  const probe = match.candidates.find((c) => c.name === 'mcp__vision__camera_probe');
  assert.equal(probe.server, 'vision');
  assert.ok(!match.candidates.some((c) => c.name === 'mcp__billing__invoice'));
  const layer = buildCapabilityPromptLayer(match);
  assert.match(
    layer,
    /Relevant MCP tools \(already registered and directly callable by name[^)]*\):/
  );
  assert.match(
    layer,
    /mcp__vision__camera_probe \(server vision\) — camera latency and fps probes/
  );
});

test('chinese device goals are detected', () => {
  const match = matchTaskCapabilities('把机器人的摄像头 FPS 优化到 30 以上并部署到板子', {
    skills: SKILLS,
  });
  assert.equal(match.deviceTask, true);
});
