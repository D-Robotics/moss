#!/usr/bin/env node
/**
 * The MCP initialize handshake must advertise the real package version.
 *
 * Regression: clientInfo was pinned to '0.16.0', so every MCP server was told a
 * version that stopped being true several releases earlier. This asserts the
 * value that actually goes over the wire, against package.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
const fixture = path.join(process.cwd(), 'test', 'fixtures', 'mcp-client-info-server.mjs');

test('initialize advertises the package version, not a pinned literal', async (t) => {
  const registered = new Map();
  const registry = await McpToolRegistry.connectAll(
    [
      {
        name: 'client-info',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
      },
    ],
    { registerTool: (tool) => registered.set(tool.name, tool) }
  );
  t.after(() => registry.closeAll?.());

  const status = registry.getStatuses()[0];
  assert.equal(status.state, 'connected', `fixture server connected, got ${status.state}`);

  // Real tools register lazily: the meta search tool reveals them (by design).
  const searchTool = registry.getTools().find((t) => t.name === 'mcp__client-info__search');
  assert.ok(searchTool, 'search meta-tool is registered for the server');
  await searchTool.execute({}, { workspaceDir: process.cwd(), sessionKey: 'mcp-version' });

  const tool = registered.get('mcp__client-info__report_client');
  assert.ok(tool, 'report_client tool was registered after the search');
  const out = await tool.execute({}, { workspaceDir: process.cwd(), sessionKey: 'mcp-version' });
  assert.match(out, /"name":"moss"/);
  assert.ok(
    out.includes(`"version":"${pkg.version}"`),
    `handshake must carry package.json version ${pkg.version}, got: ${out}`
  );
  assert.ok(!out.includes('0.16.0'), 'the pinned literal must be gone from the wire');
});
