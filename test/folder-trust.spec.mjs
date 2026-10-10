#!/usr/bin/env node
/**
 * First-launch folder trust. The prompt is one keypress, before hooks run.
 * Yes is remembered in the user store. No exits. -p never prompts.
 * A project .env cannot grant trust.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';
import { folderPathKey, readTrustStore } from '../dist/cli/folder-trust-store.js';
import { folderTrustPrompt, resolveFolderTrust } from '../dist/cli/workspace-trust.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const PTY = `
import os, pty, select, signal, subprocess, sys, time
node, cli, cwd, mode, marker, timeout = sys.argv[1:]
master, slave = pty.openpty()
argv = [node, cli, '--mock']
proc = subprocess.Popen(
    argv,
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
answered = False
early = False
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(master, 8192)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if (not answered) and b'Trust this folder?' in buf:
            if os.path.exists(marker):
                early = True
            answered = True
            os.write(master, bytes([10]) if mode == 'yes' else b'2')
    if mode == 'yes' and os.path.exists(marker):
        break
    if proc.poll() is not None:
        break
code = proc.poll()
# macOS killpg returns EPERM once the group leader has exited (zombie).
try:
    os.killpg(proc.pid, signal.SIGTERM)
except (ProcessLookupError, PermissionError):
    pass
try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    proc.wait(timeout=3)
if code is None:
    code = proc.poll()
sys.stdout.buffer.write(buf)
if early:
    sys.stderr.write('MARKER_BEFORE_ANSWER\\n')
sys.stderr.write('EXIT:%s\\n' % (code if code is not None else proc.returncode))
`;

function runPty(cwd, env, mode, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', PTY, process.execPath, cli, cwd, mode, marker, '20'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
    child.stdout.on('data', (buf) => {
      out += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      err += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(err || out || `pty helper exited ${code}`));
      else resolve({ out, err });
    });
  });
}

function hookWorkspace(root) {
  const ws = path.join(root, 'ws');
  const marker = path.join(ws, 'HOOK_RAN');
  put(
    path.join(ws, 'hook.mjs'),
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');\n`
  );
  put(path.join(ws, '.moss', 'config.json'), {
    hooks: { SessionStart: [{ command: `node ${JSON.stringify(path.join(ws, 'hook.mjs'))}` }] },
  });
  return { ws, marker };
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-home-'));
  const lines = [];
  const decision = await resolveFolderTrust({
    startDir: home,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-homecfg-')),
    interactive: true,
    trustFlag: false,
    env: { HOME: home },
    zh: false,
    readKey: async () => 'yes',
    write: (text) => lines.push(text),
  });
  assert.match(lines[0], /home directory/);
  assert.equal(decision.persisted, true);
  assert.equal(decision.trusted, true);
}

{
  const lines = [];
  const declined = await resolveFolderTrust({
    startDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-no-')),
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-cfg-')),
    interactive: true,
    trustFlag: false,
    env: {},
    zh: false,
    onDecline: 'return',
    readKey: async () => 'no',
    write: (text) => lines.push(text),
  });
  assert.equal(declined.trusted, false);
  assert.equal(declined.prompted, true);
  assert.match(lines[0], /no hooks, MCP servers, agents, or plugins/);
  assert.match(lines[0], /model gateway, proxy, TLS, and device target/);
  assert.match(lines[0], /Trust this folder\?/);
  assert.match(lines[0], /1 {2}Yes, trust this folder/);
  assert.match(lines[0], /2 {2}No, exit/);
  assert.match(lines[1], /was not trusted/);
  const zh = folderTrustPrompt({
    folderKey: '/tmp/proj',
    home: false,
    root: false,
    zh: true,
    items: [{ kind: 'hook', label: 'project hooks (2)' }],
  });
  assert.match(zh, /信任后将加载 项目钩子（2）。/);
  assert.match(zh, /受信任的项目可以更改模型网关、流量代理、TLS 和设备目标。/);
  assert.match(zh, /信任此文件夹？/);
  const emptyZh = folderTrustPrompt({
    folderKey: '/tmp/proj',
    home: false,
    root: false,
    zh: true,
  });
  assert.match(emptyZh, /此项目没有钩子、MCP 服务、子代理或插件。/);
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-items-'));
  const ws = path.join(root, 'ws');
  put(path.join(ws, '.moss', 'config.json'), {
    hooks: { Stop: [{ command: 'true' }] },
    statusLine: { command: 'echo status' },
  });
  put(path.join(ws, '.moss', 'mcp.json'), {
    mcpServers: { warehouse: { transport: 'stdio', command: 'warehouse-mcp' } },
  });
  const lines = [];
  const decision = await resolveFolderTrust({
    startDir: ws,
    configDir: path.join(root, 'cfg'),
    interactive: true,
    trustFlag: false,
    env: { HOME: path.join(root, 'home') },
    zh: false,
    onDecline: 'return',
    readKey: async () => 'no',
    write: (text) => lines.push(text),
  });
  assert.equal(decision.trusted, false);
  assert.match(
    lines[0],
    /Trusting loads project hooks \(1\), status line, stdio MCP \(warehouse\)\./
  );
  assert.match(
    lines[0],
    /A trusted project can change the model gateway, proxy, TLS, and device target\./
  );
  assert.doesNotMatch(lines[0], /no hooks, MCP servers/);
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-root-'));
  const lines = [];
  const root = await resolveFolderTrust({
    startDir: path.parse(process.cwd()).root,
    configDir,
    interactive: true,
    trustFlag: false,
    env: { HOME: os.homedir() },
    zh: false,
    onDecline: 'return',
    readKey: async () => 'yes',
    write: (text) => lines.push(text),
  });
  assert.equal(root.trusted, true);
  assert.equal(root.persisted, false);
  assert.match(lines[0], /filesystem root/);
  assert.equal(readTrustStore(configDir)[path.parse(process.cwd()).root], undefined);
  const again = await resolveFolderTrust({
    startDir: path.parse(process.cwd()).root,
    configDir,
    interactive: true,
    trustFlag: false,
    env: {},
    zh: false,
    onDecline: 'return',
    readKey: async () => 'no',
    write: () => {},
  });
  assert.equal(again.prompted, true, 'trusting / is not remembered');
  assert.equal(again.trusted, false);
}

{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-sub-'));
  const child = path.join(parent, 'nested');
  fs.mkdirSync(child);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-folder-subcfg-'));
  const { rememberFolderTrust } = await import('../dist/cli/folder-trust-store.js');
  rememberFolderTrust(configDir, parent);
  const covered = await resolveFolderTrust({
    startDir: child,
    configDir,
    interactive: true,
    trustFlag: false,
    env: {},
    readKey: async () => {
      throw new Error('a subdirectory of a trusted folder must not prompt');
    },
  });
  assert.equal(covered.trusted, true);
  assert.equal(covered.prompted, false);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-empty-folder-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-empty-cfg-'));
  const lines = [];
  const first = await resolveFolderTrust({
    startDir: dir,
    configDir,
    interactive: true,
    trustFlag: false,
    env: { HOME: path.join(dir, 'not-this') },
    zh: false,
    readKey: async () => 'yes',
    write: (text) => lines.push(text),
  });
  assert.equal(first.prompted, true);
  assert.equal(first.trusted, true);
  assert.equal(first.persisted, true);
  assert.match(lines[0], /no hooks, MCP servers, agents, or plugins/);
  assert.match(lines[0], /Trust this folder\?/);
  const second = await resolveFolderTrust({
    startDir: dir,
    configDir,
    interactive: true,
    trustFlag: false,
    env: { HOME: path.join(dir, 'not-this') },
    zh: false,
    readKey: async () => {
      throw new Error('the second launch of an empty project must not prompt');
    },
    write: () => {
      throw new Error('the second launch of an empty project must not prompt');
    },
  });
  assert.equal(second.prompted, false);
  assert.equal(second.trusted, true);
}

if (process.platform !== 'win32') {
  const env = isolatedCliEnv({ prefix: 'moss-folder-pty-' });
  env.MOSS_NO_TUI = '1';
  env.MOSS_NO_COLOR = '1';
  delete env.MOSS_TRUST_WORKSPACE;
  const root = env.HOME;
  const { ws, marker } = hookWorkspace(root);
  const first = await runPty(ws, env, 'no', marker);
  assert.match(first.out, /Trust this folder\?/);
  assert.match(first.out, new RegExp(folderPathKey(ws).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(first.err, /MARKER_BEFORE_ANSWER/);
  assert.equal(fs.existsSync(marker), false, 'No exits before the hook runs');
  assert.match(first.err, /EXIT:11/);
  assert.equal(fs.existsSync(path.join(env.MOSS_CONFIG_DIR, 'workspace-trust.json')), false);

  const yes = await runPty(ws, env, 'yes', marker);
  assert.match(yes.out, /Trust this folder\?/);
  assert.doesNotMatch(yes.err, /MARKER_BEFORE_ANSWER/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  const store = readTrustStore(env.MOSS_CONFIG_DIR);
  assert.equal(store[folderPathKey(ws)], true);
  const listed = spawnSync(process.execPath, [cli, 'trust', 'list'], {
    cwd: ws,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(folderPathKey(ws).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const removed = spawnSync(process.execPath, [cli, 'trust', 'remove'], {
    cwd: ws,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Removed trust/);
  const empty = spawnSync(process.execPath, [cli, 'trust', 'list'], {
    cwd: ws,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.match(empty.stdout, /No trusted folders/);
  const { rememberFolderTrust } = await import('../dist/cli/folder-trust-store.js');
  rememberFolderTrust(env.MOSS_CONFIG_DIR, ws);

  fs.rmSync(marker, { force: true });
  const second = await runPty(ws, env, 'yes', marker);
  assert.doesNotMatch(second.out, /Trust this folder\?/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');

  const dot = path.join(ws, '.env');
  put(dot, 'MOSS_TRUST_WORKSPACE=1\n');
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const otherMarker = path.join(other, 'HOOK_RAN');
  put(
    path.join(other, 'hook.mjs'),
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(otherMarker)},'ran');\n`
  );
  put(path.join(other, '.moss', 'config.json'), {
    hooks: { SessionStart: [{ command: 'node hook.mjs' }] },
  });
  put(path.join(other, '.env'), 'MOSS_TRUST_WORKSPACE=1\n');
  const forged = await runPty(other, env, 'no', otherMarker);
  assert.match(forged.out, /Trust this folder\?/, 'project .env cannot pre-trust');
  assert.equal(fs.existsSync(otherMarker), false);

  const printed = spawnSync(process.execPath, [cli, '--mock', '-p', 'hi'], {
    cwd: other,
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  const stderr = printed.stderr ?? '';
  assert.doesNotMatch(stderr, /Trust this folder\?/);
  assert.match(stderr, /Untrusted folder/);
  assert.match(stderr, /--trust-workspace/);
  assert.equal(fs.existsSync(otherMarker), false);
}

const EMPTY_PTY = `
import os, pty, select, signal, subprocess, sys, time
node, cli, cwd, mode, timeout = sys.argv[1:]
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
answered = False
quit_sent = False
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(master, 8192)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if mode == 'first' and (not answered) and b'Trust this folder?' in buf:
            answered = True
            os.write(master, bytes([10]))
        if (not quit_sent) and b'Ready.' in buf:
            quit_sent = True
            os.write(master, b'/quit\\n')
    if proc.poll() is not None:
        break
code = proc.poll()
# macOS killpg returns EPERM once the group leader has exited (zombie).
try:
    os.killpg(proc.pid, signal.SIGTERM)
except (ProcessLookupError, PermissionError):
    pass
try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    proc.wait(timeout=3)
if code is None:
    code = proc.poll()
sys.stdout.buffer.write(buf)
sys.stderr.write('EXIT:%s\\n' % (code if code is not None else proc.returncode))
`;

function runEmptyPty(cwd, env, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', EMPTY_PTY, process.execPath, cli, cwd, mode, '20'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
    child.stdout.on('data', (buf) => {
      out += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      err += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(err || out || `pty helper exited ${code}`));
      else resolve({ out, err });
    });
  });
}

if (process.platform !== 'win32') {
  const env = isolatedCliEnv({ prefix: 'moss-empty-launch-' });
  env.MOSS_NO_TUI = '1';
  env.MOSS_NO_COLOR = '1';
  delete env.MOSS_TRUST_WORKSPACE;
  const ws = path.join(env.HOME, 'empty');
  fs.mkdirSync(ws);
  const first = await runEmptyPty(ws, env, 'first');
  assert.match(first.out, /Trust this folder\?/);
  assert.match(first.out, /no hooks, MCP servers, agents, or plugins/);
  assert.match(first.out, /Ready\./);
  assert.doesNotMatch(first.out, /Do you want to proceed\?/);
  assert.equal(readTrustStore(env.MOSS_CONFIG_DIR)[folderPathKey(ws)], true);
  const second = await runEmptyPty(ws, env, 'second');
  assert.doesNotMatch(second.out, /Trust this folder\?/);
  assert.match(second.out, /Ready\./);
  assert.doesNotMatch(second.out, /Do you want to proceed\?/);

  const headless = path.join(env.HOME, 'empty-print');
  fs.mkdirSync(headless);
  const printed = spawnSync(process.execPath, [cli, '--mock', '-p', 'hi'], {
    cwd: headless,
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.doesNotMatch(printed.stderr ?? '', /Trust this folder\?/);
  assert.match(printed.stderr ?? '', /Untrusted folder/);
}

console.log('[PASS] folder-trust');
