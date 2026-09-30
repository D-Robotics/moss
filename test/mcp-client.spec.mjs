#!/usr/bin/env node
/**
 * mcp-client — v0.16-S1/S2 MCP client (stdio + streamable HTTP, lazy tools).
 *
 * Real connections, real calls (no mocks):
 *  (1) stdio end-to-end: connect a real child MCP server (50 tools), list via
 *      the `mcp__<server>__search` meta-tool, call a tool by name, verify the
 *      lazy schema upgrade (loose {type:'object'} → real schema after 1st call);
 *  (2) lazy-load budget: the MCP prompt index layer stays under 2000 chars
 *      (< 500 tokens at chars/4) for a 50-tool server — schemas never enter
 *      the system prompt;
 *  (3) request timeout: a slow server tool rejects via Promise.race timeout
 *      and the late response is discarded without breaking the connection;
 *  (4) streamable HTTP: real node:http fixture — tools/list + tools/call,
 *      SSE-streamed response parsing, JSON-RPC error mapping, mcp-session-id
 *      round-trip;
 *  (5) config loading: dual-dir merge (.moss/mcp.json over <configDir>/mcp.json),
 *      ${ENV_VAR} expansion (missing var → empty), secrets never printed;
 *  (6) degraded connect: unknown command → failed status, no throw, closeAll
 *      stays clean.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { McpToolRegistry, buildMcpPromptLayer } from '../dist/core/mcp/registry.js';
import { loadMcpConfigs } from '../dist/cli/mcp-config.js';
import { startMcpHttpFixture } from './fixtures/mcp-http-server.mjs';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');
const stdioServerPath = path.join(fixturesDir, 'mcp-stdio-server.mjs');
const ctx = (signal) => ({
  workspaceDir: process.cwd(),
  sessionKey: 'mcp-client-spec',
  ...(signal ? { abortSignal: signal } : {}),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. stdio end-to-end: connect → search (lazy index) → call by name ─────
const stdioRegistered = new Map();
const stdioRegistry = await McpToolRegistry.connectAll(
  [
    {
      name: 'fixture-stdio',
      transport: 'stdio',
      command: process.execPath,
      args: [stdioServerPath],
    },
  ],
  { registerTool: (tool) => stdioRegistered.set(tool.name, tool) }
);

{
  const statuses = stdioRegistry.getStatuses();
  assert.equal(statuses.length, 1, 'one server status entry');
  assert.equal(statuses[0].name, 'fixture-stdio');
  assert.equal(statuses[0].state, 'connected', `stdio connect, got ${statuses[0].state}`);
  assert.equal(statuses[0].toolCount, 50, 'connect primes tools/list cache: 50 tools');

  const searchTool = stdioRegistry.getTools().find((t) => t.name === 'mcp__fixture-stdio__search');
  assert.ok(searchTool, 'search meta-tool is registered for the server');
  assert.equal(searchTool.metadata?.sideEffectClass, 'readonly', 'search is readonly');

  const listing = await searchTool.execute({}, ctx());
  assert.match(listing, /tool_00/, 'search lists tool_00');
  assert.match(listing, /tool_49/, 'search lists tool_49');
  const listedCount = [...listing.matchAll(/^- mcp__fixture-stdio__tool_\d+:/gm)].length;
  assert.equal(listedCount, 50, `search lists all 50 tools, got ${listedCount}`);
  assert.ok(!/"type"\s*:\s*"string"/.test(listing), 'search output carries no input schemas');

  // Lazy registration: search made the real tools callable by name.
  const echoTool = stdioRegistered.get('mcp__fixture-stdio__tool_07');
  assert.ok(echoTool, 'real tool registered on demand by search');
  assert.deepEqual(
    echoTool.inputSchema,
    { type: 'object', properties: {} },
    'real tool starts with the loose schema'
  );
  assert.equal(
    echoTool.metadata?.sideEffectClass,
    undefined,
    'real tool declares no side-effect class (approval path)'
  );

  const callOut = await echoTool.execute({ value: 'moss-stdio-roundtrip' }, ctx());
  assert.match(callOut, /tool_07/, 'echo result names the called tool');
  assert.match(callOut, /moss-stdio-roundtrip/, 'echo result carries the argument value');
  assert.equal(
    echoTool.inputSchema?.properties?.value?.type,
    'string',
    'schema upgraded to the real server schema after the first call'
  );

  // Query filter narrows the listing (and registers only the matches).
  const filtered = await searchTool.execute({ query: 'tool_4' }, ctx());
  const filteredCount = [...filtered.matchAll(/^- mcp__fixture-stdio__tool_\d+:/gm)].length;
  assert.equal(filteredCount, 10, `query filter narrows to tool_4x, got ${filteredCount}`);
  assert.doesNotMatch(filtered, /mcp__fixture-stdio__tool_07:/, 'non-matching tools excluded');
}

// ─── 2. lazy-load budget: prompt index layer stays tiny for 50 tools ───────
{
  const layer = buildMcpPromptLayer(stdioRegistry);
  assert.ok(layer.length > 0, 'layer is non-empty');
  assert.ok(
    layer.length < 2000,
    `MCP prompt layer under 2000 chars for a 50-tool server (got ${layer.length} ≈ ${Math.round(layer.length / 4)} tokens)`
  );
  assert.ok(!layer.includes('tool_25'), 'no per-tool lines leak into the system prompt');
  assert.ok(layer.includes('mcp__fixture-stdio__search'), 'layer points at the search meta-tool');
  console.log(
    `  [budget] MCP prompt layer: ${layer.length} chars ≈ ${Math.round(layer.length / 4)} tokens for a 50-tool server`
  );
}

// ─── 3. request timeout + late-response discard (stdio) ────────────────────
{
  const registry = await McpToolRegistry.connectAll(
    [
      {
        name: 'fixture-slow',
        transport: 'stdio',
        command: process.execPath,
        args: [stdioServerPath],
      },
    ],
    { requestTimeoutMs: 300, registerTool: (tool) => stdioRegistered.set(tool.name, tool) }
  );
  assert.equal(registry.getStatuses()[0].state, 'connected');
  await registry.getTools()[0].execute({}, ctx()); // search registers tool_49
  const slowTool = stdioRegistered.get('mcp__fixture-slow__tool_49');
  assert.ok(slowTool, 'slow tool registered');
  await assert.rejects(
    () => slowTool.execute({ value: 'never-arrives-in-time' }, ctx()),
    (err) => /timed out|timeout/i.test(String(err?.message ?? err)),
    'slow tool call rejects with a timeout'
  );
  await sleep(600); // let the late tool_49 response arrive → must be discarded
  const afterTool = stdioRegistered.get('mcp__fixture-slow__tool_03');
  const after = await afterTool.execute({ value: 'still-alive' }, ctx());
  assert.match(after, /still-alive/, 'connection still usable after a timed-out request');
  await registry.closeAll();
}

// ─── 4. streamable HTTP: tools/list + tools/call + session id round-trip ───
{
  const { server, port, state } = await startMcpHttpFixture();
  const httpRegistered = new Map();
  const httpRegistry = await McpToolRegistry.connectAll(
    [{ name: 'fixture-http', transport: 'http', url: `http://127.0.0.1:${port}/mcp` }],
    { registerTool: (tool) => httpRegistered.set(tool.name, tool) }
  );
  assert.equal(httpRegistry.getStatuses()[0].state, 'connected', 'http connect');

  const search = httpRegistry.getTools().find((t) => t.name === 'mcp__fixture-http__search');
  const listing = await search.execute({}, ctx());
  assert.match(listing, /echo/, 'http search lists echo');
  assert.match(listing, /ping/, 'http search lists ping');

  // echo responds over an SSE stream — exercises event-stream parsing.
  const echoTool = httpRegistered.get('mcp__fixture-http__echo');
  assert.ok(echoTool, 'echo tool registered on demand');
  const echoOut = await echoTool.execute({ value: 'http-roundtrip' }, ctx());
  assert.match(echoOut, /echo\(echo\):http-roundtrip/, 'SSE response parsed and returned');

  const pingOut = await httpRegistered.get('mcp__fixture-http__ping').execute({}, ctx());
  assert.match(pingOut, /pong/, 'plain JSON tools/call works');

  await assert.rejects(
    () => httpRegistered.get('mcp__fixture-http__fail_tool').execute({}, ctx()),
    /fixture failure: boom/,
    'JSON-RPC error maps to a rejected tool call'
  );

  assert.equal(state.initializeCount, 1, 'single initialize for the whole sequence');
  assert.equal(
    state.sessionHeaderOnList,
    'sess-moss-spec-1',
    'mcp-session-id from initialize is sent back on tools/list'
  );
  assert.equal(
    state.sessionHeaderOnCall,
    'sess-moss-spec-1',
    'mcp-session-id from initialize is sent back on tools/call'
  );
  assert.deepEqual(
    state.requestsWithoutSession,
    [],
    'no request after initialize missed the session header'
  );

  await httpRegistry.closeAll();
  await new Promise((resolve) => server.close(resolve));
}

// ─── 5. config loading: dual-dir merge, ${ENV_VAR} expansion, no secret log ─
{
  const tmp = fs.mkdtempSync(path.join(process.cwd(), '.mcp-spec-config-'));
  const workspaceDir = path.join(tmp, 'workspace');
  const configDir = path.join(tmp, 'config');
  fs.mkdirSync(path.join(workspaceDir, '.moss'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  let blockFixtureServer = null;
  let blockFixtureState = null;
  const { port } = await (async () => {
    const fx = await startMcpHttpFixture();
    // keep server for the connect check below; close it at the end of the block
    blockFixtureServer = fx.server;
    blockFixtureState = fx.state;
    return fx;
  })();

  process.env.MCP_SPEC_SECRET_TOKEN = 'spec-secret-token-do-not-print';
  fs.writeFileSync(
    path.join(workspaceDir, '.moss', 'mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          'fixture-http': {
            transport: 'http',
            url: 'http://127.0.0.1:${MCP_SPEC_PORT}/mcp',
            headers: {
              Authorization: 'Bearer ${MCP_SPEC_SECRET_TOKEN}',
              'X-Missing': '${MCP_SPEC_MISSING_VAR_42}',
            },
          },
          shared: { transport: 'stdio', command: 'workspace-wins' },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(configDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'user-level': { transport: 'stdio', command: 'user-level-cmd', args: ['--flag'] },
        shared: { transport: 'stdio', command: 'user-level-shadowed' },
      },
    })
  );

  const captured = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origStdout(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origStderr(chunk, ...rest);
  };

  let configs;
  let secretRegistry;
  const secretEcho = new Map();
  try {
    process.env.MCP_SPEC_PORT = String(port);
    configs = loadMcpConfigs(workspaceDir, configDir);

    const names = configs.map((c) => c.name).sort();
    assert.deepEqual(
      names,
      ['fixture-http', 'shared', 'user-level'],
      'both dirs merge; distinct servers coexist'
    );
    const shared = configs.find((c) => c.name === 'shared');
    assert.equal(
      shared.command,
      'workspace-wins',
      'workspace .moss/mcp.json shadows configDir on name clash'
    );

    const http = configs.find((c) => c.name === 'fixture-http');
    assert.equal(http.url, `http://127.0.0.1:${port}/mcp`, '${VAR} expanded in url');
    assert.equal(
      http.headers.Authorization,
      'Bearer spec-secret-token-do-not-print',
      '${VAR} expanded in header values'
    );
    assert.equal(http.headers['X-Missing'], '', 'missing env var expands to empty string');

    // Real connect with the expanded credential header — the server must see
    // it, and the secret must never appear in any output.
    secretRegistry = await McpToolRegistry.connectAll([http], {
      registerTool: (t) => secretEcho.set(t.name, t),
    });
    await secretRegistry.getTools()[0].execute({}, ctx());
    const echoOut2 = await secretEcho
      .get('mcp__fixture-http__echo')
      .execute({ value: 'auth-check' }, ctx());
    assert.match(echoOut2, /auth-check/, 'auth-header connection still calls tools');
    assert.equal(
      blockFixtureState.authHeaderOnCall,
      'Bearer spec-secret-token-do-not-print',
      'expanded credential header actually reached the server'
    );
    assert.equal(
      secretRegistry.getStatuses()[0].state,
      'connected',
      'server with credential header connected'
    );
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    await secretRegistry?.closeAll();
    await new Promise((resolve) => blockFixtureServer?.close(resolve));
  }

  const allOutput = captured.join('');
  assert.ok(
    !allOutput.includes('spec-secret-token-do-not-print'),
    'secret token never appears in stdout/stderr output'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ─── 6. degraded connect: unknown command → failed status, no throw ────────
{
  let registry;
  await assert.doesNotReject(
    async () => {
      registry = await McpToolRegistry.connectAll([
        {
          name: 'ghost',
          transport: 'stdio',
          command: 'moss-spec-definitely-missing-cmd',
          args: [],
        },
      ]);
    },
    undefined,
    'connectAll degrades instead of throwing on an unknown command'
  );
  const status = registry.getStatuses()[0];
  assert.equal(status.state, 'failed', 'ghost server reports failed');
  assert.ok(status.error && status.error.length > 0, 'failure carries a reason');
  assert.equal(registry.getTools().length, 0, 'no tools registered for the failed server');
  assert.equal(
    buildMcpPromptLayer(registry).includes('ghost'),
    false,
    'failed server absent from prompt layer'
  );
  await assert.doesNotReject(
    () => registry.closeAll(),
    undefined,
    'closeAll stays clean after failure'
  );
}

// ─── 7. closeAll shuts the stdio child down ────────────────────────────────
{
  await stdioRegistry.closeAll();
  const status = stdioRegistry.getStatuses()[0];
  assert.equal(status.state, 'closed', `stdio server closed, got ${status.state}`);
}

console.log(
  '  [PASS] mcp-client: stdio + streamable HTTP transports, lazy tool loading, config merge'
);
