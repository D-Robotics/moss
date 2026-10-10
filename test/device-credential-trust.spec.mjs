/**
 * The user's own device password, or any other secret, is never sent to an SSH
 * host that a project picked.
 *
 * - A project `.env` (even in a trusted folder) that sets MOSS_DEVICE_HOST gets
 *   only a MOSS_DEVICE_PASSWORD written in that same file. The real env,
 *   `~/.env`, and the install `.env` password is withheld with a notice.
 * - `.moss/devices.json` is ignored until the folder is trusted, and its
 *   `passwordEnvVar` / `passphraseEnvVar` cannot name an API key or token.
 *
 * Each case runs `moss -p` against a stub model that calls `device_info`, with
 * a real ssh2 server on 127.0.0.1 recording every password it is offered.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { loadDeviceRegistry } from '../dist/device/device-registry-file.js';
import { isDotenvDeniedEnvKey } from '../dist/utils/dotenv-denied-env.js';
import { trackTempDir } from './helpers/temp-home.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

const USER_PW = 'hunter2-user-board-pw';
const API_KEY = 'sk-REALUSERKEY0000000000000001';
const PROJECT_PW = 'proj-own-pw';

// ---- unit: denied env keys
for (const key of ['VISUAL', 'EDITOR', 'visual', 'BASH_FUNC_ls%%', 'bash_func_x%%']) {
  assert.equal(isDotenvDeniedEnvKey(key), true, key);
}
assert.equal(isDotenvDeniedEnvKey('EDITOR_THEME'), false);

// ---- unit: registry auth cannot reference model or service secrets
{
  const ws = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-devreg-')));
  const entry = (deviceId, auth) => ({ deviceId, kind: 'rdk', host: '10.0.0.2', auth });
  const devices = [
    entry('pw', { method: 'password', passwordEnvVar: 'MOSS_DEVICE_PASSWORD' }),
    entry('board-pw', { method: 'password', passwordEnvVar: 'BOARD_PASSWORD' }),
    entry('key', { method: 'private-key', privateKeyPath: '/k', passphraseEnvVar: 'KEY_PASS' }),
    entry('deepseek', { method: 'password', passwordEnvVar: 'DEEPSEEK_API_KEY' }),
    entry('gh', { method: 'password', passwordEnvVar: 'GITHUB_TOKEN' }),
    entry('aws', { method: 'password', passwordEnvVar: 'AWS_SECRET_ACCESS_KEY' }),
    entry('cred', { method: 'password', passwordEnvVar: 'GOOGLE_APPLICATION_CREDENTIALS' }),
    entry('auth', { method: 'password', passwordEnvVar: 'npm_config__auth' }),
    entry('phrase', {
      method: 'private-key',
      privateKeyPath: '/k',
      passphraseEnvVar: 'MOSS_API_KEY',
    }),
    entry('weird', { method: 'password', passwordEnvVar: 42 }),
  ];
  fs.mkdirSync(path.join(ws, '.moss'));
  fs.writeFileSync(path.join(ws, '.moss', 'devices.json'), JSON.stringify({ devices }));
  const byId = new Map(loadDeviceRegistry(ws).map((d) => [d.deviceId, d]));
  assert.equal(byId.size, devices.length);
  assert.equal(byId.get('pw').auth.passwordEnvVar, 'MOSS_DEVICE_PASSWORD');
  assert.equal(byId.get('board-pw').auth.passwordEnvVar, 'BOARD_PASSWORD');
  assert.equal(byId.get('key').auth.passphraseEnvVar, 'KEY_PASS');
  for (const id of ['deepseek', 'gh', 'aws', 'cred', 'auth', 'phrase', 'weird']) {
    assert.equal(byId.get(id).auth, undefined, id);
  }
}

// ---- end to end
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const offered = [];
const sshServer = new ssh2.Server(
  { hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })] },
  (conn) => {
    conn.on('error', () => {});
    conn.on('authentication', (ctx) => {
      offered.push({ method: ctx.method, user: ctx.username, password: ctx.password });
      ctx.reject(['password']);
    });
  }
);
await new Promise((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
const sshPort = sshServer.address().port;

async function startModelStub() {
  const toolResults = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!/chat\/completions/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the empty body
      }
      const tool = (body.messages ?? []).find((m) => m.role === 'tool');
      if (tool) toolResults.push(String(tool.content));
      const call = {
        id: 'call_1',
        type: 'function',
        function: { name: 'device_info', arguments: '{}' },
      };
      const message = tool
        ? { role: 'assistant', content: 'done' }
        : { role: 'assistant', content: null, tool_calls: [call] };
      const finish = tool ? 'stop' : 'tool_calls';
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = tool
          ? { role: 'assistant', content: 'done' }
          : { role: 'assistant', tool_calls: [{ index: 0, ...call }] };
        const chunk = (choice) =>
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [choice], usage })}\n\n`;
        res.write(chunk({ index: 0, delta, finish_reason: null }));
        res.write(chunk({ index: 0, delta: {}, finish_reason: finish }));
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            model: 'm',
            choices: [{ index: 0, message, finish_reason: finish }],
            usage,
          })
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/v1`,
    toolResults,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
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
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', (buf) => {
      stdout += buf;
    });
    child.stderr.on('data', (buf) => {
      stderr += buf;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const DEV = (user) =>
  `MOSS_DEVICE_HOST=127.0.0.1\nMOSS_DEVICE_PORT=${sshPort}\nMOSS_DEVICE_USER=${user}\n`;

/**
 * Lay out HOME, config, a parent dir, and a git workspace; run `moss -p`; return
 * the passwords the ssh server saw, stderr, and the device_info tool result.
 */
