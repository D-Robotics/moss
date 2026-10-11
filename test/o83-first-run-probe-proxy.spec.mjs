#!/usr/bin/env node
/**
 * O83: first-run connection probe and model-list fetch must go through
 * HTTPS_PROXY (NODE_USE_ENV_PROXY unset). Asserts on PROXY RECEIPT (a CONNECT
 * for the *target model host* in the fake proxy's log), not on request success.
 * CONNECT to npm/registry alone is NOT a PASS — each check matches the exact
 * host from the probe/catalog baseUrl (same lock as UX o83-firstrun-proxy.sh).
 * Runs each probe in a child process so the global dispatcher starts clean.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every check runs; failures are listed together at the end.
const failures = [];
function check(fn, ...args) {
  try {
    fn(...args);
    console.log(`[ok] ${args.at(-1)}`.split(';')[0]);
  } catch (err) {
    failures.push(String(err.message).split('\n')[0]);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
const proxy = net.createServer((sock) => {
  sock.once('data', (buf) => {
    log.push(buf.toString('latin1').split('\r\n')[0]);
    sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  sock.on('error', () => {});
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

function runChild(code, extraEnv = {}) {
  const env = { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl };
  for (const k of [
    'NODE_USE_ENV_PROXY',
    'NO_PROXY',
    'no_proxy',
    'https_proxy',
    'http_proxy',
    'MOSS_DISABLE_CONN_WARMUP',
  ])
    delete env[k];
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    const t = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const probeHost = 'o83-probe.example.invalid';
await runChild(`
  const { probeModel } = await import('./dist/cli/connection-probe.js');
  await probeModel({ provider: 'deepseek', baseUrl: 'https://${probeHost}', apiKey: 'sk-o83-fake', model: 'm', timeoutMs: 5000 });
`);
check(
  assert.ok,
  log.some((l) => l.startsWith(`CONNECT ${probeHost}:443`)),
  `probeModel target host ${probeHost} must CONNECT via HTTPS_PROXY (npm CONNECT alone != PASS); proxy log: ${JSON.stringify(log)}`
);

const catalogHost = 'o83-models.example.invalid';
await runChild(`
  const { loadModelChoicesForRuntime } = await import('./dist/cli/model-catalog.js');
  await loadModelChoicesForRuntime({ provider: 'openai-compatible', baseUrl: 'https://${catalogHost}', apiKey: 'sk-o83-fake' }, '', { timeoutMs: 5000 });
`);
check(
  assert.ok,
  log.some((l) => l.startsWith(`CONNECT ${catalogHost}:443`)),
  `model-list target host ${catalogHost} must CONNECT via HTTPS_PROXY (npm CONNECT alone != PASS); proxy log: ${JSON.stringify(log)}`
);

// A subcommand that never enters the agent loop: `moss doctor` (keyless
// search reachability check hits www.bing.com).
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'o83-doctor-'));
  await runChild(`
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, ['dist/cli.js', 'doctor'], {
      env: { ...process.env, HOME: ${JSON.stringify(home)}, MOSS_CONFIG_DIR: ${JSON.stringify(path.join(home, 'cfg'))}, MOSS_NO_RDK_DOCS: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
  `);
  fs.rmSync(home, { recursive: true, force: true });
  check(
    assert.ok,
    log.some((l) => l.startsWith('CONNECT www.bing.com:443')),
    `moss doctor requests must reach HTTPS_PROXY; proxy log: ${JSON.stringify(log)}`
  );
}

// NO_PROXY: a localhost model server is reached directly, never via the proxy.
{
  const http = await import('node:http');
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const probeVia = (host) =>
    runChild(
      `
      const { probeModel } = await import('./dist/cli/connection-probe.js');
      await probeModel({ provider: 'openai-compatible', baseUrl: 'http://${host}:${port}', apiKey: 'sk-o83-fake', model: 'm', timeoutMs: 5000 });
    `,
      { NO_PROXY: 'localhost' }
    );
  const viaProxy = () => log.filter((l) => l.includes(`:${port}`));

  await probeVia('localhost');
  check(assert.ok, hits.length > 0, 'localhost model server received the probe directly');
  check(assert.deepEqual, viaProxy(), [], `NO_PROXY=localhost: proxy must not see :${port}`);

  // 127.0.0.1 with NO_PROXY=localhost: loopback is always direct (O83).
  const before = hits.length;
  log.length = 0;
  await probeVia('127.0.0.1');
  check(assert.ok, hits.length > before, '127.0.0.1 model server received the probe directly');
  check(assert.deepEqual, viaProxy(), [], 'NO_PROXY=localhost: proxy must not see 127.0.0.1');
  server.close();
}

proxy.close();
if (failures.length) {
  console.error(`[FAIL] o83:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('[PASS] o83 first-run probe uses HTTPS_PROXY');
