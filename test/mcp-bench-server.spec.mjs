#!/usr/bin/env node
/**
 * Contract of the capability-mcp-ledger bench fixture
 * (test/fixtures/mcp-bench-server.mjs).
 *
 * bench/tasks/capability-mcp-ledger/files/check-goal.mjs accepts a sample only
 * when checksum.txt equals sha256("<nonce>|ORD-4771") AND the request log
 * shows a real ledger_lookup call — so the fixture's checksum derivation, its
 * request logging and its catalog shape are load-bearing for the bench and
 * locked here. The spec drives the fixture through the real dist McpClient
 * (stdio), the same wire the CLI uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../dist/core/mcp/client.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'mcp-bench-server.mjs'
);

const NONCE = 'spec-nonce-0123456789abcdef';

async function withServer(run) {
  const logPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'moss-mcp-bench-spec-')),
    'calls.jsonl'
  );
  const client = new McpClient(
    {
      name: 'warehouse',
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      env: { MOSS_MCP_BENCH_NONCE: NONCE, MOSS_MCP_BENCH_LOG: logPath },
    },
    { connectTimeoutMs: 10_000, requestTimeoutMs: 10_000 }
  );
  await client.connect();
  try {
    await run(client, logPath);
  } finally {
    await client.close();
    fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  }
}

test('catalog: three distinct tools, ledger_lookup carries the checksum contract', async () => {
  await withServer(async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'inventory_count',
      'ledger_lookup',
      'shipping_eta',
    ]);
    const ledger = tools.find((t) => t.name === 'ledger_lookup');
    assert.match(ledger.description, /warehouse ledger/);
    assert.match(ledger.description, /verification checksum/);
    assert.deepEqual(ledger.inputSchema.required, ['order']);
  });
});

test('ledger_lookup returns sha256(nonce|order), exactly what check-goal.mjs expects', async () => {
  await withServer(async (client) => {
    const result = await client.callTool('ledger_lookup', { order: 'ORD-4771' });
    assert.equal(result.isError, false);
    const expected = createHash('sha256')
      .update(NONCE + '|ORD-4771', 'utf8')
      .digest('hex');
    assert.equal(result.content[0].text, expected);
  });
});

test('ledger_lookup rejects a missing order instead of deriving a bogus checksum', async () => {
  await withServer(async (client) => {
    const result = await client.callTool('ledger_lookup', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /order/);
  });
});

test('every tools/call lands in the request log with tool name and arguments', async () => {
  await withServer(async (client, logPath) => {
    await client.callTool('ledger_lookup', { order: 'ORD-4771' });
    await client.callTool('inventory_count', { sku: 'SKU-1' });
    const entries = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const calls = entries.filter((e) => e.method === 'tools/call');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].tool, 'ledger_lookup');
    assert.equal(calls[0].arguments.order, 'ORD-4771');
    assert.equal(calls[1].tool, 'inventory_count');
  });
});
