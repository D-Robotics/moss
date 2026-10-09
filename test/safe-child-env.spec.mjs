#!/usr/bin/env node
/**
 * A project .env cannot load code into Moss or the built-in rdk-docs child.
 * NODE_OPTIONS / LD_PRELOAD / BASH_ENV / npm_config_* from that file are
 * ignored. The user's own NODE_OPTIONS, set in the real process environment,
 * still reaches the child.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envBeforeDotenv, loadEnvFile } from '../dist/cli/config.js';
import { builtinRdkDocsServerConfig } from '../dist/core/mcp/rdk-docs.js';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';
import { isDotenvDeniedEnvKey } from '../dist/utils/dotenv-denied-env.js';
import { safeChildEnv, startupChildEnv } from '../dist/utils/safe-child-env.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const denied = [
  'NODE_OPTIONS',
  'node_options',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'dyld_library_path',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_ASKPASS',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'npm_config_registry',
  'NPM_CONFIG_SCRIPT_SHELL',
  'npm_config_node_options',
  'PATH',
  'SHELL',
];
const allowed = ['NODE_DEBUG', 'HOME', 'FOO', 'npm_config', 'GIT_CONFIG', 'LD_DEBUG'];
for (const key of denied) assert.equal(isDotenvDeniedEnvKey(key), true, key);
for (const key of allowed) assert.equal(isDotenvDeniedEnvKey(key), false, key);

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-dotenv-'));
  const keys = [...denied, 'EXAMPLE_FROM_DOTENV'];
  fs.writeFileSync(path.join(root, '.env'), keys.map((key) => `${key}=forged`).join('\n'));
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    loadEnvFile(path.join(root, '.env'));
    for (const key of denied) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.EXAMPLE_FROM_DOTENV, 'forged');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.EXAMPLE_FROM_DOTENV;
  }
}

const probeKeys = [
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'BASH_ENV',
  'npm_config_registry',
  'CUSTOM_SENTINEL',
  'DYLD_INSERT_LIBRARIES',
];

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

{
  const saved = Object.fromEntries(
    ['NODE_OPTIONS', 'LD_PRELOAD', 'CUSTOM_SENTINEL'].map((key) => [key, process.env[key]])
  );
  process.env.NODE_OPTIONS = '--require /tmp/moss-evil.cjs';
  process.env.LD_PRELOAD = '/no/such-moss-preload.so';
  process.env.CUSTOM_SENTINEL = 'from-project-dotenv';
  try {
    const child = safeChildEnv();
    assert.equal(child.NODE_OPTIONS, envBeforeDotenv.NODE_OPTIONS);
    assert.equal(child.LD_PRELOAD, envBeforeDotenv.LD_PRELOAD);
    assert.equal(child.CUSTOM_SENTINEL, 'from-project-dotenv');
    const startup = startupChildEnv({ NODE_OPTIONS: '--require /tmp/moss-evil.cjs' });
    assert.equal(startup.NODE_OPTIONS, envBeforeDotenv.NODE_OPTIONS);
    assert.equal(startup.LD_PRELOAD, envBeforeDotenv.LD_PRELOAD);
    assert.equal(startup.CUSTOM_SENTINEL, undefined);
  } finally {
    restoreEnv(saved);
  }
}

function writePackage(dir, envFile) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'rdk-docs-mcp',
      version: '0.0.0',
      bin: { 'rdk-docs-mcp': './probe.mjs' },
    })
  );
  const probe = [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `const keys = ${JSON.stringify(probeKeys)};`,
    'const out = {};',
    'for (const key of keys) if (process.env[key] !== undefined) out[key] = process.env[key];',
    `fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(out));`,
    'process.exit(1);',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'probe.mjs'), probe);
  fs.chmodSync(path.join(dir, 'probe.mjs'), 0o755);
}

function project(root) {
  const ws = path.join(root, 'empty');
  const evil = path.join(root, 'evil.cjs');
  const user = path.join(root, 'user.cjs');
  const bash = path.join(root, 'bash.sh');
  const pwned = path.join(root, 'PWNED');
  const bashPwned = path.join(root, 'PWNED_BASH');
  const userOk = path.join(root, 'USER_OK');
  const envFile = path.join(root, 'child-env.json');
  const packageDir = path.join(root, 'rdk-docs-mcp');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(
    evil,
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pwned)},'PWNED_nodeopt');\n`
  );
  fs.writeFileSync(
    user,
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(userOk)},'USER_OK');\n`
  );
  fs.writeFileSync(bash, `echo PWNED_BASH > ${JSON.stringify(bashPwned)}\n`);
  const dotenv = [
    `NODE_OPTIONS=--require ${evil}`,
    'LD_PRELOAD=/no/such-moss-preload.so',
    `BASH_ENV=${bash}`,
    'npm_config_registry=http://127.0.0.1:9/moss-evil-registry',
    'CUSTOM_SENTINEL=from-project-dotenv',
    'DYLD_INSERT_LIBRARIES=/no/such.dylib',
  ].join('\n');
  fs.writeFileSync(path.join(ws, '.env'), dotenv);
  writePackage(packageDir, envFile);
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const npx = path.join(binDir, 'npx');
  fs.writeFileSync(
    npx,
    [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      `const keys = ${JSON.stringify(probeKeys)};`,
      'const out = { argv: process.argv.slice(2) };',
      'for (const key of keys) if (process.env[key] !== undefined) out[key] = process.env[key];',
      `fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(out));`,
      'process.exit(1);',
      '',
    ].join('\n')
  );
  fs.chmodSync(npx, 0o755);
  return { ws, evil, user, pwned, bashPwned, userOk, envFile, packageDir, binDir };
}

function assertChild(label, layout, userNode) {
  assert.equal(fs.existsSync(layout.pwned), false, `${label} ran NODE_OPTIONS`);
  assert.equal(fs.existsSync(layout.bashPwned), false, `${label} ran BASH_ENV`);
  const reported = JSON.parse(fs.readFileSync(layout.envFile, 'utf8'));
  assert.equal(reported.LD_PRELOAD, undefined, label);
  assert.equal(reported.BASH_ENV, undefined, label);
  assert.equal(reported.npm_config_registry, undefined, label);
  assert.equal(reported.CUSTOM_SENTINEL, undefined, label);
  assert.equal(reported.DYLD_INSERT_LIBRARIES, undefined, label);
  assert.equal(reported.NODE_OPTIONS, userNode, label);
  assert.ok(reported.argv.includes('rdk-docs-mcp'), label);
  if (userNode) assert.equal(fs.readFileSync(layout.userOk, 'utf8'), 'USER_OK');
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rdk-env-'));
  const layout = project(root);
  const saved = Object.fromEntries(probeKeys.map((key) => [key, process.env[key]]));
  process.env.NODE_OPTIONS = `--require ${layout.evil}`;
  process.env.LD_PRELOAD = '/no/such-moss-preload.so';
  process.env.BASH_ENV = path.join(root, 'bash.sh');
  process.env.npm_config_registry = 'http://127.0.0.1:9/moss-evil-registry';
  process.env.CUSTOM_SENTINEL = 'from-project-dotenv';
  process.env.DYLD_INSERT_LIBRARIES = '/no/such.dylib';
  const registry = McpToolRegistry.connectInBackground([
    builtinRdkDocsServerConfig(layout.packageDir),
  ]);
  try {
    await Promise.race([
      registry.waitForConnections(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('rdk connect timed out')), 20000)
      ),
    ]);
  } finally {
    await registry.closeAll();
    restoreEnv(saved);
  }
  assert.equal(fs.existsSync(layout.pwned), false, 'in-process rdk-docs ran NODE_OPTIONS');
  assert.equal(fs.existsSync(layout.bashPwned), false, 'in-process rdk-docs ran BASH_ENV');
  const reported = JSON.parse(fs.readFileSync(layout.envFile, 'utf8'));
  assert.equal(reported.NODE_OPTIONS, envBeforeDotenv.NODE_OPTIONS);
  assert.equal(reported.LD_PRELOAD, envBeforeDotenv.LD_PRELOAD);
  assert.notEqual(reported.NODE_OPTIONS, `--require ${layout.evil}`);
  assert.equal(reported.CUSTOM_SENTINEL, undefined);
  assert.notEqual(reported.npm_config_registry, 'http://127.0.0.1:9/moss-evil-registry');
  assert.equal(reported.DYLD_INSERT_LIBRARIES, envBeforeDotenv.DYLD_INSERT_LIBRARIES);
}

const drop = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_ASKPASS',
]);

function mossEnv(layout, userNode) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (key.startsWith('MOSS_DEVICE_')) continue;
    if (drop.has(key) || drop.has(key.toUpperCase())) continue;
    const upper = key.toUpperCase();
    if (
      upper.startsWith('DYLD_') ||
      upper.startsWith('GIT_CONFIG_') ||
      upper.startsWith('NPM_CONFIG_')
    ) {
      continue;
    }
    if (key === 'MOSS_CONFIG_DIR' || key === 'MOSS_CONFIG_FILE' || key === 'MOSS_CONFIG_PATH')
      continue;
    if (key === 'MOSS_NO_RDK_DOCS' || key === 'MOSS_TRUST_WORKSPACE') continue;
    env[key] = value;
  }
  const home = path.join(path.dirname(layout.ws), 'home');
  fs.mkdirSync(home, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.MOSS_NO_TUI = '1';
  env.MOSS_RDK_DOCS_PACKAGE = layout.packageDir;
  env.PATH = `${layout.binDir}${path.delimiter}${env.PATH ?? ''}`;
  if (userNode) env.NODE_OPTIONS = userNode;
  return env;
}

function runHeadless(layout, userNode) {
  const env = mossEnv(layout, userNode);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--mock', '-p', 'hi'], {
      cwd: layout.ws,
      env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
      resolve(stderr);
    };
    const timer = setTimeout(finish, 25000);
    const poll = setInterval(() => {
      if (fs.existsSync(layout.envFile)) finish();
    }, 100);
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        reject(err);
      }
    });
    child.on('exit', () => setTimeout(finish, 2000));
  });
}

const PTY = `
import os, pty, select, signal, subprocess, sys, time
node, cli, cwd, timeout, marker = sys.argv[1:]
master, slave = pty.openpty()
proc = subprocess.Popen(
    [node, cli, '--mock'],
    cwd=cwd,
    env=os.environ,
    stdin=slave,
    stdout=slave,
    stderr=subprocess.STDOUT,
    start_new_session=True,
)
os.close(slave)
deadline = time.time() + float(timeout)
buf = b''
while time.time() < deadline:
    if os.path.exists(marker):
        time.sleep(0.2)
        break
    ready, _, _ = select.select([master], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(master, 8192)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    if proc.poll() is not None:
        break
try:
    os.killpg(proc.pid, signal.SIGTERM)
except ProcessLookupError:
    pass
try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait(timeout=3)
sys.stdout.buffer.write(buf)
`;

function runInteractive(layout, userNode) {
  const env = mossEnv(layout, userNode);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'python3',
      ['-c', PTY, process.execPath, cli, layout.ws, '25', layout.envFile],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', (buf) => {
      out += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      err += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(err || `pty exited ${code}`));
      else resolve(out);
    });
  });
}

const cases = [
  ['-p', false],
  ['-p', true],
  ['interactive', false],
  ['interactive', true],
];
if (process.platform === 'win32') cases.splice(2);

await Promise.all(
  cases.map(async ([mode, withUser]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-dotenv-cli-'));
    const layout = project(root);
    const userNode = withUser ? `--require ${layout.user}` : undefined;
    const output =
      mode === '-p' ? await runHeadless(layout, userNode) : await runInteractive(layout, userNode);
    assert.doesNotMatch(output, /Trust this workspace|信任此工作区/);
    assert.equal(
      fs.existsSync(layout.envFile),
      true,
      `${mode} ${withUser} env file missing\n${output}`
    );
    assertChild(`${mode} user=${Boolean(withUser)}`, layout, userNode);
  })
);

console.log('[PASS] safe-child-env');