async function runCase(c) {
  const root = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-devcred-')));
  const home = path.join(root, 'home');
  const configDir = path.join(home, '.config', 'moss');
  const parent = c.cwdUnderHome ? path.join(home, 'src') : path.join(root, 'outer');
  const ws = path.join(parent, 'ws');
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const stub = await startModelStub();
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'openai-compatible',
      baseUrl: stub.base,
      apiKey: 'sk-FAKE0000000000000000000001',
      model: 'm',
      permissions: { defaultMode: 'manual' },
    })
  );
  if (c.project) fs.writeFileSync(path.join(ws, '.env'), c.project);
  if (c.home) fs.writeFileSync(path.join(home, '.env'), c.home);
  if (c.registry) {
    fs.mkdirSync(path.join(ws, '.moss'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.moss', 'devices.json'),
      JSON.stringify({
        devices: [
          {
            deviceId: 'board',
            kind: 'rdk',
            host: '127.0.0.1',
            port: sshPort,
            user: 'reg',
            auth: { method: 'password', passwordEnvVar: c.registry },
          },
        ],
      })
    );
  }
  const store = {};
  if (c.trust) store[fs.realpathSync(ws)] = true;
  if (c.trustParent) store[fs.realpathSync(parent)] = true;
  if (Object.keys(store).length > 0) {
    fs.writeFileSync(path.join(configDir, 'workspace-trust.json'), JSON.stringify(store));
  }
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    MOSS_CONFIG_DIR: configDir,
    MOSS_RUNTIME_DIR: path.join(root, 'runtime'),
    TMPDIR: root,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    MOSS_LANG: 'en',
    MOSS_NO_RDK_DOCS: '1',
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_COLOR: '1',
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    ...(c.env ?? {}),
  };
  const before = offered.length;
  const result = await runCli(ws, env, [...(c.args ?? []), '-p', 'check the board']);
  await stub.close();
  const passwords = offered
    .slice(before)
    .filter((o) => o.method === 'password')
    .map((o) => `${o.user}:${o.password}`);
  return { ...result, passwords, tool: stub.toolResults.join('\n'), ws };
}

const WITHHELD =
  /MOSS_DEVICE_HOST comes from a project \.env \(.*\); your own MOSS_DEVICE_PASSWORD is not sent to it/;

function assertNoSecret(name, r) {
  const all = `${r.stdout}\n${r.stderr}\n${r.tool}\n${r.passwords.join('\n')}`;
  for (const secret of [USER_PW, API_KEY]) {
    assert.ok(!all.includes(secret), `${name}: leaked ${secret}\n${all}`);
  }
}

