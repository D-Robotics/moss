/**
 * A project or ancestor `.env` cannot set approval, trust, redaction, or
 * tool-permission variables. Trusted folders are not an exception. The real
 * process environment and CLI flags still can. `-p` prints one stderr line;
 * the TUI startup path shows that same line in the transcript.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../dist/cli/config.js';
import {
  DOTENV_SAFETY_ENV_KEYS,
  isDotenvSafetyEnvKey,
  takeDotenvSafetyEnvNotices,
} from '../dist/safety/dotenv-safety-env.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

const EXPECTED_KEYS = [
  'MOSS_APPROVAL_POLICY',
  'MOSS_ASK_FOR_APPROVAL',
  'MOSS_AUTO_APPROVE',
  'MOSS_CLI_AUTO_APPROVE',
  'MOSS_CLI_SAFETY_MODE',
  'MOSS_DENIED_TOOLS',
  'MOSS_DEVICE_TRUST',
  'MOSS_DEVICE_TRUST_DEVICES',
  'MOSS_DISABLE_NUDGES',
  'MOSS_NET_ALLOW_HOSTS',
  'MOSS_PLAN_GATE',
  'MOSS_SAFETY_MODE',
  'MOSS_TELEMETRY_ALLOW',
  'MOSS_TOOL_LOOP_DISCOVERY_FAILURE_LIMIT',
  'MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT',
  'MOSS_TOOL_LOOP_FAILURE_LIMIT',
  'MOSS_TOOL_LOOP_IDENTICAL_LIMIT',
  'MOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT',
  'MOSS_TOOL_LOOP_TOTAL_LIMIT',
  'MOSS_TRUST_WORKSPACE',
  'MOSS_TRUSTED_TOOLS',
  'MOSS_WEB_SEARCH_VARIATION_LIMIT',
];

assert.deepEqual([...DOTENV_SAFETY_ENV_KEYS], EXPECTED_KEYS);
for (const key of EXPECTED_KEYS) {
  assert.equal(isDotenvSafetyEnvKey(key.toLowerCase()), true, key);
}
assert.equal(isDotenvSafetyEnvKey('MOSS_DISABLE_CONN_WARMUP'), false);
assert.equal(isDotenvSafetyEnvKey('EXAMPLE_FROM_DOTENV'), false);
assert.equal(isDotenvSafetyEnvKey('MOSS_YOLO'), false);

takeDotenvSafetyEnvNotices(false);

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-safety-env-'));
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

{
  const root = tempRoot();
  const envPath = path.join(root, '.env');
  const body = [
    ...EXPECTED_KEYS.map((key) => `${key}=from-dotenv`),
    'moss_auto_approve=from-dotenv',
    'EXAMPLE_FROM_DOTENV=kept',
  ].join('\n');
  writeFile(envPath, `${body}\n`);
  const saved = new Map();
  for (const key of [...EXPECTED_KEYS, 'moss_auto_approve', 'EXAMPLE_FROM_DOTENV']) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    loadEnvFile(envPath);
    for (const key of EXPECTED_KEYS) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.moss_auto_approve, undefined);
    assert.equal(process.env.EXAMPLE_FROM_DOTENV, 'kept');
    const notices = takeDotenvSafetyEnvNotices(false);
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0],
      `[moss] Ignored safety env from ${envPath}: ${[...EXPECTED_KEYS].sort().join(', ')}`
    );
    assert.deepEqual(takeDotenvSafetyEnvNotices(true), []);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

{
  const root = tempRoot();
  const envPath = path.join(root, '.env');
  writeFile(envPath, 'MOSS_AUTO_APPROVE=0\n');
  const saved = process.env.MOSS_AUTO_APPROVE;
  process.env.MOSS_AUTO_APPROVE = '1';
  try {
    loadEnvFile(envPath);
    assert.equal(process.env.MOSS_AUTO_APPROVE, '1');
    const notices = takeDotenvSafetyEnvNotices(true);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /已忽略 .env/);
    assert.match(notices[0], /MOSS_AUTO_APPROVE/);
    assert.ok(notices[0].includes(envPath));
  } finally {
    if (saved === undefined) delete process.env.MOSS_AUTO_APPROVE;
    else process.env.MOSS_AUTO_APPROVE = saved;
    takeDotenvSafetyEnvNotices(false);
  }
}

function shellQuote(value) {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function layout(name) {
  const root = tempRoot();
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'cfg');
  const parent = path.join(root, 'parent');
  const workspace = path.join(parent, name);
  const dumpPath = path.join(root, 'dump.json');
  const dumpScript = path.join(root, 'dump.mjs');
  writeFile(
    dumpScript,
    [
      "import fs from 'node:fs';",
      'fs.writeFileSync(process.env.DUMP_PATH, JSON.stringify({',
      '  auto: process.env.MOSS_AUTO_APPROVE ?? null,',
      '  deviceTrust: process.env.MOSS_DEVICE_TRUST ?? null,',
      '  kept: process.env.EXAMPLE_FROM_DOTENV ?? null,',
      '}));',
      '',
    ].join('\n')
  );
  const command = `${shellQuote(process.execPath)} ${shellQuote(dumpScript)}`;
  writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        permissions: { defaultMode: 'manual' },
        hooks: { SessionStart: [{ command }] },
      },
      null,
      2
    )
  );
  fs.mkdirSync(workspace, { recursive: true });
  return { root, home, configDir, parent, workspace, dumpPath, dumpScript };
}

function childEnv(layoutInfo, overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (isDotenvSafetyEnvKey(key)) delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  env.HOME = layoutInfo.home;
  env.USERPROFILE = layoutInfo.home;
  env.XDG_CONFIG_HOME = path.join(layoutInfo.home, '.config');
  env.MOSS_CONFIG_DIR = layoutInfo.configDir;
  env.MOSS_RUNTIME_DIR = path.join(layoutInfo.root, 'runtime');
  env.MOSS_NO_RDK_DOCS = '1';
  env.MOSS_NO_COLOR = '1';
  env.LANG = 'C.UTF-8';
  env.LC_ALL = 'C.UTF-8';
  env.DUMP_PATH = layoutInfo.dumpPath;
  delete env.MOSS_LANG;
  delete env.MOSS_NO_TUI;
  delete env.MOSS_CONFIG_FILE;
  delete env.MOSS_CONFIG_PATH;
  return env;
}

function trust(layoutInfo) {
  const key = fs.realpathSync.native(layoutInfo.workspace);
  writeFile(
    path.join(layoutInfo.configDir, 'workspace-trust.json'),
    `${JSON.stringify({ [key]: true }, null, 2)}\n`
  );
}

function ignoredLines(stderr) {
  return stderr.split('\n').filter((line) => line.includes('Ignored safety env'));
}

function runCli(cwd, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readDump(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const project = layout('ws');
writeFile(
  path.join(project.workspace, '.env'),
  ['moss_auto_approve=1', 'MOSS_DEVICE_TRUST=full', 'EXAMPLE_FROM_DOTENV=from-project', ''].join(
    '\n'
  )
);
{
  const result = await runCli(project.workspace, childEnv(project), ['--mock', '-p', 'hi']);
  assert.equal(result.code, 0, result.stderr);
  const lines = ignoredLines(result.stderr);
  assert.deepEqual(lines, [
    `[moss] Ignored safety env from ${path.join(project.workspace, '.env')}: MOSS_AUTO_APPROVE, MOSS_DEVICE_TRUST`,
  ]);
  assert.doesNotMatch(result.stderr, /Interaction mode: full/);
  const dump = readDump(project.dumpPath);
  assert.equal(dump.auto, null);
  assert.equal(dump.deviceTrust, null);
  assert.equal(dump.kept, 'from-project');
}

const ancestor = layout('child');
writeFile(
  path.join(ancestor.parent, '.env'),
  'MOSS_AUTO_APPROVE=1\nEXAMPLE_FROM_DOTENV=from-ancestor\n'
);
{
  const result = await runCli(ancestor.workspace, childEnv(ancestor), ['--mock', '-p', 'hi']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(ignoredLines(result.stderr), [
    `[moss] Ignored safety env from ${path.join(ancestor.parent, '.env')}: MOSS_AUTO_APPROVE`,
  ]);
  assert.doesNotMatch(result.stderr, /Interaction mode: full/);
  const dump = readDump(ancestor.dumpPath);
  assert.equal(dump.auto, null);
  assert.equal(dump.kept, 'from-ancestor');
}

const trusted = layout('ws');
writeFile(
  path.join(trusted.workspace, '.env'),
  'MOSS_AUTO_APPROVE=1\nEXAMPLE_FROM_DOTENV=trusted\n'
);
trust(trusted);
{
  const result = await runCli(trusted.workspace, childEnv(trusted), ['--mock', '-p', 'hi']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(ignoredLines(result.stderr), [
    `[moss] Ignored safety env from ${path.join(trusted.workspace, '.env')}: MOSS_AUTO_APPROVE`,
  ]);
  assert.doesNotMatch(result.stderr, /Interaction mode: full/);
  assert.equal(readDump(trusted.dumpPath).auto, null);
  assert.equal(readDump(trusted.dumpPath).kept, 'trusted');
}

const live = layout('ws');
{
  const result = await runCli(live.workspace, childEnv(live, { MOSS_AUTO_APPROVE: '1' }), [
    '--mock',
    '-p',
    'hi',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(ignoredLines(result.stderr), []);
  assert.match(result.stderr, /Interaction mode: full/);
  assert.equal(readDump(live.dumpPath).auto, '1');
}

const flagged = layout('ws');
writeFile(path.join(flagged.workspace, '.env'), 'MOSS_AUTO_APPROVE=1\n');
{
  const result = await runCli(flagged.workspace, childEnv(flagged), [
    '--mock',
    '--full-access',
    '-p',
    'hi',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(ignoredLines(result.stderr), [
    `[moss] Ignored safety env from ${path.join(flagged.workspace, '.env')}: MOSS_AUTO_APPROVE`,
  ]);
  assert.match(result.stderr, /Interaction mode: full/);
  assert.equal(readDump(flagged.dumpPath).auto, null);
}

function runTui(cwd, env) {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (python.status !== 0) {
    throw new Error('python3 is required to start the TUI on a PTY');
  }
  const code = String.raw`
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
node_bin, cli_path, cwd = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 160, 0, 0))
proc = subprocess.Popen(
    [node_bin, cli_path, '--mock'],
    stdin=slave, stdout=slave, stderr=slave,
    env=os.environ.copy(), cwd=cwd,
)
os.close(slave)
data = b''
try:
    deadline = time.time() + 20
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(master, 8192)
            except OSError:
                break
            if not chunk:
                break
            data += chunk
            if b'Ignored safety env' in data:
                break
    for _ in range(2):
        try:
            os.write(master, b'\x03')
        except OSError:
            break
        time.sleep(0.2)
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)
finally:
    os.close(master)
sys.stdout.buffer.write(data)
`;
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code, process.execPath, cli, cwd], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(stderr || `tui pty exited ${code}`));
      else resolve(stdout);
    });
  });
}

if (process.platform !== 'win32') {
  const tui = layout('ws');
  const envFile = path.join(tui.workspace, '.env');
  writeFile(envFile, 'moss_auto_approve=1\nEXAMPLE_FROM_DOTENV=from-tui\n');
  const screen = await runTui(tui.workspace, childEnv(tui));
  const plain = screen.replace(new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, 'g'), '');
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/tui-safety-env.txt', plain);
  assert.match(plain, /Ignored safety env/);
  assert.ok(plain.includes(envFile), plain.slice(0, 2000));
  assert.match(plain, /MOSS_AUTO_APPROVE/);
  assert.doesNotMatch(plain, /Interaction mode: full/);
  const tuiLines = [
    ...new Set(plain.split('\n').filter((line) => line.includes('Ignored safety env'))),
  ];
  assert.equal(tuiLines.length, 1, plain);
  assert.ok(tuiLines[0].includes(envFile), tuiLines[0]);
  assert.equal(tuiLines[0].split('MOSS_AUTO_APPROVE').length - 1, 1);
  assert.equal(readDump(tui.dumpPath).auto, null);
  assert.equal(readDump(tui.dumpPath).kept, 'from-tui');
}

console.log('[PASS] dotenv-safety-env');
