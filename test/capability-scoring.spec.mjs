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
import { matchTaskCapabilities } from '../dist/core/task/capability.js';
import { buildCapabilityLayerForGoal } from '../dist/cli/task-run.js';

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
      reveal: () => {},
    },
  });
  assert.match(layer, /mcp__host__custom_mount/, 'the registered view must not be dropped');
  assert.match(layer, /mcp__catalog__camera_tune/);
});
