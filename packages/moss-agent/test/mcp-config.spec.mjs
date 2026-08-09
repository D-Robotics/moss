#!/usr/bin/env node
/**
 * MCP client — config loading + child-env sanitization (pure functions).
 *
 * The MCP client had zero tests. These cover the pure, non-subprocess parts:
 *  (1) `safeMcpChildEnv` — the strict allowlist that filters the parent env
 *      before spawning an MCP server child (secrets must NOT leak to the child
 *      unless explicitly overridden);
 *  (2) `loadMcpConfig` / `loadMcpConfigWithDiagnostics` — mcp.json parsing +
 *      per-server validation (the `processBuffer`/`mcpToolToTool` paths need a
 *      mock subprocess and are a follow-up).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeMcpChildEnv } from '../dist/utils/safe-child-env.js';
import { loadMcpConfig, loadMcpConfigWithDiagnostics } from '../dist/mcp/mcp-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-mcp-test-'));
}

async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj), 'utf-8');
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── 1. safeMcpChildEnv: dangerous keys filtered, allowlist kept ───────────
{
  withEnv(
    {
      MOSS_TEST_API_KEY: 'sk-leak',
      MOSS_TEST_TOKEN: 'tok-leak',
      MY_PASSWORD: 'pw-leak',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
    },
    () => {
      const env = safeMcpChildEnv();
      // Dangerous keys (matching the *_API_KEY / *_TOKEN / *PASSWORD patterns)
      // are filtered out — they must not reach the MCP child by default.
      assert.equal(env.MOSS_TEST_API_KEY, undefined, 'API_KEY filtered from child env');
      assert.equal(env.MOSS_TEST_TOKEN, undefined, 'TOKEN filtered from child env');
      assert.equal(env.MY_PASSWORD, undefined, 'PASSWORD filtered from child env');
      // Allowlisted keys are passed through. On Windows, env var keys are
      // case-insensitive in process.env but the resulting plain object uses the
      // OS's casing (e.g. 'Path' not 'PATH'), so check both.
      assert.ok(env.PATH ?? env.Path, 'PATH kept (allowlisted)');
      assert.ok(env.HOME ?? env.Home, 'HOME kept (allowlisted)');
    }
  );
}

// ─── 2. safeMcpChildEnv: overrides are applied verbatim ────────────────────
{
  const env = safeMcpChildEnv({ MY_CUSTOM_VAR: 'value', MOSS_TEST_API_KEY: 'explicit-override' });
  assert.equal(env.MY_CUSTOM_VAR, 'value', 'custom override applied');
  // An override CAN re-introduce a dangerous key — this is the intended escape
  // hatch (the host explicitly passes a key the MCP server needs).
  assert.equal(
    env.MOSS_TEST_API_KEY,
    'explicit-override',
    'override re-introduces a dangerous key (intentional)'
  );
}

// ─── 3. loadMcpConfig: valid config parses ─────────────────────────────────
{
  const dir = await makeTempDir();
  const cfgPath = path.join(dir, 'mcp.json');
  await writeJson(cfgPath, {
    mcpServers: {
      'server-a': { command: 'node', args: ['a.js'], cwd: dir },
      'server-b': { command: 'python3', args: ['-m', 'b'] },
    },
  });
  const config = loadMcpConfig(cfgPath);
  assert.ok(config, 'valid config loads');
  assert.ok(config.mcpServers['server-a'], 'server-a present');
  assert.deepEqual(config.mcpServers['server-a'].args, ['a.js'], 'args parsed');
  assert.equal(config.mcpServers['server-b'].command, 'python3', 'server-b command');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 4. loadMcpConfigWithDiagnostics: missing file ─────────────────────────
{
  const dir = await makeTempDir();
  const result = loadMcpConfigWithDiagnostics(path.join(dir, 'nope.json'));
  assert.equal(result.config, null, 'missing file → null config');
  assert.ok(result.diagnostics.length > 0, 'missing file → diagnostics');
  assert.match(result.diagnostics[0].message, /does not exist/i, 'diagnostic message');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 5. malformed JSON ──────────────────────────────────────────────────────
{
  const dir = await makeTempDir();
  const cfgPath = path.join(dir, 'mcp.json');
  await fs.writeFile(cfgPath, '{not valid json', 'utf-8');
  const result = loadMcpConfigWithDiagnostics(cfgPath);
  assert.equal(result.config, null, 'malformed JSON → null config');
  assert.ok(result.diagnostics.length > 0, 'malformed JSON → diagnostics');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 6. mcpServers not an object / root not an object ──────────────────────
{
  const dir = await makeTempDir();
  const cfgPath = path.join(dir, 'mcp.json');
  await writeJson(cfgPath, { mcpServers: ['not', 'an', 'object'] });
  assert.equal(loadMcpConfig(cfgPath), null, 'mcpServers as array → null');
  await fs.writeFile(cfgPath, '42', 'utf-8');
  assert.equal(loadMcpConfig(cfgPath), null, 'non-object root → null');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 7. server with missing/empty command → diagnostics ───────────────────
{
  const dir = await makeTempDir();
  const cfgPath = path.join(dir, 'mcp.json');
  await writeJson(cfgPath, {
    mcpServers: {
      good: { command: 'node' },
      bad: { command: '' }, // empty command
      bad2: { cwd: '/x' }, // missing command
    },
  });
  const result = loadMcpConfigWithDiagnostics(cfgPath);
  assert.equal(result.config, null, 'any invalid server → null config');
  assert.ok(result.diagnostics.length >= 2, 'each invalid server produces a diagnostic');
  const names = result.diagnostics.map((d) => d.serverName).sort();
  assert.deepEqual(names, ['bad', 'bad2'], 'diagnostics name the failing servers');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 8. invalid requestTimeoutMs ───────────────────────────────────────────
{
  const dir = await makeTempDir();
  const cfgPath = path.join(dir, 'mcp.json');
  await writeJson(cfgPath, {
    mcpServers: { s: { command: 'node', requestTimeoutMs: -5 } },
  });
  const result = loadMcpConfigWithDiagnostics(cfgPath);
  assert.equal(result.config, null, 'negative timeout → null');
  assert.match(
    result.diagnostics[0].message,
    /requestTimeoutMs/i,
    'diagnostic mentions requestTimeoutMs'
  );
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 9. valid requestTimeoutMs is preserved ───────────────────────────────
{
  const dir = await makeTempDir();
  const cfgPath = path.join(dir, 'mcp.json');
  await writeJson(cfgPath, {
    mcpServers: { s: { command: 'node', requestTimeoutMs: 45000 } },
  });
  const config = loadMcpConfig(cfgPath);
  assert.equal(config.mcpServers.s.requestTimeoutMs, 45000, 'valid timeout preserved');
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('  [PASS] mcp-config: safeMcpChildEnv filtering + loadMcpConfig parsing');
