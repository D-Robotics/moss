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
import { pathToFileURL } from 'node:url';
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

// Isolate HOME: the shared skill-dir helper also scans ~/.claude/skills, and a
// developer machine has real skills there.
const home = path.join(tmp, 'home');
await fs.mkdir(home, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
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
  assert.equal(snapshot.schema, 'moss_capabilities.v1');
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

  // 2b. B289: `/capabilities` must use the same discovery scopes as the first
  // screen and /skills — it reported 0 user skills while the boot line said 19
  // because .agents/.claude conventions were missing from its own list.
  {
    const sharedSkill = path.join(ws, '.agents', 'skills', 'beta');
    await fs.mkdir(sharedSkill, { recursive: true });
    await fs.writeFile(
      path.join(sharedSkill, 'SKILL.md'),
      '---\nname: beta\ndescription: Does the beta thing\n---\n\nBody.\n',
      'utf8'
    );
    const shared = await cli(['capabilities', '--json']);
    assert.equal(shared.status, 0, shared.stderr);
    const sharedJson = JSON.parse(shared.stdout);
    assert.deepEqual(sharedJson.skills.names, ['alpha', 'beta']);
    assert.equal(sharedJson.skills.total, 2);
    await fs.rm(sharedSkill, { recursive: true, force: true });
  }
  ok('capabilities counts skills from the same scopes as /skills');

  // 2c. B290: many skills get a bounded preview, not a paragraph.
  {
    const manyRoot = path.join(ws, '.moss', 'skills');
    const created = [];
    for (let i = 0; i < 10; i += 1) {
      const dir = path.join(manyRoot, `many-${String(i).padStart(2, '0')}`);
      created.push(dir);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: many-${String(i).padStart(2, '0')}\ndescription: probe ${i}\n---\n\nBody.\n`,
        'utf8'
      );
    }
    const many = await cli(['capabilities', '--kind', 'skills']);
    assert.equal(many.status, 0, many.stderr);
    assert.match(many.stdout, /\+3 more/, '11 skills -> first 8 + "+3 more"');
    assert.ok(!many.stdout.includes('many-09, many-10'), 'the tail is not printed');
    for (const dir of created) await fs.rm(dir, { recursive: true, force: true });
  }
  ok('a long skill list is previewed instead of printed in full');

  // 2e. B314: auth/trust expose the same facts to scripts.
  {
    const auth = await cli(['auth', 'status', '--json']);
    assert.equal(auth.status, 0, auth.stderr);
    const authJson = JSON.parse(auth.stdout);
    assert.equal(authJson.schema, 'moss_auth_status.v1');
    assert.equal(typeof authJson.model, 'string');
    assert.ok(authJson.model.length > 0);
    assert.equal(authJson.apiKeyConfigured, false, 'the fixture has no api key');

    const trust = await cli(['trust', 'list', '--json']);
    assert.equal(trust.status, 0, trust.stderr);
    const trustJson = JSON.parse(trust.stdout);
    assert.equal(trustJson.schema, 'moss_trust_list.v1');
    assert.ok(
      trustJson.folders.includes(await fs.realpath(ws)),
      `trusted workspace missing from ${JSON.stringify(trustJson.folders)}`
    );
  }
  ok('auth status / trust list emit JSON for scripts');

  // 2f. B315: update/uninstall publish their plans; uninstall --json is read-only.
  {
    const update = await cli(['update', '--json']);
    assert.equal(update.status, 0, update.stderr);
    const updateJson = JSON.parse(update.stdout);
    assert.equal(updateJson.schema, 'moss_update.v1');
    assert.ok(Array.isArray(updateJson.commands) && updateJson.commands.length > 0);

    const uninstall = await cli(['uninstall', '--json']);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const uninstallJson = JSON.parse(uninstall.stdout);
    assert.equal(uninstallJson.schema, 'moss_uninstall.v1');
    assert.equal(uninstallJson.deletedConfig, false);
    assert.equal(uninstallJson.configDir, configDir);
    await fs.access(configDir);
  }
  ok('update/uninstall JSON plans are structured and uninstall is read-only');

  // 2g. B320: skill validate reports structurally too.
  {
    const valid = await cli(['skill', 'validate', 'alpha', '--json']);
    assert.equal(valid.status, 0, valid.stderr);
    const validJson = JSON.parse(valid.stdout);
    assert.equal(validJson.schema, 'moss_skill_validate.v1');
    assert.equal(validJson.ok, true);
    assert.equal(validJson.skill.name, 'alpha');

    const missing = await cli(['skill', 'validate', 'nope', '--json']);
    assert.equal(missing.status, 2);
    const missingJson = JSON.parse(missing.stdout);
    assert.equal(missingJson.ok, false);
    assert.equal(missingJson.error, 'not-found');
  }
  ok('skill validate --json reports valid and not-found structurally');

  // 2h. B324: a flag nobody can discover from --help is not shipped.
  for (const command of ['sessions', 'auth', 'trust', 'uninstall', 'doctor', 'update', 'skill']) {
    const help = await cli([command, '--help']);
    assert.match(
      `${help.stdout}${help.stderr}`,
      /--json/,
      `moss ${command} --help must mention --json`
    );
  }
  ok('every JSON-capable command documents --json in its help');

  // 2i. B347: the /usage cost hint must be actionable — `config set` has to
  // accept pricing.models.<model>.<field>, and the unpriced message must name it.
  {
    const set = await cli(['config', 'set', 'pricing.models.probe-model.input', '0.5']);
    assert.equal(set.status, 0, set.stderr);
    const setCurrency = await cli(['config', 'set', 'pricing.models.probe-model.currency', 'USD']);
    assert.equal(setCurrency.status, 0, setCurrency.stderr);
    const saved = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
    assert.equal(saved.pricing.models['probe-model'].input, 0.5);
    assert.equal(saved.pricing.models['probe-model'].currency, 'USD');

    const bad = await cli(['config', 'set', 'pricing.models.probe-model.input', 'abc']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /non-negative number/);

    const { unknownPriceMessage } = await import(
      pathToFileURL(path.join(root, 'dist/cli/model-pricing.js')).href
    );
    assert.match(
      unknownPriceMessage('probe-model', false),
      /moss config set pricing\.models\.probe-model\.input/
    );
    assert.match(
      unknownPriceMessage('probe-model', true),
      /moss config set pricing\.models\.probe-model\.input/
    );
  }
  ok('pricing config set is real and the /usage hint names it');

  // 2d. B291: with the builtin rdk-docs auto-connected, /capabilities and
  // `mcp list` must name the same servers (they used different resolvers).
  {
    const rdkEnv = { ...env, MOSS_DEVICE_HOST: 'probe-host' };
    delete rdkEnv.MOSS_NO_RDK_DOCS;
    const cap = await captureProcess(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'capabilities', '--json'],
      { cwd: ws, env: rdkEnv, timeoutMs: 60_000 }
    );
    assert.equal(cap.status, 0, cap.stderr);
    const capJson = JSON.parse(cap.stdout);
    const mcpList = await captureProcess(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'mcp', 'list', '--json'],
      { cwd: ws, env: rdkEnv, timeoutMs: 60_000 }
    );
    assert.equal(mcpList.status, 0, mcpList.stderr);
    const listJson = JSON.parse(mcpList.stdout);
    assert.deepEqual(
      [...capJson.mcp.names].sort(),
      listJson.servers.map((server) => server.name).sort(),
      'capabilities and mcp list must resolve the builtin the same way'
    );
    assert.ok(capJson.mcp.names.includes('rdk-docs'), 'the builtin is part of the session');
  }
  ok('capabilities and mcp list resolve the builtin rdk-docs identically');

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
  // B278: `mcp list --json` / `device list --json` are the scriptable view of
  // the same two sections this command summarizes.
  await fs.writeFile(
    path.join(ws, '.moss', 'mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['-e', 'process.exit(0)'] } } }),
    'utf8'
  );
  const jsonEnv = {
    ...process.env,
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_TUI: '1',
    MOSS_NO_RDK_DOCS: '1',
    MOSS_LANG: 'en',
    MOSS_TRUST_WORKSPACE: '1',
    MOSS_DEVICE_HOST: '',
  };
  const mcpJson = await captureProcess(
    process.execPath,
    [path.join(root, 'dist/cli.js'), 'mcp', 'list', '--json'],
    { cwd: ws, env: jsonEnv, timeoutMs: 30_000 }
  );
  assert.equal(mcpJson.status, 0, mcpJson.stderr);
  const mcp = JSON.parse(mcpJson.stdout);
  assert.equal(mcp.schema, 'moss_mcp_list.v1');
  // User scope (`configDir/mcp.json`, "local") and project scope both merge.
  assert.deepEqual(mcp.servers.map((server) => server.name).sort(), ['echo', 'local']);
  assert.equal(mcp.servers.find((server) => server.name === 'echo').command, 'node');

  const add = await captureProcess(
    process.execPath,
    [path.join(root, 'dist/cli.js'), 'device', 'add', 'sim1', '10.0.0.5', '--user', 'ubuntu'],
    { cwd: ws, env: jsonEnv, timeoutMs: 30_000 }
  );
  assert.equal(add.status, 0, add.stderr);
  const devJson = await captureProcess(
    process.execPath,
    [path.join(root, 'dist/cli.js'), 'device', 'list', '--json'],
    { cwd: ws, env: jsonEnv, timeoutMs: 30_000 }
  );
  assert.equal(devJson.status, 0, devJson.stderr);
  const devices = JSON.parse(devJson.stdout);
  assert.equal(devices.schema, 'moss_devices_list.v1');
  assert.equal(devices.env, null);
  // The probe's existing registry entry (rdk-01) stays; the new one is added.
  assert.deepEqual(
    devices.devices.map((device) => `${device.id}:${device.user}@${device.host}`).sort(),
    ['rdk-01:root@192.168.1.10', 'sim1:ubuntu@10.0.0.5']
  );
  ok('mcp/device list --json give scripts the same registries');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[capabilities] ${checks}/${checks} checks passed`);
