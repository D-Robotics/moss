#!/usr/bin/env node
/**
 * Fresh HOME, no config file: `moss` opens inline setup against a stub gateway.
 * A pasted key is stored mode 0600 and never appears in the terminal.
 * An accepted env offer stores apiKeyEnv, not a copy of the key.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trackTempDir } from './helpers/temp-home.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');
const SECRET = 'sk-firstrun-e2e-secret';

function tempDir(prefix) {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function startStub() {
  const seen = [];
  const models = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const auth = req.headers.authorization ?? '';
      const raw = Buffer.concat(chunks).toString('utf8');
      let sentModel = '';
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.model === 'string') sentModel = parsed.model;
      } catch {
        // GET /v1/models has no body.
      }
      seen.push({ method: req.method, url: req.url, auth: auth.replace(SECRET, '[key]') });
      if (req.method === 'POST' && (req.url ?? '').includes('/v1/chat/completions')) {
        models.push(sentModel);
      }
      if (!auth.includes(SECRET)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if ((req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-alpha' }, { id: 'stub-beta' }] }));
        return;
      }
      if (req.method === 'POST' && (req.url ?? '').includes('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'STUB_ANSWER_OK' } }],
          })
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port, seen, models });
    });
  });
}

function visible(text) {
  const esc = String.fromCharCode(0x1b);
  const bel = String.fromCharCode(0x07);
  return text
    .replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, 'g'), '')
    .replace(new RegExp(`${esc}\\][^${bel}]*?(?:${bel}|${esc}\\\\)`, 'g'), '');
}

/**
 * Drive `node dist/cli.js` on a PTY. `steps` is a list of
 * `{ wait, send, timeoutMs }`. `wait` is a byte string (or null to send immediately).
 */
