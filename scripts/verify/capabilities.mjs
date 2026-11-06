#!/usr/bin/env node
/**
 * `moss capabilities` probe (offline, B133).
 *
 * One screen for the capability surface: tools, built-in slash commands, skills,
 * custom commands, sub-agents, hooks, MCP servers and devices. It aggregates the
 * existing registries (no new storage) and must work with NO model configuration,
 * so a fresh machine can answer "what can this install do".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[capabilities] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-capabilities-'));
const ws = path.join(tmp, 'ws');
const configDir = path.join(tmp, 'config');
await fs.mkdir(path.join(ws, '.git'), { recursive: true });
await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
await fs.mkdir(path.join(ws, '.moss', 'skills', 'alpha'), { recursive: true });
await fs.mkdir(path.join(ws, '.moss', 'commands'), { recursive: true });
await fs.mkdir(path.join(ws, '.moss', 'agents'), { recursive: true });
await fs.mkdir(configDir, { recursive: true });

await fs.writeFile(
  path.join(ws, '.moss', 'skills', 'alpha', 'SKILL.md'),
  '---\nname: alpha\ndescription: Does the alpha thing\n---\n\nFollow these steps.\n',
  'utf8'
);
await fs.writeFile(path.join(ws, '.moss', 'commands', 'deploy.md'), 'Deploy the thing.\n', 'utf8');
await fs.writeFile(
  path.join(ws, '.moss', 'agents', 'auditor.md'),
  '---\nname: auditor\ndescription: Reads code and reports\n---\n\nYou audit code.\n',
  'utf8'
);
await fs.writeFile(
  path.join(ws, '.moss', 'devices.json'),
  `${JSON.stringify(
    {
      version: 1,
      devices: [{ deviceId: 'rdk-01', host: '192.168.1.10', kind: 'rdk', user: 'root' }],
    },
    null,
    2
  )}\n`,
  'utf8'
);
await fs.writeFile(
  path.join(configDir, 'config.json'),
  `${JSON.stringify({ hooks: { PreToolUse: [{ command: 'true' }] } }, null, 2)}\n`,
  'utf8'
);
// Project agents load only in a trusted folder; trust the fixture workspace the
// same way `moss --trust-workspace` persists it.
await fs.writeFile(
  path.join(configDir, 'workspace-trust.json'),
  `${JSON.stringify({ [await fs.realpath(ws)]: true }, null, 2)}\n`,
  'utf8'
);
await fs.writeFile(
  path.join(configDir, 'mcp.json'),
  `${JSON.stringify({ mcpServers: { local: { command: 'node', args: ['-e', ''] } } }, null, 2)}\n`,
  'utf8'
);

const env = {
  ...process.env,
  MOSS_CONFIG_DIR: configDir,
  MOSS_NO_RDK_DOCS: '1',
  MOSS_NO_TUI: '1',
  MOSS_LANG: 'en',
};
const cli = (args) =>
  captureProcess(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
    cwd: ws,
    env,
    timeoutMs: 60_000,
  });

try {
  // 1. The JSON view aggregates every registry, with no model config present.
  const json = await cli(['capabilities', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const snapshot = JSON.parse(json.stdout);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.surfaces.length, 4);
  assert.ok(snapshot.tools.total >= 40, `tools ${snapshot.tools.total}`);
  assert.ok(snapshot.tools.device >= 10, `device tools ${snapshot.tools.device}`);
  assert.ok(snapshot.slashCommands.builtin >= 20, `slash ${snapshot.slashCommands.builtin}`);
  assert.deepEqual(snapshot.skills.names, ['alpha']);
  assert.equal(snapshot.skills.workspace, 1);
  assert.deepEqual(snapshot.commands.names, ['deploy']);
  assert.deepEqual(snapshot.agents.names, ['auditor']);
  assert.deepEqual(snapshot.devices.ids, ['rdk-01']);
  assert.deepEqual(snapshot.mcp.names, ['local']);
  assert.ok(snapshot.hooks.total >= 1, 'hook count');
  assert.equal(snapshot.hooks.events.PreToolUse, 1);
  assert.match(snapshot.runtime.node, /^\d+\./);
  assert.equal(snapshot.runtime.workspace, await fs.realpath(ws));
  ok('the JSON view reports tools, skills, commands, agents, hooks, MCP and devices');

  // 2. The human view names the workspace-owned capabilities.
  const human = await cli(['capabilities']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /moss \d+\.\d+\.\d+/);
  assert.match(human.stdout, /tools: \d+ built-in \(\d+ device\)/);
  assert.match(human.stdout, /skills: 1 \(workspace 1 · user 0\) — alpha/);
  assert.match(human.stdout, /custom commands: 1 — \/deploy/);
  assert.match(human.stdout, /sub-agents: 1 — auditor/);
  assert.match(human.stdout, /MCP: 1 — local/);
  assert.match(human.stdout, /devices: 1 — rdk-01/);
  ok('the human view names skills, commands, agents, MCP servers and devices');

  // 3. A minimal workspace still answers instead of erroring.
  const empty = path.join(tmp, 'empty');
  await fs.mkdir(empty, { recursive: true });
  const bare = await captureProcess(
    process.execPath,
    [path.join(root, 'dist', 'cli.js'), 'capabilities', '--json'],
    {
      cwd: empty,
      env: { ...env, MOSS_CONFIG_DIR: path.join(tmp, 'empty-config') },
      timeoutMs: 60_000,
    }
  );
  assert.equal(bare.status, 0, bare.stderr);
  const bareJson = JSON.parse(bare.stdout);
  assert.deepEqual(bareJson.skills.names, []);
  assert.deepEqual(bareJson.devices.ids, []);
  ok('a bare workspace reports zeros without failing');

  // 4. --help and bad arguments behave like every other subcommand.
  const help = await cli(['capabilities', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /moss capabilities \[--json\]/);
  const bad = await cli(['capabilities', '--bogus']);
  assert.equal(bad.status, 2, 'unknown flag must exit 2');
  assert.match(bad.stderr, /unknown argument --bogus/);
  ok('--help prints usage and an unknown flag exits 2');

  // 4b. B153: --kind narrows the text view and rejects bad combinations.
  const skillsOnly = await cli(['capabilities', '--kind', 'skills']);
  assert.equal(skillsOnly.status, 0, skillsOnly.stderr);
  assert.match(skillsOnly.stdout, /skills: 1 .*alpha/);
  assert.ok(!skillsOnly.stdout.includes('devices:'), 'only the skills block should print');
  assert.ok(!skillsOnly.stdout.includes('workspace:'), 'the head block is omitted for a section');
  const toolsKind = await cli(['capabilities', '--kind=tools']);
  assert.equal(toolsKind.status, 0, toolsKind.stderr);
  assert.match(toolsKind.stdout, /^tools: \d+ built-in/);
  assert.ok(!toolsKind.stdout.includes('skills:'));
  const runtimeKind = await cli(['capabilities', '--kind', 'runtime']);
  assert.match(runtimeKind.stdout, /surfaces: .*repl/);
  assert.match(runtimeKind.stdout, /workspace: /);
  const badKind = await cli(['capabilities', '--kind', 'nope']);
  assert.equal(badKind.status, 2);
  assert.match(badKind.stderr, /unknown --kind nope; use runtime, tools/);
  const jsonKind = await cli(['capabilities', '--kind', 'skills', '--json']);
  assert.equal(jsonKind.status, 2, '--json already carries every section');
  assert.match(jsonKind.stderr, /--kind narrows the text view/);
  const kindHelp = await cli(['capabilities', '--help']);
  assert.match(kindHelp.stdout, /runtime \| tools \| skills/);
  ok('--kind narrows to one section and rejects unknown/JSON combinations with 2');

  // 5. It is reachable from the full help surface (not a hidden command).
  const full = await cli(['--help', '--all']);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /capabilities\s+one screen: tools, skills, commands/);
  ok('the command is listed in `moss --help --all`');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[capabilities] ${checks}/${checks} checks passed`);