// M1: a host chosen by a trusted project's .env never gets the user's password.
const m1Cases = [
  ['trusted project', { project: DEV('evil'), trust: true }],
  ['--trust-workspace', { project: DEV('evil'), args: ['--trust-workspace'] }],
  [
    'project overrides ~/.env host',
    {
      home: 'MOSS_DEVICE_HOST=10.255.255.1\nMOSS_DEVICE_USER=homeuser\n',
      project: DEV('evil'),
      trust: true,
      cwdUnderHome: true,
    },
  ],
  ['trusted parent dir', { project: DEV('evil'), trustParent: true }],
];
for (const [name, c] of m1Cases) {
  const r = await runCase({ ...c, env: { MOSS_DEVICE_PASSWORD: USER_PW } });
  assert.equal(r.code, 0, `${name}\n${r.stderr}`);
  assertNoSecret(name, r);
  assert.deepEqual(r.passwords, [], name);
  assert.match(r.stderr, WITHHELD, `${name}\n${r.stderr}`);
  assert.ok(r.stderr.includes(path.join(r.ws, '.env')), `${name}\n${r.stderr}`);
  assert.match(r.tool, /MOSS_DEVICE_HOST comes from a project \.env/, `${name}\n${r.tool}`);
}

// M1, ~/.env password: same rule when the password is the user's file, not the real env.
{
  const r = await runCase({
    home: `MOSS_DEVICE_PASSWORD=${USER_PW}\n`,
    project: DEV('evil'),
    trust: true,
    cwdUnderHome: true,
  });
  assert.equal(r.code, 0, r.stderr);
  assertNoSecret('~/.env password', r);
  assert.match(r.stderr, WITHHELD);
}

// M2: an untrusted .moss/devices.json is ignored entirely.
for (const [name, c] of [
  [
    'untrusted registry, device password',
    { registry: 'MOSS_DEVICE_PASSWORD', env: { MOSS_DEVICE_PASSWORD: USER_PW } },
  ],
  [
    'untrusted registry, API key',
    { registry: 'DEEPSEEK_API_KEY', env: { DEEPSEEK_API_KEY: API_KEY } },
  ],
]) {
  const r = await runCase(c);
  assert.equal(r.code, 0, `${name}\n${r.stderr}`);
  assertNoSecret(name, r);
  assert.deepEqual(r.passwords, [], name);
  assert.match(r.stderr, /Untrusted folder/, `${name}\n${r.stderr}`);
  assert.match(r.stderr, /\.moss\/devices\.json/, `${name}\n${r.stderr}`);
}

// M2: even trusted, a registry entry cannot use an API key as the SSH password.
{
  const r = await runCase({
    registry: 'DEEPSEEK_API_KEY',
    trust: true,
    env: { DEEPSEEK_API_KEY: API_KEY },
  });
  assert.equal(r.code, 0, r.stderr);
  assertNoSecret('trusted registry, API key', r);
  assert.deepEqual(r.passwords, []);
}

// Legit configurations still authenticate with the expected password.
{
  const r = await runCase({
    env: {
      MOSS_DEVICE_PASSWORD: USER_PW,
      MOSS_DEVICE_HOST: '127.0.0.1',
      MOSS_DEVICE_PORT: String(sshPort),
      MOSS_DEVICE_USER: 'realuser',
    },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.passwords.includes(`realuser:${USER_PW}`), `real env: ${r.passwords}`);
  assert.doesNotMatch(r.stderr, WITHHELD);
}
{
  const r = await runCase({
    home: DEV('homeuser'),
    env: { MOSS_DEVICE_PASSWORD: USER_PW },
    cwdUnderHome: true,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.passwords.includes(`homeuser:${USER_PW}`), `~/.env host: ${r.passwords}`);
  assert.doesNotMatch(r.stderr, WITHHELD);
}
{
  const r = await runCase({
    project: `${DEV('trusteduser')}MOSS_DEVICE_PASSWORD=${PROJECT_PW}\n`,
    trust: true,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(
    r.passwords.includes(`trusteduser:${PROJECT_PW}`),
    `project's own password: ${r.passwords}`
  );
  assert.doesNotMatch(r.stderr, WITHHELD);
}
{
  const r = await runCase({
    registry: 'MOSS_DEVICE_PASSWORD',
    trust: true,
    env: { MOSS_DEVICE_PASSWORD: USER_PW },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.passwords.includes(`reg:${USER_PW}`), `trusted registry: ${r.passwords}`);
  assert.doesNotMatch(r.stderr, /\.moss\/devices\.json/);
}

sshServer.close();
console.log('[PASS] device-credential-trust');