function drivePty({ home, configDir, workspace, extraEnv, steps }) {
  return new Promise((resolve) => {
    const python = String.raw`
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
node_bin, cli_path, home, config_dir, workspace, script = sys.argv[1:7]
steps = []
for line in script.split('\n'):
    line = line.strip()
    if not line:
        continue
    kind, payload = line.split('\t', 1)
    steps.append((kind, payload))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
env = {
    'PATH': os.environ.get('PATH', ''),
    'HOME': home,
    'TERM': 'xterm-256color',
    'LANG': 'C.UTF-8',
    'LC_ALL': 'C',
    'MOSS_CONFIG_DIR': config_dir,
    'MOSS_RUNTIME_DIR': os.path.join(home, 'runtime'),
    'MOSS_NO_BUNDLED_DEFAULT': '1',
    'MOSS_TRUST_WORKSPACE': '1',
    'NO_COLOR': '1',
}
extra = os.environ.get('MOSS_E2E_EXTRA', '')
for pair in extra.split('\n'):
    if not pair or '=' not in pair:
        continue
    key, value = pair.split('=', 1)
    env[key] = value
proc = subprocess.Popen(
    [node_bin, cli_path],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    cwd=workspace,
)
os.close(slave)
data = b''
failed = False

def pull(timeout):
    global data
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(master, 16384)
        except OSError:
            return False
        if not chunk:
            return False
        data += chunk
    return True

try:
    for kind, payload in steps:
        if kind == 'wait':
            needle = payload.encode()
            deadline = time.time() + 25
            found = False
            while time.time() < deadline:
                if needle in data:
                    found = True
                    break
                if not pull(0.3):
                    break
            if not found:
                sys.stderr.write('TIMEOUT waiting for %r\n' % payload)
                failed = True
                break
            time.sleep(0.2)
        elif kind == 'send':
            os.write(master, payload.encode('utf-8').decode('unicode_escape').encode('utf-8'))
            time.sleep(0.2)
        elif kind == 'sleep':
            time.sleep(float(payload))
finally:
    try:
        os.write(master, b'\x03')
        time.sleep(0.2)
        os.write(master, b'\x03')
    except OSError:
        pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)
    try:
        os.close(master)
    except OSError:
        pass
sys.stdout.buffer.write(data)
if failed:
    raise SystemExit(2)
`;
    const script = steps.map((step) => `${step.kind}\t${step.payload ?? ''}`).join('\n');
    const extra = Object.entries(extraEnv ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const child = spawn(
      'python3',
      ['-c', python, process.execPath, cli, home, configDir, workspace, script],
      { env: { ...process.env, MOSS_E2E_EXTRA: extra } }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({
        status: status ?? 1,
        text: visible(Buffer.concat(stdout).toString('utf8')),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

const stub = await startStub();
try {
  const home = tempDir('moss-e2e-home-');
  const configDir = path.join(home, 'config');
  const workspace = tempDir('moss-e2e-ws-');
  const base = `http://127.0.0.1:${stub.port}`;
  const typed = await drivePty({
    home,
    configDir,
    workspace,
    steps: [
      { kind: 'wait', payload: 'Moss setup' },
      { kind: 'send', payload: '6' },
      { kind: 'wait', payload: 'Gateway URL' },
      { kind: 'send', payload: `${base}/v1` },
      { kind: 'sleep', payload: '0.4' },
      { kind: 'send', payload: '\\r' },
      { kind: 'wait', payload: 'API key (hidden)' },
      { kind: 'send', payload: SECRET },
      { kind: 'sleep', payload: '0.3' },
      { kind: 'send', payload: '\\r' },
      { kind: 'wait', payload: 'stub-alpha' },
      { kind: 'send', payload: '\\r' },
      { kind: 'wait', payload: 'look around this folder' },
      { kind: 'send', payload: 'hi' },
      { kind: 'sleep', payload: '0.3' },
      { kind: 'send', payload: '\\r' },
      { kind: 'wait', payload: 'STUB_ANSWER_OK' },
    ],
  });
  assert.equal(
    typed.status,
    0,
    `pty driver failed\n${typed.stderr}\n${typed.text.slice(-2500)}\nseen=${JSON.stringify(stub.seen)}`
  );
  assert.match(typed.text, /Moss setup/);
  assert.match(typed.text, /stub-alpha/);
  assert.match(typed.text, /look around this folder/);
  assert.doesNotMatch(typed.text, /sk-firstrun-e2e-secret/);
  const configPath = path.join(configDir, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const saved = JSON.parse(raw);
  assert.equal(saved.provider, 'openai-compatible');
  assert.equal(saved.baseUrl, base);
  assert.equal(saved.model, 'stub-alpha');
  assert.match(saved.apiKey, /^enc:/);
  assert.doesNotMatch(raw, /sk-firstrun-e2e-secret/);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.ok(
    stub.seen.some((item) => item.url.startsWith('/v1/models') && item.auth.includes('[key]'))
  );
  assert.ok(
    stub.seen.some((item) => item.url.includes('/v1/chat/completions') && item.method === 'POST')
  );
  assert.ok(stub.models.length > 0, `no chat model recorded: ${JSON.stringify(stub.seen)}`);
  assert.equal(stub.models[stub.models.length - 1], 'stub-alpha');
  assert.ok(
    stub.models.every((name) => name === 'stub-alpha'),
    `first turn sent ${JSON.stringify(stub.models)}`
  );

  stub.seen.length = 0;
  stub.models.length = 0;
  const home2 = tempDir('moss-e2e-env-home-');
  const configDir2 = path.join(home2, 'config');
  const workspace2 = tempDir('moss-e2e-env-ws-');
  const offered = await drivePty({
    home: home2,
    configDir: configDir2,
    workspace: workspace2,
    extraEnv: {
      OPENAI_API_KEY: SECRET,
      OPENAI_BASE_URL: `${base}/v1`,
    },
    steps: [
      { kind: 'wait', payload: 'OPENAI_API_KEY' },
      { kind: 'send', payload: '1' },
      { kind: 'wait', payload: 'stub-beta' },
      { kind: 'send', payload: '2' },
      { kind: 'sleep', payload: '0.35' },
      { kind: 'send', payload: '\\r' },
      { kind: 'wait', payload: 'look around this folder' },
    ],
  });
  assert.equal(
    offered.status,
    0,
    `env offer failed\n${offered.stderr}\n${offered.text.slice(-2500)}\nseen=${JSON.stringify(stub.seen)}`
  );
  assert.match(offered.text, new RegExp(`127\\.0\\.0\\.1:${stub.port}`));
  assert.match(offered.text, /Press its number/);
  assert.doesNotMatch(offered.text, /Press Enter to use it/);
  assert.doesNotMatch(offered.text, /sk-firstrun-e2e-secret/);
  const savedEnv = JSON.parse(fs.readFileSync(path.join(configDir2, 'config.json'), 'utf8'));
  assert.equal(savedEnv.model, 'stub-beta');
  assert.equal(savedEnv.baseUrl, base);
  assert.equal(savedEnv.apiKey, undefined);
  assert.equal(savedEnv.apiKeyEnv, 'OPENAI_API_KEY');
  assert.doesNotMatch(JSON.stringify(savedEnv), /sk-firstrun/);

  stub.seen.length = 0;
  stub.models.length = 0;
  const homePoison = tempDir('moss-e2e-dotenv-home-');
  const configDirPoison = path.join(homePoison, 'config');
  const workspacePoison = tempDir('moss-e2e-dotenv-ws-');
  fs.writeFileSync(path.join(workspacePoison, '.env'), `OPENAI_BASE_URL=${base}/v1\n`);
  const poisoned = await drivePty({
    home: homePoison,
    configDir: configDirPoison,
    workspace: workspacePoison,
    extraEnv: { OPENAI_API_KEY: SECRET },
    steps: [
      { kind: 'wait', payload: 'api.openai.com' },
      { kind: 'send', payload: '\\r' },
      { kind: 'sleep', payload: '1.2' },
    ],
  });
  assert.equal(
    poisoned.status,
    0,
    `project .env base url\n${poisoned.stderr}\n${poisoned.text.slice(-2500)}\nseen=${JSON.stringify(stub.seen)}`
  );
  assert.match(poisoned.text, /api\.openai\.com/);
  assert.doesNotMatch(poisoned.text, new RegExp(`127\\.0\\.0\\.1:${stub.port}`));
  assert.equal(stub.seen.length, 0, JSON.stringify(stub.seen));
  assert.equal(fs.existsSync(path.join(configDirPoison, 'config.json')), false);

  stub.seen.length = 0;
  stub.models.length = 0;
  const home3 = tempDir('moss-e2e-wizard-home-');
  const configDir3 = path.join(home3, 'config');
  const workspace3 = tempDir('moss-e2e-wizard-ws-');
  const wizard = await drivePty({
    home: home3,
    configDir: configDir3,
    workspace: workspace3,
    extraEnv: { MOSS_NO_TUI: '1' },
    steps: [
      { kind: 'wait', payload: 'Start setup now' },
      { kind: 'send', payload: '\\r' },
      { kind: 'wait', payload: 'Choose a provider' },
      { kind: 'send', payload: '6\\r' },
      { kind: 'wait', payload: 'Gateway URL' },
      { kind: 'send', payload: `${base}\\r` },
      { kind: 'wait', payload: 'API key (hidden)' },
      { kind: 'send', payload: `${SECRET}\\r` },
      { kind: 'wait', payload: 'stub-beta' },
      { kind: 'send', payload: '2\\r' },
      { kind: 'wait', payload: 'Ready' },
      { kind: 'send', payload: 'hi\\r' },
      { kind: 'wait', payload: 'STUB_ANSWER_OK' },
    ],
  });
  assert.equal(
    wizard.status,
    0,
    `readline wizard failed\n${wizard.stderr}\n${wizard.text.slice(-3000)}\nmodels=${JSON.stringify(stub.models)}`
  );
  const savedWizard = JSON.parse(fs.readFileSync(path.join(configDir3, 'config.json'), 'utf8'));
  assert.equal(savedWizard.model, 'stub-beta');
  assert.equal(
    stub.models[stub.models.length - 1],
    savedWizard.model,
    `first request model ${JSON.stringify(stub.models)} != saved ${savedWizard.model}`
  );
  assert.ok(!stub.models.includes('deepseek-v4-flash'), JSON.stringify(stub.models));

  const zhPrefix = [
    { kind: 'wait', payload: '现在开始设置' },
    { kind: 'send', payload: '\\r' },
    { kind: 'wait', payload: '界面语言' },
    { kind: 'send', payload: 'x' },
    { kind: 'wait', payload: '服务商' },
    { kind: 'send', payload: '6\\r' },
    { kind: 'wait', payload: '网关地址' },
  ];
  const zhJourneys = [
    {
      name: 'readline auth paste is never echoed',
      prefix: 'moss-e2e-badkey-',
      steps: [
        { kind: 'send', payload: `${base}\\r` },
        { kind: 'wait', payload: 'API key（不显示）' },
        { kind: 'send', payload: 'sk-wrong-000\\r' },
        { kind: 'wait', payload: '密钥被拒绝' },
        { kind: 'sleep', payload: '0.5' },
        { kind: 'send', payload: 'sk-echo-check-000\\r' },
        { kind: 'sleep', payload: '0.8' },
      ],
      match: [/密钥被拒绝/, /请重新粘贴/, /API key（不显示）/],
      absent: [
        /选择模型/,
        /模型名/,
        /sk-wrong-000/,
        /sk-echo-check-000/,
        /输入「仍然保存」/,
        /Esc 返回/,
        /按 1/,
      ],
      saved: false,
    },
    {
      name: 'bad url',
      prefix: 'moss-e2e-badurl-',
      steps: [
        { kind: 'send', payload: 'http://127.0.0.1:59999\\r' },
        { kind: 'wait', payload: 'API key' },
        { kind: 'send', payload: 'sk-wrong-000\\r' },
        { kind: 'wait', payload: '连接被拒绝' },
        { kind: 'sleep', payload: '0.8' },
      ],
      match: [/连接被拒绝/, /仍然保存/],
      absent: [/选择模型/, /模型名/],
      saved: false,
    },
    {
      name: 'save anyway',
      prefix: 'moss-e2e-saveanyway-',
      steps: [
        { kind: 'send', payload: `${base}\\r` },
        { kind: 'wait', payload: 'API key（不显示）' },
        { kind: 'send', payload: 'sk-wrong-000\\r' },
        { kind: 'wait', payload: '密钥被拒绝' },
        { kind: 'sleep', payload: '0.5' },
        { kind: 'send', payload: '\\r' },
        { kind: 'wait', payload: '仍然保存？' },
        { kind: 'send', payload: 'y\\r' },
        { kind: 'wait', payload: '模型名' },
        { kind: 'send', payload: 'stub-alpha\\r' },
        { kind: 'wait', payload: '已保存' },
      ],
      match: [/已保存/],
      saved: true,
    },
  ];
  for (const journey of zhJourneys) {
    const home = tempDir(journey.prefix);
    const configDir = path.join(home, 'config');
    const workspace = tempDir(`${journey.prefix}ws-`);
    const result = await drivePty({
      home,
      configDir,
      workspace,
      extraEnv: { MOSS_NO_TUI: '1', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
      steps: [...zhPrefix, ...journey.steps],
    });
    assert.equal(
      result.status,
      0,
      `${journey.name}\n${result.stderr}\n${result.text.slice(-2500)}`
    );
    for (const pattern of journey.match) assert.match(result.text, pattern, journey.name);
    for (const pattern of journey.absent ?? [])
      assert.doesNotMatch(result.text, pattern, journey.name);
    const configPath = path.join(configDir, 'config.json');
    if (!journey.saved) {
      if (fs.existsSync(configPath)) {
        const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(stored.language, 'auto', journey.name);
        assert.equal(stored.apiKey, undefined, journey.name);
        assert.equal(stored.provider, undefined, journey.name);
        assert.equal(stored.model, undefined, journey.name);
      }
      continue;
    }
    const forced = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(forced.model, 'stub-alpha');
    assert.match(forced.apiKey, /^enc:/);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(forced), /sk-wrong/);
  }
} finally {
  await new Promise((resolve) => stub.server.close(resolve));
}

console.log('[PASS] fresh-home first-run e2e');
