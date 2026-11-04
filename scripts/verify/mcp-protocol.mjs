#!/usr/bin/env node
/**
 * D4 protocol probe — resources / prompts round-trip against a local mock stdio
 * server, through both the real McpClient and `moss mcp test`.
 *
 * No network: the fixture is scripts/verify/fixtures/mcp-mock-server.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(root, 'scripts/verify/fixtures/mcp-mock-server.mjs');
const cli = path.join(root, 'dist/cli.js');
const { McpClient } = await import(pathToFileURL(path.join(root, 'dist/core/mcp/client.js')).href);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proto-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proto-ws-'));
fs.mkdirSync(path.join(home, '.config/moss'), { recursive: true });
fs.mkdirSync(path.join(ws, '.moss'), { recursive: true });
const server = { transport: 'stdio', command: process.execPath, args: [fixture] };
fs.writeFileSync(
  path.join(ws, '.moss/mcp.json'),
  JSON.stringify({ mcpServers: { mock: server } }, null, 2)
);

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const config = { name: 'mock', ...server };
let client;
try {
  client = new McpClient(config, { connectTimeoutMs: 10_000, requestTimeoutMs: 10_000 });
  await client.connect();

  await check('tools/list reaches the server', async () => {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['mock_echo']
    );
  });
  await check('resources/list + resources/read round-trip', async () => {
    const resources = await client.listResources();
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, 'mock://doc/one');
    const read = await client.readResource('mock://doc/one');
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].text, 'mock resource content');
  });
  await check('prompts/list + prompts/get round-trip with arguments', async () => {
    const prompts = await client.listPrompts();
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].name, 'greet');
    const prompt = await client.getPrompt('greet', { who: 'moss' });
    assert.equal(prompt.messages.length, 1);
    const content = Array.isArray(prompt.messages[0].content)
      ? prompt.messages[0].content[0]
      : prompt.messages[0].content;
    assert.equal(content.text, 'Hello moss');
  });
  await check('an unknown resource is a protocol error, not silent empty text', async () => {
    await assert.rejects(() => client.readResource('mock://missing'));
    await client.listResources({ refresh: true });
  });
  await check('the client survives a method-not-found capabilities answer', async () => {
    // The mock answers unknown methods with -32601; a server without prompts
    // must not look like a connection failure.
    assert.equal(client.transport.state, 'connected');
  });
} catch (err) {
  checks.push(`FAIL setup: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await client?.close().catch(() => undefined);
}

// `moss mcp test` must now report tools, resources and prompts.
await check('moss mcp test lists tools, resources and prompts', async () => {
  const result = await captureProcess(process.execPath, [cli, 'mcp', 'test', 'mock'], {
    cwd: ws,
    env: {
      ...process.env,
      HOME: home,
      MOSS_LANG: 'en',
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
    },
    timeoutMs: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /1 tool\(s\)/);
  assert.match(out, /mock_echo/);
  assert.match(out, /1 resource\(s\)/);
  assert.match(out, /mock:\/\/doc\/one/);
  assert.match(out, /1 prompt\(s\)/);
  assert.match(out, /greet/);
});

for (const line of checks) console.log(`[mcp-protocol] ${line}`);
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[mcp-protocol] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[mcp-protocol] ${checks.length} checks passed`);
