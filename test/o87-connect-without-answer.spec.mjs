#!/usr/bin/env node
/**
 * O87: CONNECT without answer — cause preservation, no timeout/auth mislabel,
 * proxy connectTimeout, and a local CONNECT-then-blackhole fixture.
 *
 * Acceptance (QA):
 * 1. Preserve full cause (no truncated 网关原文：))
 * 2. Board with only HTTPS_PROXY: CONNECT ∧ answer (board owned by UX; here we
 *    lock the local negative/positive fixtures)
 * 3. Failures must not be mislabeled as timeout/auth
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { classifyProviderError } = await import('../dist/provider/error-classify.js');
const { isConnectTimeoutError, isTimeoutError, isConnectionError } =
  await import('../dist/provider/errors.js');
const { resolveConnectTimeoutMs } = await import('../dist/provider/keep-alive-dispatcher.js');

const MODEL_COACH = /switching models|faster model|换一个.*模型|更快的模型/i;
const AUTH_COPY = /密钥被拒绝|API key was rejected|401|paste the key/i;

test('O87 classify: UND_ERR_CONNECT_TIMEOUT is network, not model timeout/auth', () => {
  assert.equal(isConnectTimeoutError('UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error'), true);
  assert.equal(
    isTimeoutError('fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)'),
    false
  );
  assert.equal(
    isConnectionError('fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)'),
    true
  );

  const raw =
    'TypeError: fetch failed for ai-api.d-robotics.cc (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)\n' +
    'Timed out connecting to ai-api.d-robotics.cc via HTTPS_PROXY/HTTP_PROXY (undici connectTimeout). Check that the proxy tunnel can complete CONNECT and TLS.';
  const r = classifyProviderError({ errorMessage: raw, locale: 'zh_CN.UTF-8' });
  assert.equal(r.category, 'network');
  assert.match(r.userMessage, /网络连接失败/);
  assert.doesNotMatch(r.userMessage, MODEL_COACH);
  assert.doesNotMatch(r.userMessage, AUTH_COPY);
  assert.doesNotMatch(r.userMessage, /网关原文：\s*\)/);
  assert.match(r.userMessage, /详细信息：.*UND_ERR_CONNECT_TIMEOUT/);
});

test('O87 classify: lone ")" must not become 网关原文：)', () => {
  const r = classifyProviderError({
    errorMessage: 'fetch failed for ai-api.d-robotics.cc\n)',
    locale: 'zh_CN.UTF-8',
  });
  assert.equal(r.category, 'network');
  assert.doesNotMatch(r.userMessage, /网关原文/);
  assert.doesNotMatch(r.userMessage, /网关原文：\s*\)/);
});

test('O87 classify: real gateway bodies still attach as 网关原文', () => {
  const r = classifyProviderError({
    status: 401,
    errorMessage: 'invalid api key',
    locale: 'zh_CN.UTF-8',
  });
  assert.equal(r.category, 'auth');
  assert.match(r.userMessage, /网关原文：invalid api key/);
});

test('O87 resolveConnectTimeoutMs: proxy raises to 30s; override honored', () => {
  const prev = process.env.MOSS_CONNECT_TIMEOUT_MS;
  try {
    delete process.env.MOSS_CONNECT_TIMEOUT_MS;
    assert.equal(resolveConnectTimeoutMs(false), undefined);
    assert.equal(resolveConnectTimeoutMs(true), 30_000);
    process.env.MOSS_CONNECT_TIMEOUT_MS = '45000';
    assert.equal(resolveConnectTimeoutMs(true), 45_000);
    process.env.MOSS_CONNECT_TIMEOUT_MS = '0';
    assert.equal(resolveConnectTimeoutMs(true), undefined);
  } finally {
    if (prev === undefined) delete process.env.MOSS_CONNECT_TIMEOUT_MS;
    else process.env.MOSS_CONNECT_TIMEOUT_MS = prev;
  }
});

test('O87 connection-error: UND_ERR_CONNECT_TIMEOUT + proxy → proxy tunnel hint', async () => {
  const prev = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
  };
  process.env.HTTPS_PROXY = 'http://127.0.0.1:18080';
  delete process.env.HTTP_PROXY;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const e = new TypeError('fetch failed');
    e.cause = {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
      message: 'Connect Timeout Error',
    };
    throw e;
  };
  try {
    const { fetchWithConnectionContext } = await import('../dist/provider/connection-error.js');
    await fetchWithConnectionContext('https://ai-api.example.invalid/v1/x', { method: 'GET' });
    assert.fail('should throw');
  } catch (err) {
    assert.match(err.message, /UND_ERR_CONNECT_TIMEOUT/);
    assert.match(err.hint, /HTTPS_PROXY|proxy tunnel|connectTimeout/i);
    assert.doesNotMatch(err.hint, MODEL_COACH);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/**
 * Negative fixture: CONNECT returns 200 Connection Established, then TLS bytes
 * are never forwarded (blackhole). Asserts network/proxy copy + full cause,
 * never timeoutSlow / auth / empty 网关原文：).
 */
