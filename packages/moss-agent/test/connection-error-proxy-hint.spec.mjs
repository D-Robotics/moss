#!/usr/bin/env node
/**
 * fetchWithConnectionContext — proxy-tunnel refusal hint.
 *
 * When undici's EnvHttpProxyAgent (installed by keep-alive-dispatcher) hits a
 * proxy that refuses the CONNECT tunnel (e.g. squid ERR_ACCESS_DENIED for a
 * host not on its allowlist), it throws a TypeError "fetch failed" whose
 * cause.cause is { name: 'AbortError', code: 'UND_ERR_ABORTED' }.
 *
 * moss previously surfaced this as a generic "check network/proxy/DNS" hint —
 * hiding that the fix is to add the host to NO_PROXY. The hint now detects
 * the UND_ERR_ABORTED + proxy-env combination and points the user at NO_PROXY.
 */
import assert from 'node:assert/strict';

// Force proxy env on for this test so the proxy-tunnel hint branch fires.
process.env.HTTP_PROXY = 'http://test-proxy:8080';
process.env.HTTPS_PROXY = 'http://test-proxy:8080';

const { fetchWithConnectionContext } = await import(
  '../dist/provider/connection-error.js'
);

// ─── 1. Proxy-tunnel refusal (UND_ERR_ABORTED) → NO_PROXY hint ─────────────
//
// We can't easily make fetch hit a real proxy refusal in unit tests, so we
// simulate by stubbing global fetch to throw the exact shape undici produces.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  const e = new TypeError('fetch failed');
  // undici's two-level cause shape: err.cause.cause is the real error.
  (e).cause = {
    name: 'TypeError',
    message: 'fetch failed',
    cause: { name: 'AbortError', code: 'UND_ERR_ABORTED' },
  };
  throw e;
};
try {
  await fetchWithConnectionContext('https://api.example.com/v1/x', {
    method: 'GET',
  });
  assert.fail('should have thrown');
} catch (err) {
  assert.ok(err.hint, 'MossError carries a hint');
  assert.ok(
    err.hint.includes('Proxy refused') || err.hint.includes('proxy'),
    `hint points at the proxy, got: ${err.hint}`,
  );
  assert.ok(
    err.hint.includes('NO_PROXY'),
    `hint mentions NO_PROXY as the fix, got: ${err.hint}`,
  );
  // The message must surface the underlying cause code so logs are diagnosable.
  assert.ok(
    err.message.includes('UND_ERR_ABORTED'),
    `message includes the cause code, got: ${err.message}`,
  );
} finally {
  globalThis.fetch = originalFetch;
}

// ─── 2. Non-proxy AbortError → NOT the proxy hint (no false positive) ──────
//
// Without proxy env, the same AbortError should fall through to a generic
// hint — we don't want to claim "proxy refused" when there's no proxy.
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
globalThis.fetch = async () => {
  const e = new TypeError('fetch failed');
  (e).cause = { name: 'TypeError', cause: { name: 'AbortError', code: 'UND_ERR_ABORTED' } };
  throw e;
};
try {
  await fetchWithConnectionContext('https://api.example.com/v1/x', { method: 'GET' });
  assert.fail('should have thrown');
} catch (err) {
  assert.ok(!err.hint.includes('NO_PROXY'),
    'no proxy env → no NO_PROXY hint (no false positive)');
} finally {
  globalThis.fetch = originalFetch;
}

// ─── 3. DNS failure (ENOTFOUND) still gives the DNS hint ───────────────────
globalThis.fetch = async () => {
  const e = new TypeError('fetch failed');
  (e).cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.example.com' };
  throw e;
};
try {
  await fetchWithConnectionContext('https://api.example.com/v1/x', { method: 'GET' });
  assert.fail('should have thrown');
} catch (err) {
  assert.ok(err.hint.includes('DNS lookup failed'),
    `DNS hint for ENOTFOUND, got: ${err.hint}`);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('  [PASS] connection-error: proxy-tunnel refusal hint + DNS + no-false-positive');
