#!/usr/bin/env node
/**
 * Workspace trust: project hooks, MCP, write agents, plugins, and status lines.
 * Headless -p skips them. A project .env cannot grant trust or move config.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  envBeforeDotenv,
  loadEnvFile,
  mergeConfigFiles,
  resolveConfigDir,
  resolveProjectConfigPath,
} from '../dist/cli/config.js';
import { loadMcpConfigs } from '../dist/cli/mcp-config.js';
import { withBuiltinRdkDocs } from '../dist/cli/rdk-docs-mcp.js';
import { DEFAULT_RDK_DOCS_MCP_PACKAGE } from '../dist/core/mcp/rdk-docs.js';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';
import { loadAgentFiles } from '../dist/core/subagent/agent-file-loader.js';
import {
  listProjectTrustItems,
  resolveProjectCapabilities,
  summarizeTrustItems,
  trustQuestion,
  untrustedWorkspaceLine,
} from '../dist/cli/workspace-trust.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'moss-trust-'));
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function agent(dir, name, tools) {
  put(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name}\ntools: ${tools}\n---\n${name}.\n`
  );
}
function cap(overrides) {
  return resolveProjectCapabilities({
    interactive: false,
    headlessUntrusted: true,
    trustFlag: false,
    env: {},
    zh: false,
    ...overrides,
  });
}
function session(dir, configDir, extra = {}) {
  const projectConfigPath = path.join(dir, '.moss', 'config.json');
  return cap({
    workspaceDir: dir,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    ...(fs.existsSync(projectConfigPath) ? { projectConfigPath } : {}),
    ...extra,
  });
}
const names = (servers) => servers.map((server) => server.name);
const httpSecret = 'project-http-secret-value';

assert.match(trustQuestion('project hooks (1)', false), /Trust this workspace/);
assert.match(trustQuestion('project hooks (1)', true), /信任此工作区/);
assert.match(untrustedWorkspaceLine('stdio MCP (warehouse)', false), /--trust-workspace/);
assert.match(untrustedWorkspaceLine('stdio MCP (warehouse)', false), /MOSS_TRUST_WORKSPACE=1/);
assert.match(untrustedWorkspaceLine('stdio MCP (warehouse)', true), /工作区未信任/);
assert.equal(
  summarizeTrustItems(
    listProjectTrustItems({
      workspaceDir: '/ws',
      projectHooks: { Stop: [{ command: 'true' }], SessionEnd: [{ command: 'true' }] },
      projectMcp: [
        { name: 'warehouse', transport: 'stdio' },
        { name: 'docs', transport: 'http' },
      ],
      statusCommand: true,
    })
  ),
  'project hooks (2), status line, stdio MCP (warehouse), HTTP MCP (docs)'
);

{
  const root = tempRoot();
  const ws = path.join(root, 'ws');
  const configDir = path.join(root, 'cfg');
  agent(path.join(ws, '.moss', 'agents'), 'reviewer', 'Read, Bash');
  agent(path.join(ws, '.moss', 'agents'), 'reader', 'Read, Grep');
  put(path.join(ws, '.moss', 'plugins', 'demo', 'plugin.json'), { name: 'demo-plugin' });
  put(path.join(ws, '.moss', 'config.json'), {
    hooks: { Stop: [{ command: 'echo project-stop' }], Notification: [{ command: 'echo ping' }] },
  });
  put(path.join(ws, '.moss', 'mcp.json'), {
    mcpServers: {
      warehouse: { transport: 'stdio', command: 'warehouse-mcp' },
      docs: {
        transport: 'http',
        url: 'http://127.0.0.1:9/${PROJECT_HTTP_SECRET}/mcp',
        headers: { Authorization: 'Bearer ${PROJECT_HTTP_SECRET}' },
      },
    },
  });
  put(path.join(configDir, 'config.json'), {
    hooks: { SessionStart: [{ command: 'echo user-start' }] },
  });
  put(path.join(configDir, 'mcp.json'), {
    mcpServers: { usertool: { transport: 'stdio', command: 'user-mcp' } },
  });
  const skipped = await session(ws, configDir);
  assert.equal(skipped.trusted, false);
  assert.deepEqual(
    skipped.hooks.SessionStart.map((hook) => hook.command),
    ['echo user-start']
  );
  assert.equal(skipped.hooks.Stop, undefined);
  for (const part of [
    /project hooks \(2\)/,
    /warehouse/,
    /HTTP MCP \(docs\)/,
    /reviewer/,
    /demo-plugin/,
    /--trust-workspace/,
  ]) {
    assert.match(skipped.notice, part);
  }
  assert.doesNotMatch(skipped.notice, /reader/);
  const loaded = loadMcpConfigs(
    ws,
    configDir,
    { PROJECT_HTTP_SECRET: httpSecret },
    undefined,
    skipped.mcp
  );
  assert.deepEqual(names(loaded), ['usertool']);
  assert.equal(JSON.stringify(loaded).includes(httpSecret), false);

  const flagged = await session(ws, configDir, { trustFlag: true });
  assert.equal(flagged.trusted, true);
  assert.equal(flagged.notice, undefined);
  assert.equal(flagged.hooks.Stop[0].command, 'echo project-stop');
  assert.equal(flagged.hooks.Notification[0].command, 'echo ping');
  const trustedMcp = loadMcpConfigs(
    ws,
    configDir,
    { PROJECT_HTTP_SECRET: httpSecret },
    undefined,
    flagged.mcp
  );
  assert.ok(names(trustedMcp).includes('warehouse'));
  const docs = trustedMcp.find((server) => server.name === 'docs');
  assert.equal(docs.transport, 'http');
  assert.match(docs.url, new RegExp(httpSecret));
  assert.equal(docs.headers.Authorization, `Bearer ${httpSecret}`);

  const other = path.join(root, 'other');
  put(path.join(other, '.moss', 'config.json'), {
    hooks: { SessionEnd: [{ command: 'echo end' }] },
  });
  const envTrusted = await session(other, configDir, {
    env: { MOSS_TRUST_WORKSPACE: '1' },
    zh: true,
  });
  assert.equal(envTrusted.trusted, true);
  assert.equal(envTrusted.hooks.SessionEnd[0].command, 'echo end');

  const asked = path.join(root, 'asked');
  put(path.join(asked, '.moss', 'config.json'), {
    hooks: { SubagentStop: [{ command: 'echo sub' }] },
  });
  let prompts = 0;
  const declined = await session(asked, configDir, {
    interactive: true,
    headlessUntrusted: false,
    ask: async (question) => {
      prompts += 1;
      assert.match(question, /project hooks/);
      return false;
    },
  });
  assert.equal(prompts, 1);
  assert.equal(declined.trusted, false);
  assert.equal(declined.hooks.SubagentStop, undefined);
  const remembered = await session(asked, configDir, {
    interactive: true,
    headlessUntrusted: false,
    ask: async () => {
      throw new Error('remembered no must not ask again');
    },
  });
  assert.equal(remembered.trusted, false);

  const taskRun = path.join(root, 'task');
  put(path.join(taskRun, '.moss', 'config.json'), {
    hooks: { PreCompact: [{ command: 'echo compact' }] },
  });
  const kept = await session(taskRun, path.join(root, 'fresh-cfg'), { headlessUntrusted: false });
  assert.equal(kept.trusted, true);
  assert.equal(kept.hooks.PreCompact[0].command, 'echo compact');
}

{
  const root = tempRoot();
  const home = path.join(root, 'home');
  const ws = path.join(home, 'empty-project');
  const configDir = path.join(home, '.config', 'moss');
  fs.mkdirSync(ws, { recursive: true });
  put(path.join(home, '.moss', 'config.json'), {
    hooks: { SessionStart: [{ command: 'echo home-moss' }] },
  });
  put(path.join(home, '.moss', 'mcp.json'), {
    mcpServers: { homedocs: { transport: 'stdio', command: 'home-mcp' } },
  });
  agent(path.join(home, '.moss', 'agents'), 'writer', 'Bash');
  put(path.join(configDir, 'config.json'), {
    rdkDocs: true,
    hooks: { Notification: [{ command: 'echo user-notify' }] },
  });
  put(path.join(configDir, 'mcp.json'), {
    mcpServers: { usertool: { transport: 'stdio', command: 'user-mcp' } },
  });
  const env = { HOME: home };
  const projectConfigPath = resolveProjectConfigPath(ws);
  assert.equal(projectConfigPath, path.join(home, '.moss', 'config.json'));
  let prompts = 0;
  const ask = async () => {
    prompts += 1;
    return false;
  };
  const interactive = { interactive: true, headlessUntrusted: false, env, ask };
  const fresh = await session(ws, configDir, { ...interactive, projectConfigPath });
  assert.equal(prompts, 0);
  assert.equal(fresh.trusted, true);
  assert.equal(fresh.notice, undefined);
  assert.equal(fresh.hooks.SessionStart[0].command, 'echo home-moss');
  assert.equal(fresh.hooks.Notification[0].command, 'echo user-notify');
  const packageDir = path.join(root, 'rdk-docs-mcp');
  const marker = path.join(root, 'rdk-started');
  put(path.join(packageDir, 'package.json'), {
    name: 'rdk-docs-mcp',
    version: '0.0.0',
    bin: { 'rdk-docs-mcp': './fail.mjs' },
  });
  put(
    path.join(packageDir, 'fail.mjs'),
    `#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');process.exit(1);\n`
  );
  fs.chmodSync(path.join(packageDir, 'fail.mjs'), 0o755);
  const configs = withBuiltinRdkDocs(
    loadMcpConfigs(ws, configDir, env, undefined, fresh.mcp),
    true,
    packageDir
  );
  assert.ok(names(configs).includes('usertool'));
  assert.equal(names(configs).includes('homedocs'), false);
  const rdk = configs.find((server) => server.name === 'rdk-docs');
  assert.equal(rdk.command, 'npx');
  const registry = McpToolRegistry.connectInBackground([rdk]);
  await registry.waitForConnections();
  assert.equal(registry.getStatuses().find((entry) => entry.name === 'rdk-docs')?.state, 'failed');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'started');
  await registry.closeAll();
  const atHome = await session(home, configDir, interactive);
  assert.equal(prompts, 0);
  const homeLoaded = names(loadMcpConfigs(home, configDir, env, undefined, atHome.mcp));
  assert.ok(homeLoaded.includes('homedocs') && homeLoaded.includes('usertool'));
}

{
  const root = tempRoot();
  const configDir = path.join(root, 'cfg');
  const home = path.join(root, 'home');
  put(path.join(configDir, 'config.json'), {});
  const ws = path.join(root, 'proj');
  const stdio = (command) => ({ transport: 'stdio', command });
  put(path.join(ws, '.moss', 'mcp.json'), {
    mcpServers: { warehouse: stdio('warehouse-mcp'), 'rdk-docs': stdio('python') },
  });
  const questions = [];
  const ask = async (question) => {
    questions.push(question);
    return false;
  };
  const interactive = { interactive: true, headlessUntrusted: false, env: { HOME: home } };
  const asked = await session(ws, configDir, { ...interactive, ask });
  assert.match(questions[0], /stdio MCP \(warehouse, rdk-docs\)/);
  assert.match(asked.notice, /warehouse/);
  assert.match(asked.notice, /rdk-docs/);
  assert.equal(asked.trusted, false);
  const again = await session(ws, configDir, {
    ...interactive,
    ask: async () => {
      throw new Error('a project stdio server asks only once');
    },
  });
  assert.equal(again.trusted, false);
  const only = path.join(root, 'only-rdk');
  put(path.join(only, '.moss', 'mcp.json'), { mcpServers: { 'rdk-docs': stdio('python') } });
  const quiet = await session(only, configDir, { ...interactive, ask });
  assert.match(questions.at(-1), /rdk-docs/);
  assert.match(quiet.notice, /rdk-docs/);
  assert.equal(quiet.trusted, false);
  const still = loadMcpConfigs(only, configDir, {}, undefined, quiet.mcp);
  assert.equal(names(still).includes('rdk-docs'), false);
  const injected = withBuiltinRdkDocs(still, true);
  assert.equal(injected[0].name, 'rdk-docs');
  assert.equal(injected[0].command, 'npx');
  assert.equal(injected[0].args[2], `--package=${DEFAULT_RDK_DOCS_MCP_PACKAGE}`);
}

{
  const root = tempRoot();
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'cfg');
  put(path.join(configDir, 'config.json'), {});
  const cases = [
    ['with-settings', [false], true, false, ['reader'], 'claude', 1, true],
    ['agents-only', [false], true, false, [], 'claude', 1, false],
    ['agents-yes', [true, false], false, true, [], 'workspace', 2, false],
  ];
  for (const [name, answers, trusted, claudeOptIn, ids, reason, questions, settings] of cases) {
    const dir = path.join(root, name);
    if (settings) {
      put(path.join(dir, '.claude', 'settings.json'), {
        hooks: { Stop: [{ command: 'echo claude-stop' }] },
      });
    }
    if (ids.includes('reader')) agent(path.join(dir, '.moss', 'agents'), 'reader', 'Read');
    agent(path.join(dir, '.claude', 'agents'), 'writer', 'Bash');
    const seen = [];
    const result = await session(dir, configDir, {
      interactive: true,
      headlessUntrusted: false,
      env: { HOME: home },
      ask: async (question) => {
        seen.push(question);
        return answers[seen.length - 1];
      },
    });
    assert.equal(seen.length, questions, name);
    assert.match(seen[0], /Claude config/);
    if (questions === 2) assert.match(seen[1], /writer/);
    assert.equal(result.trusted, trusted);
    assert.equal(result.claudeOptIn, claudeOptIn);
    if (trusted) assert.equal(result.notice, undefined);
    const loaded = loadAgentFiles({
      workspaceDir: dir,
      homeDir: home,
      projectTrust: { trusted: result.trusted, claudeOptIn: result.claudeOptIn },
    });
    assert.deepEqual(
      loaded.agents.map((entry) => entry.id),
      ids
    );
    const blocked = loaded.notices
      .map((line) => JSON.parse(line))
      .find((entry) => entry.code === 'trust-blocked');
    assert.equal(blocked.id, 'writer');
    assert.equal(blocked.reason, reason);
  }
}

{
  const root = tempRoot();
  const ignored = [
    'MOSS_TRUST_WORKSPACE',
    'MOSS_CONFIG_DIR',
    'MOSS_CONFIG_FILE',
    'MOSS_CONFIG_PATH',
    'MOSS_RDK_DOCS_PACKAGE',
    'XDG_CONFIG_HOME',
    'HOME',
    'APPDATA',
    'USERPROFILE',
  ];
  put(
    path.join(root, '.env'),
    [...ignored.map((key) => `${key}=forged`), 'EXAMPLE_FROM_DOTENV=kept'].join('\n')
  );
  const saved = Object.fromEntries(
    ignored.concat('EXAMPLE_FROM_DOTENV').map((key) => [key, process.env[key]])
  );
  for (const key of ignored.concat('EXAMPLE_FROM_DOTENV')) delete process.env[key];
  try {
    loadEnvFile(path.join(root, '.env'));
    for (const key of ignored) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.EXAMPLE_FROM_DOTENV, 'kept');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const merged = mergeConfigFiles(
    { rdkDocs: { package: '/tmp/evil-rdk', enabled: true }, statusLine: { command: 'echo pwned' } },
    {}
  );
  assert.equal(merged.rdkDocs?.package, undefined);
  assert.equal(merged.rdkDocs?.enabled, true);
  assert.equal(merged.statusLine?.command, undefined);
  const allowed = mergeConfigFiles(
    { statusLine: { command: 'echo ok' } },
    {},
    { allowProjectStatusCommand: true }
  );
  assert.equal(allowed.statusLine.command, 'echo ok');
  const userPackage = mergeConfigFiles(
    { rdkDocs: { package: '/tmp/evil-rdk' } },
    { rdkDocs: { package: 'rdk-docs-mcp@0.2.0' } }
  );
  assert.equal(userPackage.rdkDocs.package, 'rdk-docs-mcp@0.2.0');
}

{
  const redirects = [
    ['XDG_CONFIG_HOME', 'linux', (dir) => path.join(dir, 'moss')],
    ['HOME', 'linux', (dir) => path.join(dir, '.config', 'moss')],
    ['APPDATA', 'win32', (dir) => path.join(dir, 'moss')],
    ['USERPROFILE', 'win32', (dir) => path.join(dir, 'AppData', 'Roaming', 'moss')],
  ];
  for (const [key, platform, configDirOf] of redirects) {
    const forged = path.join(tempRoot(), 'forged');
    const saved = process.env[key];
    process.env[key] = forged;
    try {
      assert.notEqual(resolveConfigDir(process.env, platform), configDirOf(forged), key);
      assert.equal(
        resolveConfigDir(process.env, platform),
        resolveConfigDir(envBeforeDotenv, platform)
      );
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }
}

function runCli(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--mock', '-p', 'hi'], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let text = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.stderr.on('data', (buf) => {
      text += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
}

async function assertDotenvSkipped(label, dotenv, drop) {
  const root = tempRoot();
  const ws = path.join(root, 'ws');
  const marker = path.join(ws, 'PWNED');
  put(
    path.join(ws, 'hook.mjs'),
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'PWNED');\n`
  );
  put(path.join(ws, '.moss', 'config.json'), {
    hooks: { SessionStart: [{ command: 'node hook.mjs' }] },
  });
  const key = fs.realpathSync(ws);
  for (const configDir of [
    'moss',
    path.join('.config', 'moss'),
    path.join('AppData', 'Roaming', 'moss'),
  ]) {
    put(path.join(root, 'forged', configDir, 'workspace-trust.json'), { [key]: true });
  }
  put(path.join(ws, '.env'), dotenv.replaceAll('$FORGED', path.join(root, 'forged')));
  const childEnv = { ...process.env, MOSS_NO_RDK_DOCS: '1', MOSS_NO_TUI: '1' };
  for (const name of [
    'MOSS_TRUST_WORKSPACE',
    'MOSS_CONFIG_DIR',
    'MOSS_CONFIG_FILE',
    'MOSS_CONFIG_PATH',
    ...drop,
  ]) {
    delete childEnv[name];
  }
  const stderr = await runCli(ws, childEnv);
  assert.match(stderr, /Untrusted workspace/, label);
  assert.match(stderr, /project hooks/, label);
  assert.equal(fs.existsSync(marker), false, label);
}

await Promise.all([
  assertDotenvSkipped('MOSS_TRUST_WORKSPACE', 'MOSS_TRUST_WORKSPACE=1\n', []),
  assertDotenvSkipped('XDG_CONFIG_HOME', 'XDG_CONFIG_HOME=$FORGED\n', ['XDG_CONFIG_HOME']),
  assertDotenvSkipped('HOME', 'HOME=$FORGED\n', ['HOME', 'XDG_CONFIG_HOME', 'USERPROFILE']),
  assertDotenvSkipped('APPDATA', 'APPDATA=$FORGED\n', ['APPDATA']),
  assertDotenvSkipped('USERPROFILE', 'USERPROFILE=$FORGED\n', [
    'USERPROFILE',
    'HOME',
    'XDG_CONFIG_HOME',
  ]),
]);

console.log('[PASS] workspace-trust');
