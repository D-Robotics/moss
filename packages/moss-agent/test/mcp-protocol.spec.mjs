#!/usr/bin/env node
/**
 * MCP protocol layer — JSON-RPC 2.0 over stdin/stdout.
 *
 * Tests the full lifecycle of McpServerConnection via the public
 * connectMcpServers / connectMcpServersWithFailures API:
 *   initialize → tools/list → tool.execute (tools/call) → close
 *
 * Uses a tiny mock MCP server (Node.js script written to os.tmpdir()) so no
 * external MCP daemon is needed.  The mock supports four behaviors:
 *   normal    — respond cleanly to all requests
 *   slow-call — delay before responding to tools/call (for abort/timeout)
 *   crash     — exit(1) immediately on launch
 *   noisy     — emit non-JSON lines alongside valid JSON-RPC responses
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectMcpServers,
  connectMcpServersWithFailures,
} from '../dist/mcp/mcp-client.js';

// ─── Mock MCP server script ────────────────────────────────────────────────

const MOCK_SCRIPT = `\
import { createInterface } from 'node:readline';

const behavior = process.env.MOCK_BEHAVIOR || 'normal';
const delayMs = parseInt(process.env.MOCK_DELAY_MS || '5000', 10);

if (behavior === 'crash') process.exit(1);

if (behavior === 'noisy') {
  process.stdout.write('non-JSON garbage line\\n');
  process.stdout.write('[info] mock started\\n');
}

const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg.id === undefined || msg.id === null) continue;

  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    respond(msg.id, {
      tools: [
        { name: 'echo', description: 'Echo the input text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
      ],
    });
  } else if (msg.method === 'tools/call') {
    if (behavior === 'slow-call') {
      await new Promise(r => setTimeout(r, delayMs));
    }
    respond(msg.id, {
      content: [{ type: 'text', text: \`result: \${JSON.stringify(msg.params?.arguments ?? {})}\` }],
    });
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
  if (behavior === 'noisy') {
    process.stdout.write('extra noise after response\\n');
  }
}
`;

/** Create a temp dir, write the mock script, return { dir, scriptPath }. */
async function setupMock() {
  const dir = await mkdtemp(join(tmpdir(), 'moss-mcp-protocol-'));
  const scriptPath = join(dir, 'mock-mcp.mjs');
  await writeFile(scriptPath, MOCK_SCRIPT, 'utf-8');
  return { dir, scriptPath };
}

/** Minimal ToolContext with required fields. */
function minimalCtx(abortSignal) {
  return { workspaceDir: '/tmp', sessionKey: 'test-session', abortSignal };
}

// ─── 1. initialize + tools/list + mcpToolToTool ─────────────────────────────

