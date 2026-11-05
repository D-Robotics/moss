#!/usr/bin/env node
/**
 * D1 capability-pack probe — validate / install / list / remove a local pack
 * with a skill, a command, a sub-agent, a hook and an MCP server.
 *
 * Deterministic: no model call; every assertion is a file, an exit code or a
 * parsed JSON field.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist/cli.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-plugins-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-plugins-home-'));
const pack = path.join(workspace, 'packs/rdk-demo');

const write = (relative, content) => {
  const file = path.join(pack, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
write(
  'plugin.json',
  JSON.stringify(
    {
      name: 'rdk-demo',
      version: '0.1.0',
      description: 'Demo RDK capability pack',
      skills: ['skills'],
      commands: ['commands'],
      agents: ['agents'],
      hooks: 'hooks.json',
      mcp: 'mcp.json',
    },
    null,
    2
  )
);
write(
  'skills/x5-deploy/SKILL.md',
  '---\nname: x5-deploy\ndescription: Deploy a model to an RDK X5\n---\nDeploy steps.\n'
);
write('skills/x5-deploy/references/pins.md', 'pin table\n');
write('commands/deploy.md', 'Deploy the current model to $ARGUMENTS.\n');
write(
  'agents/verifier.md',
  '---\nname: verifier\ndescription: Verify a deployment\n---\nYou verify.\n'
);
write(
  'hooks.json',
  JSON.stringify({ PreToolUse: [{ matcher: 'exec', command: 'node -e "process.exit(0)"' }] })
);
write(
  'mcp.json',
  JSON.stringify({ mcpServers: { 'demo-server': { command: 'node', args: ['demo.mjs'] } } })
);

const env = {
  ...process.env,
  HOME: home,
  MOSS_NO_RDK_DOCS: '1',
  MOSS_LANG: 'en',
  MOSS_NO_TUI: '1',
};
const run = (args, cwd = workspace) =>
  captureProcess(process.execPath, [cli, ...args], { cwd, env, timeoutMs: 60_000 });
const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

await check('validate reports the pack as valid with every component', async () => {
  const result = await run(['plugins', 'validate', 'packs/rdk-demo', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.manifest.name, 'rdk-demo');
  assert.equal(payload.manifest.version, '0.1.0');
  assert.deepEqual(payload.files.map((file) => file.from).sort(), [
    'agents/verifier.md',
    'commands/deploy.md',
    'skills/x5-deploy/SKILL.md',
    'skills/x5-deploy/references/pins.md',
  ]);
  assert.equal(payload.hooks.length, 1);
  assert.deepEqual(payload.mcpServers, ['demo-server']);
});

await check('an invalid pack exits non-zero and lists its errors', async () => {
  const bad = path.join(workspace, 'packs/bad');
  fs.mkdirSync(path.join(bad, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(bad, 'plugin.json'),
    JSON.stringify({ name: 'BAD NAME', version: 'x', skills: ['missing'] })
  );
  const result = await run(['plugins', 'validate', 'packs/bad']);
  assert.equal(result.status, 1, result.stderr);
  const text = `${result.stdout}${result.stderr}`;
  assert.match(text, /name must be lowercase/);
  assert.match(text, /version must be semver/);
  assert.match(text, /does not exist/);
});

await check('a non-interactive install without --yes is refused and writes nothing', async () => {
  const result = await run(['plugins', 'install', 'packs/rdk-demo']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(`${result.stdout}${result.stderr}`, /--yes/);
  assert.equal(fs.existsSync(path.join(workspace, '.moss', 'skills')), false);
});

await check('install copies assets and merges hooks + MCP', async () => {
  const result = await run(['plugins', 'install', 'packs/rdk-demo', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  for (const relative of [
    '.moss/skills/x5-deploy/SKILL.md',
    '.moss/skills/x5-deploy/references/pins.md',
    '.moss/commands/deploy.md',
    '.moss/agents/verifier.md',
    '.moss/plugins/rdk-demo/installed.json',
  ]) {
    assert.equal(fs.existsSync(path.join(workspace, relative)), true, relative);
  }
  const config = JSON.parse(fs.readFileSync(path.join(workspace, '.moss', 'config.json'), 'utf8'));
  assert.equal(config.hooks.PreToolUse.length, 1);
  const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.moss', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['demo-server']);
});

await check('the installed assets are discoverable by the real loaders', async () => {
  const skills = await run(['skill', 'list', '--json']);
  assert.match(`${skills.stdout}${skills.stderr}`, /x5-deploy/);
  const mcp = await run(['mcp', 'list']);
  assert.match(`${mcp.stdout}${mcp.stderr}`, /demo-server/);
  const { loadAgentFiles } = await import(
    new URL(`file://${path.join(root, 'dist/core/subagent/agent-file-loader.js')}`).href
  );
  const loaded = loadAgentFiles({ workspaceDir: workspace, projectTrust: { trusted: true } });
  assert.ok(
    loaded.agents.some((agent) => String(agent.id).includes('verifier')),
    JSON.stringify(loaded.notices)
  );
});

await check('list --json reports installed packs and file drift', async () => {
  const result = await run(['plugins', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, 'moss_plugins.v1');
  const [plugin] = payload.plugins;
  assert.equal(plugin.name, 'rdk-demo');
  assert.equal(plugin.files.length, 4);
  assert.deepEqual(plugin.drift, { changed: [], missing: [] });
  fs.appendFileSync(path.join(workspace, '.moss/skills/x5-deploy/SKILL.md'), '\nlocal edit\n');
  const drifted = JSON.parse((await run(['plugins', 'list', '--json'])).stdout);
  assert.deepEqual(drifted.plugins[0].drift.changed, ['.moss/skills/x5-deploy/SKILL.md']);
});

await check('a conflicting MCP server blocks install unless --force', async () => {
  // Undo the deliberate local edit above so only the MCP conflict is in play.
  fs.writeFileSync(
    path.join(workspace, '.moss/skills/x5-deploy/SKILL.md'),
    '---\nname: x5-deploy\ndescription: Deploy a model to an RDK X5\n---\nDeploy steps.\n'
  );
  fs.mkdirSync(path.join(workspace, '.moss'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.moss', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'demo-server': { command: 'other' } } })
  );
  const blocked = await run(['plugins', 'install', 'packs/rdk-demo', '--yes']);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /already configured differently/);
  const forced = await run(['plugins', 'install', 'packs/rdk-demo', '--yes', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.moss', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers['demo-server'], { command: 'node', args: ['demo.mjs'] });
});

await check('remove takes back only unedited files and cleans hooks + MCP', async () => {
  fs.appendFileSync(path.join(workspace, '.moss/skills/x5-deploy/SKILL.md'), '\nlocal edit\n');
  const result = await run(['plugins', 'remove', 'rdk-demo', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(workspace, '.moss/plugins/rdk-demo')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.moss/commands/deploy.md')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.moss/agents/verifier.md')), false);
  // The locally edited skill file stays, with a warning instead of a silent delete.
  assert.equal(fs.existsSync(path.join(workspace, '.moss/skills/x5-deploy/SKILL.md')), true);
  assert.match(`${result.stdout}${result.stderr}`, /kept locally edited file/);
  const config = JSON.parse(fs.readFileSync(path.join(workspace, '.moss', 'config.json'), 'utf8'));
  assert.equal((config.hooks.PreToolUse ?? []).length, 0);
  const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.moss', 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['demo-server'], undefined);
});

for (const line of checks) console.log(`[plugins] ${line}`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[plugins] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[plugins] ${checks.length} checks passed`);
