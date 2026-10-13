#!/usr/bin/env node
/**
 * O70 + O67 blackhole exit bundle (QA failing repro).
 *
 * Acceptance:
 * - Dead HTTPS_PROXY: moss -p exits by itself; error names network/proxy; no "switching models".
 * - Refused proxy: mentions proxy, not "Nothing is listening at that base URL".
 * - Source locks: first-chunk timeout copy and cli-main background stop.
 *
 * Expected on main ed638367: FAIL. After exit-bundle fix: PASS.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'dist', 'cli.js');

const MODEL_COACH =
  /switching models|switch models|try another model|faster model|换一个.*模型|更快的模型/i;
const NET_OR_PROXY =
  /network|proxy|HTTPS_PROXY|代理|网络|connect(ion)? (failed|refused|timed out)/i;

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * In-process blackhole HTTPS proxy for CI.
 * Accepts TCP on 127.0.0.1, logs BLACKHOLE, reads forever, never replies.
 * (Previously shelled out to /workspace/ux/acceptance/proxy.py — that path
 * only exists on the agent box, so CI never got a port file.)
 */
function startBlackholeProxy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-bh-'));
  const logFile = path.join(dir, 'log');
  fs.writeFileSync(logFile, '');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    fs.appendFileSync(logFile, 'BLACKHOLE accepted\n');
    // Read and discard; never reply (simulates a dead proxy).
    socket.on('data', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        logFile,
        stop() {
          for (const s of sockets) {
            try {
              s.destroy();
            } catch {
              /* ignore */
            }
          }
          sockets.clear();
          try {
            server.close();
          } catch {
            /* ignore */
          }
          fs.rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

function closedPort() {
  const s = net.createServer();
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function runMoss({ env, args, cwd, killAfterMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, killAfterMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        killed,
        ms: Date.now() - started,
        out: `${stdout}\n${stderr}`,
      });
    });
  });
}

function prepareEnv(extra = {}, inherited = process.env) {
  const cleanInherited = { ...inherited };
  for (const key of Object.keys(cleanInherited)) {
    if (/^(?:https?|all|no)_proxy$/i.test(key) || /^NODE_USE_ENV_PROXY$/i.test(key))
      delete cleanInherited[key];
  }
  const env = isolatedCliEnv({
    inherited: cleanInherited,
    prefix: 'moss-exit-bundle-',
    overrides: {
      MOSS_NO_TUI: '1',
      MOSS_NO_COLOR: '1',
      MOSS_NO_BUNDLED_DEFAULT: '1',
      MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS: '4000',
      LANG: 'C',
      LC_ALL: 'C',
      NO_PROXY: '',
      ...extra,
    },
  });
  delete env.NODE_USE_ENV_PROXY;
  delete env.MOSS_TRUST_WORKSPACE;
  const ws = path.join(env.HOME, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), {
    provider: 'openai-compatible',
    model: 'stub-model',
    baseUrl: 'https://moss-exit-bundle.invalid/v1',
    apiKey: 'sk-acceptance-exit-bundle',
    permissions: { defaultMode: 'full' },
  });
  return { env, ws };
}

test('O67 copy lock: first-chunk timeout must not coach switching models', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/core/loop/agent-loop-stream-helpers.ts'),
    'utf8'
  );
  assert.doesNotMatch(
    src,
    /switching models/,
    'LlmFirstChunkTimeoutError message must not tell users to switch models'
  );
});

test('O70: CLI exit path must call stopAllBackgroundProcesses', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/cli-main.ts'), 'utf8');
  assert.match(
    src,
    /stopAllBackgroundProcesses\s*\(/,
    'cli-main must call stopAllBackgroundProcesses on the exit path'
  );
});

test('O67: inherited proxy aliases cannot bypass the owned proxy', async () => {
  const proxy = await startBlackholeProxy();
  const { env, ws } = prepareEnv(
    { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
    {
      ...process.env,
      HTTP_PROXY: 'not-a-valid-proxy-url',
      http_proxy: 'not-a-valid-proxy-url',
      https_proxy: 'http://127.0.0.1:1',
      Https_Proxy: 'http://127.0.0.1:1',
      ALL_PROXY: 'not-a-valid-proxy-url',
      NO_PROXY: '*',
      no_proxy: '*',
    }
  );
  try {
    const r = await runMoss({
      env,
      cwd: ws,
      args: ['-p', 'reply with just: ok'],
      killAfterMs: 45_000,
    });
    const log = fs.existsSync(proxy.logFile) ? fs.readFileSync(proxy.logFile, 'utf8') : '';
    assert.match(
      log,
      /BLACKHOLE/,
      'the actual CLI must contact its owned proxy despite inherited aliases'
    );
    assert.equal(r.killed, false, 'the isolated proxy scenario must exit by itself');
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.out, MODEL_COACH);
    assert.match(r.out, NET_OR_PROXY);
    assert.ok(r.ms < 35_000, `took ${r.ms}ms`);
  } finally {
    proxy.stop();
  }
});

test('O67/O70: blackhole HTTPS_PROXY — self-exit; no model coaching', async () => {
  const proxy = await startBlackholeProxy();
  const { env, ws } = prepareEnv({
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
  });
  try {
    const r = await runMoss({
      env,
      cwd: ws,
      args: ['-p', 'reply with just: ok'],
      killAfterMs: 45_000,
    });
    const log = fs.existsSync(proxy.logFile) ? fs.readFileSync(proxy.logFile, 'utf8') : '';
    assert.ok(/BLACKHOLE/.test(log), `HTTPS_PROXY must be contacted; log=${log}`);
    assert.equal(
      r.killed,
      false,
      `moss must exit by itself after a dead proxy (still running at ${r.ms}ms)`
    );
    assert.notEqual(r.code, 0, 'dead proxy must fail');
    assert.doesNotMatch(r.out, MODEL_COACH, `must not coach models:\n${r.out.slice(-800)}`);
    assert.match(r.out, NET_OR_PROXY, `must name network/proxy:\n${r.out.slice(-800)}`);
    assert.ok(r.ms < 35_000, `took ${r.ms}ms`);
  } finally {
    proxy.stop();
  }
});

test('O67: refused proxy — blame proxy, not base URL', async () => {
  const port = await closedPort();
  const { env, ws } = prepareEnv({
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
  });
  const r = await runMoss({
    env,
    cwd: ws,
    args: ['-p', 'reply with just: ok'],
    killAfterMs: 30_000,
  });
  assert.equal(r.killed, false, `must not hang (${r.ms}ms)`);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, MODEL_COACH, r.out.slice(-500));
  assert.match(r.out, /proxy|代理/i, `must mention proxy:\n${r.out.slice(-800)}`);
  assert.doesNotMatch(
    r.out,
    /Nothing is listening at that base URL/i,
    'must not blame base URL when proxy refused'
  );
});
