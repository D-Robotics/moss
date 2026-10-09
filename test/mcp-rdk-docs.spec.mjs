#!/usr/bin/env node
/**
 * Built-in rdk-docs MCP: registration, opt-out, failure messaging, and the
 * device-safety sentences that stay. The server is a local fixture — no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mergeConfigFiles } from '../dist/cli/config.js';
import { loadMcpConfigs } from '../dist/cli/mcp-config.js';
import {
  formatMcpStartupLine,
  hasDeviceTarget,
  rdkDocsAutoConnectEnabled,
  rdkDocsOptOut,
  readRdkDocsFlag,
  resolveRdkDocsPackage,
  withBuiltinRdkDocs,
} from '../dist/cli/rdk-docs-mcp.js';
import { resolveMcpClientTimeouts } from '../dist/core/mcp/client.js';
import {
  RDK_DOCS_CONNECTED_LAYER,
  DEFAULT_RDK_DOCS_MCP_PACKAGE,
  RDK_DOCS_UNAVAILABLE_LAYER,
  builtinRdkDocsServerConfig,
  rdkDocsKnowledgeLayer,
} from '../dist/core/mcp/rdk-docs.js';
import { McpToolRegistry, buildMcpPromptLayer } from '../dist/core/mcp/registry.js';
import { buildSkillsPromptLayer } from '../dist/core/skills/skill-registry.js';
import {
  bundledRdkDocsSkill,
  includeBundledRdkDocsSkill,
} from '../dist/core/skills/rdk-docs-skill.js';
import { createSkillTool } from '../dist/tools/skill-tool.js';
import { ROBOTICS_PROBE_SCRIPT } from '../dist/device/observation.js';
import {
  deviceCamerasTool,
  deviceExecTool,
  deviceInfoTool,
  deviceRoboticsStatusTool,
} from '../dist/tools/device-tools.js';
import { createWebFetchTool } from '../dist/tools/web-fetch.js';
import { appendShellContinueHint } from '../dist/safety/shell-soft-failure-hint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mcp-rdk-docs-server.mjs');

function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

test('builtin rdk-docs uses one pinned default and hardened npx arguments', () => {
  const config = builtinRdkDocsServerConfig();
  assert.equal(config.name, 'rdk-docs');
  assert.equal(config.transport, 'stdio');
  assert.equal(config.command, 'npx');
  assert.deepEqual(config.args, [
    '--yes',
    '--ignore-scripts',
    `--package=${DEFAULT_RDK_DOCS_MCP_PACKAGE}`,
    '--',
    'rdk-docs-mcp',
  ]);
  assert.equal(DEFAULT_RDK_DOCS_MCP_PACKAGE, 'rdk-docs-mcp@0.1.12');
  assert.deepEqual(resolveMcpClientTimeouts(config), {
    connectTimeoutMs: 45_000,
    requestTimeoutMs: 20_000,
  });
  assert.deepEqual(resolveMcpClientTimeouts({ name: 'other', transport: 'stdio' }), {
    connectTimeoutMs: 20_000,
    requestTimeoutMs: 120_000,
  });
  assert.equal(
    resolveMcpClientTimeouts(config, { connectTimeoutMs: 10_000 }).connectTimeoutMs,
    10_000
  );
});

test('no user mcp.json still injects rdk-docs when the session asks for it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-docs-empty-'));
  const loaded = loadMcpConfigs(tmp, tmp, {});
  assert.deepEqual(loaded, []);
  const merged = withBuiltinRdkDocs(loaded, true);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].command, 'npx');
  assert.deepEqual(merged[0].args, [
    '--yes',
    '--ignore-scripts',
    '--package=rdk-docs-mcp@0.1.12',
    '--',
    'rdk-docs-mcp',
  ]);
  assert.equal(fs.existsSync(path.join(tmp, 'mcp.json')), false);
  assert.equal(fs.existsSync(path.join(tmp, '.moss', 'mcp.json')), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('rdk-docs package accepts config/env npm specs and local paths', () => {
  assert.equal(resolveRdkDocsPackage(undefined, {}), DEFAULT_RDK_DOCS_MCP_PACKAGE);
  assert.equal(
    resolveRdkDocsPackage({ package: 'rdk-docs-mcp@github:D-Robotics/rdk-docs-mcp' }, {}),
    'rdk-docs-mcp@github:D-Robotics/rdk-docs-mcp'
  );
  assert.equal(
    resolveRdkDocsPackage(
      { package: 'rdk-docs-mcp@0.1.12' },
      { MOSS_RDK_DOCS_PACKAGE: '../rdk-docs-mcp.tgz' }
    ),
    '../rdk-docs-mcp.tgz'
  );
  assert.equal(readRdkDocsFlag({ enabled: false, package: '../server' }), false);
  assert.throws(() => resolveRdkDocsPackage({}, { MOSS_RDK_DOCS_PACKAGE: '--registry=evil' }));

  const local = withBuiltinRdkDocs([], true, '../rdk-docs-mcp');
  assert.equal(local[0].args[2], '--package=../rdk-docs-mcp');
});

test('opt-out and a missing device target leave the builtin out', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-docs-opt-'));
  const base = { rdkDocs: undefined, workspaceDir: tmp };
  assert.equal(hasDeviceTarget(tmp, {}), false);
  assert.equal(rdkDocsAutoConnectEnabled({ ...base, env: {} }), false);
  assert.equal(withBuiltinRdkDocs([], false).length, 0);

  assert.equal(rdkDocsAutoConnectEnabled({ ...base, env: { MOSS_DEVICE_HOST: '10.0.0.8' } }), true);
  fs.mkdirSync(path.join(tmp, '.moss'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.moss', 'devices.json'),
    JSON.stringify({ devices: [{ deviceId: 'rdk-01', kind: 'rdk', host: '10.0.0.9' }] })
  );
  assert.equal(rdkDocsAutoConnectEnabled({ ...base, env: {} }), true);

  for (const value of ['1', 'true', 'yes', 'on']) {
    assert.equal(
      rdkDocsOptOut({ MOSS_NO_RDK_DOCS: value }, true),
      true,
      `MOSS_NO_RDK_DOCS=${value} opts out`
    );
    assert.equal(
      rdkDocsAutoConnectEnabled({
        ...base,
        env: { MOSS_DEVICE_HOST: '10.0.0.8', MOSS_NO_RDK_DOCS: value },
        rdkDocs: true,
      }),
      false
    );
  }
  assert.equal(rdkDocsOptOut({ MOSS_NO_RDK_DOCS: '0' }, undefined), false);
  assert.equal(
    rdkDocsAutoConnectEnabled({
      ...base,
      env: { MOSS_DEVICE_HOST: '10.0.0.8' },
      rdkDocs: false,
    }),
    false
  );
  assert.equal(rdkDocsAutoConnectEnabled({ ...base, env: {}, rdkDocs: true }), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a same-named mcp.json entry replaces the builtin, including timeouts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-docs-user-'));
  const home = path.join(tmp, 'home');
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(ws, '.moss'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'rdk-docs': {
          transport: 'stdio',
          command: 'custom-rdk',
          args: ['--flag'],
          connectTimeoutMs: 5_000,
          requestTimeoutMs: 6_000,
        },
      },
    })
  );
  const loaded = loadMcpConfigs(ws, home, {});
  const merged = withBuiltinRdkDocs(loaded, true);
  const named = merged.filter((config) => config.name === 'rdk-docs');
  assert.equal(named.length, 1);
  assert.equal(named[0].command, 'custom-rdk');
  assert.deepEqual(named[0].args, ['--flag']);
  assert.equal(named[0].connectTimeoutMs, 5_000);
  assert.equal(named[0].requestTimeoutMs, 6_000);
  assert.equal(
    merged.some((config) => config.command === 'npx'),
    false
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('user rdkDocs:false wins over a project rdkDocs:true', () => {
  const merged = mergeConfigFiles({ rdkDocs: true }, { rdkDocs: false });
  assert.equal(merged.rdkDocs, false);
  const projectOnly = mergeConfigFiles({ rdkDocs: true }, {});
  assert.equal(projectOnly.rdkDocs, true);
  assert.deepEqual(
    mergeConfigFiles(
      { rdkDocs: { enabled: true, package: './project-server' } },
      { rdkDocs: { package: './user-server' } }
    ).rdkDocs,
    { enabled: true, package: './user-server' }
  );
});

test('a connected fixture adds the usage pointer and the skill index', async () => {
  const registered = new Map();
  const registry = await McpToolRegistry.connectAll(
    [
      {
        name: 'rdk-docs',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
      },
    ],
    { registerTool: (tool) => registered.set(tool.name, tool) }
  );
  try {
    const status = registry.getStatuses()[0];
    assert.equal(status.state, 'connected', status.error);
    assert.equal(status.toolCount, 4);
    const search = registry.getSearchTool('rdk-docs');
    const listed = await search.execute({}, {});
    for (const tool of ['list_manuals', 'search_docs', 'get_page', 'list_toc']) {
      assert.match(listed, new RegExp(tool));
    }
    const mcpLayer = buildMcpPromptLayer(registry);
    const knowledge = rdkDocsKnowledgeLayer(registry.getStatuses());
    const combined = `${mcpLayer}\n${knowledge}`;
    assert.match(combined, /mcp__rdk-docs__search/);
    assert.match(knowledge, /official-start/);
    assert.match(knowledge, /manual filter/);
    assert.equal(knowledge, RDK_DOCS_CONNECTED_LAYER);
    const skills = includeBundledRdkDocsSkill([], true);
    const skillLayer = buildSkillsPromptLayer(skills);
    assert.match(skillLayer, /^- rdk-docs:/m);
    const body = await createSkillTool(skills).execute({ name: 'rdk-docs' });
    assert.match(body, /mcp__rdk-docs__search/);
    assert.match(body, /official-start/);
    const concreteToolReferences =
      `${combined}\n${body}`.match(/mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g) ?? [];
    assert.deepEqual([...new Set(concreteToolReferences)], ['mcp__rdk-docs__search']);
    assert.ok(registry.getTools().some((tool) => tool.name === concreteToolReferences[0]));
    const userWins = includeBundledRdkDocsSkill(
      [{ name: 'rdk-docs', description: 'user skill', file: '/tmp/user/SKILL.md' }],
      true
    );
    assert.equal(userWins.length, 1);
    assert.equal(userWins[0].description, 'user skill');
  } finally {
    await registry.closeAll();
  }
});

test('background connection does not delay startup and search waits for readiness', async () => {
  const startedAt = performance.now();
  const registry = McpToolRegistry.connectInBackground([
    {
      name: 'rdk-docs',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture, '--delay-ms=250'],
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    },
  ]);
  try {
    assert.ok(performance.now() - startedAt < 100, 'registry creation must not await the server');
    assert.equal(registry.getStatuses()[0].state, 'connecting');
    assert.equal(registry.getTools()[0].name, 'mcp__rdk-docs__search');
    const listed = await registry.getTools()[0].execute({}, {});
    assert.match(listed, /mcp__rdk-docs__search_docs/);
    assert.equal(registry.getStatuses()[0].state, 'connected');
  } finally {
    await registry.closeAll();
  }
});

test('a failed rdk-docs connect does not throw and the prompt says unavailable', async () => {
  const registry = await McpToolRegistry.connectAll([
    {
      ...builtinRdkDocsServerConfig(),
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    },
  ]);
  try {
    const status = registry.getStatuses()[0];
    assert.equal(status.state, 'failed');
    assert.equal(registry.getTools().length, 0);
    const line = formatMcpStartupLine(status, 'normal');
    assert.match(
      line,
      /^\[mcp\] rdk-docs unreachable \(.+\) — RDK manual lookup is off this session\.$/
    );
    const knowledge = rdkDocsKnowledgeLayer(registry.getStatuses());
    assert.equal(knowledge, RDK_DOCS_UNAVAILABLE_LAYER);
    assert.doesNotMatch(knowledge, /mcp__rdk-docs__search/);
    assert.doesNotMatch(knowledge, /official-start/);
    assert.doesNotMatch(knowledge, /search_docs/);
    const skills = includeBundledRdkDocsSkill(
      [{ name: 'bench-repro', description: 'x', file: '/x' }],
      false
    );
    assert.equal(
      skills.some((skill) => skill.name === 'rdk-docs'),
      false
    );
    const other = formatMcpStartupLine(
      { name: 'formatter', state: 'failed', error: 'boom' },
      'quiet'
    );
    assert.match(other, /server "formatter" unavailable: boom/);
  } finally {
    await registry.closeAll();
  }
});

test('device safety rules, probes, and verified setup fallback stay', () => {
  assert.equal(deviceExecTool.metadata.sideEffectClass, 'device_mutation');
  assert.equal(deviceExecTool.metadata.planMode, 'requires_user_confirmation');
  assert.match(deviceExecTool.description, /Destructive or lockout-risk/);
  assert.match(deviceExecTool.description, /reboot\/shutdown/);
  assert.match(deviceExecTool.description, /flashing/);
  assert.match(deviceInfoTool.description, /MOSS_DEVICE_HOST/);
  assert.match(deviceInfoTool.description, /RDK board or Linux host/);
  assert.match(deviceCamerasTool.description, /\/sys\/class\/video4linux/);
  assert.match(deviceRoboticsStatusTool.description, /\/opt\/tros/);
  assert.match(deviceRoboticsStatusTool.description, /\/opt\/ros\/<distro>/);
  assert.match(deviceRoboticsStatusTool.description, /test -f \/opt\/tros\/setup\.bash/);
  assert.doesNotMatch(deviceRoboticsStatusTool.description, /\/opt\/tros\/humble\/setup\.bash/);
  assert.match(deviceRoboticsStatusTool.description, /TROS manual/);
  assert.match(ROBOTICS_PROBE_SCRIPT, /hbm_shell/);
  assert.match(ROBOTICS_PROBE_SCRIPT, /\/opt\/tros/);

  const hinted = appendShellContinueHint('device_exec', 'failed\n[exit code: 1]');
  assert.match(hinted, /ros2 pkg prefix/);
  assert.match(hinted, /dpkg -L/);
  assert.match(hinted, /device_file_list/);

  const fetchTool = createWebFetchTool();
  const focus = fetchTool.inputSchema.properties.focus.description;
  assert.doesNotMatch(focus, /BPU/);
  assert.match(focus, /architecture overview/);

  const skill = bundledRdkDocsSkill();
  const skillIndex = `- ${skill.name}: ${skill.description} (when: ${skill.when})`;
  const report = {
    note: 'tokens ≈ chars/4. System-prompt additions apply only while rdk-docs is connected.',
    connectedLayerTokensApprox: approxTokens(RDK_DOCS_CONNECTED_LAYER),
    skillIndexTokensApprox: approxTokens(skillIndex),
    systemPromptAddedTokensApprox:
      approxTokens(RDK_DOCS_CONNECTED_LAYER) + approxTokens(skillIndex),
    unavailableLayerTokensApprox: approxTokens(RDK_DOCS_UNAVAILABLE_LAYER),
    webFetchFocusDroppedTokensApprox: approxTokens(' BPU'),
  };
  assert.ok(report.connectedLayerTokensApprox < 220);
  assert.ok(report.unavailableLayerTokensApprox < 80);
});
