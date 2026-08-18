#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMossPluginHost } from '../dist/core/plugins/plugin-host.js';
import {
  importDshPackage,
  inspectDshPackageCompatibility,
} from '../dist/plugins/dsh-bundle-compatibility.js';

async function packageFixture(root, packageJson, patch) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson));
  await writeFile(path.join(root, 'cordis.patch.yml'), patch);
}

test('a real DSH package shape imports only SKILL.md and explicit Moss adapter data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss dsh package 配置 '));
  await packageFixture(
    root,
    {
      name: '@fixture/dsh-protocol',
      version: '1.0.0',
      dependencies: { '@deepseek-ai/cordis': '1.0.0' },
    },
    'services:\n  protocol:\n    enabled: true\n'
  );
  await writeFile(
    path.join(root, 'SKILL.md'),
    '---\nname: dsh-protocol\n---\nCheck the protocol contract and cite evidence.\n'
  );
  await writeFile(
    path.join(root, 'moss.dsh-adapter.json'),
    JSON.stringify({
      commands: [{ id: 'dsh-review', title: 'Review DSH', prompt: 'Review:\n\n{{args}}' }],
      mcp: [
        {
          id: 'dsh-tools',
          name: 'DSH tools',
          command: 'npx',
          args: ['-y', '@fixture/dsh-tools@1.0.0'],
          env: { MODE: 'readonly' },
        },
      ],
      configSchema: {
        type: 'object',
        properties: { apiKey: { type: 'string', writeOnly: true } },
      },
    })
  );

  const report = await inspectDshPackageCompatibility(root);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.imported, [
    'skill:fixture-dsh-protocol',
    'command:dsh-review',
    'mcp:dsh-tools',
    'config:schema',
  ]);
  assert.deepEqual(report.skipped, ['cordis.patch.yml runtime']);

  const imported = await importDshPackage(root);
  assert.equal(imported.configSchema?.properties.apiKey.writeOnly, true);
  const skills = new Map();
  const host = createMossPluginHost({
    hasTool: () => false,
    registerTool: () => () => {},
    hasSkill: (id) => skills.has(id),
    registerSkill: (skill) => {
      skills.set(skill.stableId ?? skill.name, skill);
      return () => skills.delete(skill.stableId ?? skill.name);
    },
    hasExpert: () => false,
    registerExpert: () => () => {},
  });
  try {
    await host.install(imported.plugin);
    assert.match(skills.get('fixture-dsh-protocol')?.body ?? '', /protocol contract/);
    assert.equal(await host.expandCommand('dsh-review', 'provider'), 'Review:\n\nprovider');
    assert.deepEqual(host.getMcpPreset('dsh-tools')?.server.env, { MODE: 'readonly' });
  } finally {
    await host.close();
  }
});

test('a real DSH Cordis client package is rejected instead of half-loaded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-dsh-ui-'));
  await packageFixture(
    root,
    {
      name: '@fixture/dsh-client-ui',
      version: '1.0.0',
      dependencies: { '@deepseek-ai/dsh-client': '1.0.0' },
      dsh: { client: './client.js' },
    },
    'inject:\n  - dsh.client.slot.conversation\n'
  );
  await writeFile(path.join(root, 'SKILL.md'), 'This must not be half-loaded.\n');

  const report = await inspectDshPackageCompatibility(root);
  assert.equal(report.compatible, false);
  assert.deepEqual(report.imported, []);
  assert.match(report.reasons.join(' '), /unsupported Cordis client UI slots/);
  await assert.rejects(importDshPackage(root), /unsupported Cordis client UI slots/);
});

test('DSH adapter MCP env values are validated one by one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-dsh-env-'));
  await packageFixture(root, { name: 'dsh-invalid-env', version: '1.0.0' }, 'services: {}\n');
  await writeFile(
    path.join(root, 'moss.dsh-adapter.json'),
    JSON.stringify({ mcp: [{ id: 'bad', name: 'Bad', command: 'node', env: { PORT: 1234 } }] })
  );
  const report = await inspectDshPackageCompatibility(root);
  assert.equal(report.compatible, false);
  assert.match(report.reasons.join(' '), /env\.PORT must be a string/);
});

test('DSH package identity requires a Moss-safe id and exact semantic version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-dsh-identity-'));
  await packageFixture(root, { name: '---', version: 'workspace:*' }, 'services: {}\n');
  await writeFile(path.join(root, 'SKILL.md'), 'Identity must fail before import.\n');
  const report = await inspectDshPackageCompatibility(root);
  assert.equal(report.compatible, false);
  assert.match(report.reasons.join(' '), /invalid plugin id|exact semantic version/);
});