test('O87 fixture: CONNECT then blackhole → network fail with cause, not timeout/auth', async () => {
  const log = [];
  const sockets = new Set();
  const proxy = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.once('data', (buf) => {
      const first = buf.toString('latin1').split('\r\n')[0];
      log.push(first);
      if (/^CONNECT\b/i.test(first)) {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Blackhole after CONNECT — never complete TLS.
        sock.on('data', () => {});
        return;
      }
      sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const { port } = proxy.address();
  const proxyUrl = `http://127.0.0.1:${port}`;

  const childCode = `
    process.env.HTTPS_PROXY = ${JSON.stringify(proxyUrl)};
    process.env.HTTP_PROXY = ${JSON.stringify(proxyUrl)};
    process.env.MOSS_CONNECT_TIMEOUT_MS = '1500';
    process.env.MOSS_DISABLE_CONN_WARMUP = '1';
    for (const k of ['NODE_USE_ENV_PROXY', 'NO_PROXY', 'no_proxy', 'https_proxy', 'http_proxy'])
      delete process.env[k];
    const { fetchWithConnectionContext } = await import('./dist/provider/connection-error.js');
    const { classifyProviderError, renderProviderErrorSurface } = await import(
      './dist/provider/error-classify.js'
    );
    try {
      await fetchWithConnectionContext('https://o87-blackhole.example.invalid/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      console.error('UNEXPECTED_OK');
      process.exit(2);
    } catch (err) {
      const message = err?.hint ? \`\${err.message}\\n\${err.hint}\` : String(err?.message ?? err);
      const surface = classifyProviderError({ errorMessage: message, locale: 'zh_CN.UTF-8' });
      const text = renderProviderErrorSurface(surface);
      console.log(JSON.stringify({
        category: surface.category,
        text,
        message,
        hint: err?.hint ?? null,
      }));
      process.exit(0);
    }
  `;

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });

  for (const s of sockets) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => proxy.close(r));

  assert.equal(result.code, 0, `child failed: ${result.stderr || result.stdout}`);
  assert.ok(
    log.some((l) => l.startsWith('CONNECT o87-blackhole.example.invalid:443')),
    `proxy must see CONNECT; log=${JSON.stringify(log)}`
  );
  const payload = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(payload.category, 'network', payload);
  assert.doesNotMatch(payload.text, MODEL_COACH);
  assert.doesNotMatch(payload.text, AUTH_COPY);
  assert.doesNotMatch(payload.text, /网关原文：\s*\)/);
  assert.match(
    `${payload.message}\n${payload.hint ?? ''}\n${payload.text}`,
    /UND_ERR_CONNECT_TIMEOUT|connectTimeout|HTTPS_PROXY|代理|网络连接失败|Timed out connecting/i
  );
});

/**
 * Positive fixture: CONNECT + full TLS/HTTP reverse proxy to a local https
 * origin is heavy; instead serve HTTP via a CONNECT-capable path is not
 * typical for HTTPS_PROXY. Positive control: same proxy forwards CONNECT to a
 * tiny TLS-less echo is unreliable with undici HTTPS. We assert the happy
 * path at classify/dispatcher unit level above; board e2e is UX-owned.
 */
test('O87 positive: working local HTTP origin without proxy still succeeds', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const prevProxy = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    https_proxy: process.env.https_proxy,
    http_proxy: process.env.http_proxy,
  };
  for (const k of Object.keys(prevProxy)) delete process.env[k];
  try {
    const { fetchWithConnectionContext } = await import('../dist/provider/connection-error.js');
    const res = await fetchWithConnectionContext(`http://127.0.0.1:${port}/v1/x`, {
      method: 'GET',
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
  } finally {
    for (const [k, v] of Object.entries(prevProxy)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
  }
});

test('O87 board H3: skip eager rdk-docs warm when HTTPS_PROXY is set', async () => {
  const { shouldEagerWarmRdkDocs } = await import('../dist/cli/rdk-docs-mcp.js');
  assert.equal(shouldEagerWarmRdkDocs({}), true);
  assert.equal(shouldEagerWarmRdkDocs({ HTTPS_PROXY: 'http://127.0.0.1:18080' }), false);
  assert.equal(shouldEagerWarmRdkDocs({ https_proxy: 'http://127.0.0.1:18080' }), false);
  assert.equal(shouldEagerWarmRdkDocs({ HTTP_PROXY: 'http://127.0.0.1:9' }), false);
  // Opt-out of docs is orthogonal; warm policy is purely proxy-env.
  assert.equal(
    shouldEagerWarmRdkDocs({ HTTPS_PROXY: 'http://127.0.0.1:18080', MOSS_NO_RDK_DOCS: '1' }),
    false
  );
});

console.log('[PASS] o87-connect-without-answer');