{
  const { dir, scriptPath } = await setupMock();
  try {
    const connections = await connectMcpServers({
      mcpServers: {
        'test-server': { command: 'node', args: [scriptPath] },
      },
    });
    assert.equal(connections.length, 1, 'one connection returned');
    const conn = connections[0];
    assert.equal(conn.serverName, 'test-server', 'server name preserved');
    assert.equal(conn.tools.length, 2, 'two tools returned from tools/list');

    // mcpToolToTool prefixes name with serverName
    assert.equal(conn.tools[0].name, 'test-server__echo', 'tool name prefixed');
    assert.equal(conn.tools[1].name, 'test-server__add', 'second tool name prefixed');

    // Description preserved from inputSchema
    assert.ok(conn.tools[0].description.includes('Echo'), 'echo description');
    assert.ok(conn.tools[1].description.includes('Add'), 'add description');

    // inputSchema properties / required preserved
    assert.deepEqual(conn.tools[0].inputSchema.required, ['text'], 'echo required fields');
    assert.deepEqual(conn.tools[1].inputSchema.required, ['a', 'b'], 'add required fields');
    assert.equal(conn.tools[0].inputSchema.properties.text.type, 'string', 'echo text prop type');

    // metadata.sideEffectClass set to 'external_message'
    assert.equal(conn.tools[0].metadata.sideEffectClass, 'external_message');

    await conn.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  [PASS] mcp-protocol: initialize + tools/list + mcpToolToTool');
}

// ─── 2. tools/call — echo text result ───────────────────────────────────────

{
  const { dir, scriptPath } = await setupMock();
  try {
    const [conn] = await connectMcpServers({
      mcpServers: { 'test-server': { command: 'node', args: [scriptPath] } },
    });
    const tool = conn.tools[0]; // echo

    const result = await tool.execute(
      { text: 'hello world' },
      minimalCtx(new AbortController().signal),
    );
    assert.ok(typeof result === 'string', 'execute returns string');
    assert.ok(result.includes('hello world'), 'result echoes input');

    await conn.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  [PASS] mcp-protocol: tools/call echo result');
}

// ─── 3. cancel — AbortSignal during slow tools/call ─────────────────────────

{
  const { dir, scriptPath } = await setupMock();
  try {
    const [conn] = await connectMcpServers({
      mcpServers: {
        'test-server': {
          command: 'node',
          args: [scriptPath],
          env: { MOCK_BEHAVIOR: 'slow-call', MOCK_DELAY_MS: '5000' },
        },
      },
    });
    const tool = conn.tools[0];
    const ac = new AbortController();

    const abortTimer = setTimeout(() => ac.abort(), 200);
    try {
      await assert.rejects(
        tool.execute({ text: 'hello' }, minimalCtx(ac.signal)),
        /aborted/i,
        'cancel should reject with abort error',
      );
    } finally {
      clearTimeout(abortTimer);
      await conn.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  [PASS] mcp-protocol: cancel via AbortSignal');
}

// ─── 4. timeout — requestTimeoutMs exceeded on slow tools/call ──────────────

{
  const { dir, scriptPath } = await setupMock();
  try {
    const [conn] = await connectMcpServers({
      mcpServers: {
        'test-server': {
          command: 'node',
          args: [scriptPath],
          env: { MOCK_BEHAVIOR: 'slow-call', MOCK_DELAY_MS: '5000' },
          requestTimeoutMs: 800,
        },
      },
    });
    // Mock responds to initialize and listTools immediately (well under 800ms),
    // but delays 5000ms on tools/call → timeout.
    const tool = conn.tools[0];
    await assert.rejects(
      tool.execute({ text: 'timeout' }, minimalCtx(new AbortController().signal)),
      /timeout/i,
      'slow tools/call should timeout',
    );
    await conn.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  [PASS] mcp-protocol: timeout on slow request');
}

// ─── 5. crash — server exits immediately ────────────────────────────────────

{
  const { dir, scriptPath } = await setupMock();
  try {
    const result = await connectMcpServersWithFailures({
      mcpServers: {
        'crash-server': {
          command: 'node',
          args: [scriptPath],
          env: { MOCK_BEHAVIOR: 'crash' },
          requestTimeoutMs: 500,
        },
      },
    });
    assert.equal(result.connections.length, 0, 'no successful connections');
    assert.equal(result.failures.length, 1, 'one failure reported');
    assert.equal(result.failures[0].serverName, 'crash-server', 'failing server named');
    // Error message mentions either "exited" (process exit before request) or
    // "closed" (request issued when already closed) depending on timing.
    const msg = result.failures[0].error.message.toLowerCase();
    assert.ok(
      msg.includes('exited') || msg.includes('closed') || msg.includes('failed'),
      `error message mentions exit/close: ${result.failures[0].error.message}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  [PASS] mcp-protocol: crash (immediate exit)');
}

// ─── 6. processBuffer — non-JSON lines don't crash ──────────────────────────

{
  const { dir, scriptPath } = await setupMock();
  try {
    // The "noisy" mock outputs non-JSON garbage lines before and between
    // valid JSON-RPC responses.  processBuffer must skip those without
    // crashing and still resolve the pending responses.
    const [conn] = await connectMcpServers({
      mcpServers: {
        'noisy-server': {
          command: 'node',
          args: [scriptPath],
          env: { MOCK_BEHAVIOR: 'noisy' },
        },
      },
    });
    assert.equal(conn.serverName, 'noisy-server', 'connected despite noise');
    assert.equal(conn.tools.length, 2, 'tools/list works through noise');
    assert.equal(conn.tools[0].name, 'noisy-server__echo', 'tool name correct');

    // tools/call also works despite extra noise around responses
    const result = await conn.tools[0].execute(
      { text: 'noise-test' },
      minimalCtx(new AbortController().signal),
    );
    assert.ok(result.includes('noise-test'), 'tool call works with noisy output');

    await conn.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  [PASS] mcp-protocol: processBuffer handles non-JSON lines');
}