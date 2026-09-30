#!/usr/bin/env node
/**
 * Minimal MCP stdio server for test/mcp-client.spec.mjs.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
 * transport framing):
 *  - initialize            → capabilities + serverInfo (protocol 2025-06-18)
 *  - notifications/initialized → ignored (no response, per JSON-RPC)
 *  - tools/list            → exactly 50 tools (tool_00 … tool_49)
 *  - tools/call            → echoes the tool name + the `value` argument
 *
 * tool_49 deliberately answers ~1.5s late so the spec can exercise the
 * client-side request timeout (Promise.race) and late-response discard.
 */
import readline from 'node:readline';

const TOOL_COUNT = 50;
const SLOW_TOOL = 'tool_49';
const SLOW_DELAY_MS = 1500;

function listTools() {
  const tools = [];
  for (let i = 0; i < TOOL_COUNT; i++) {
    tools.push({
      name: `tool_${String(i).padStart(2, '0')}`,
      description: `Fixture stdio tool ${i} — echoes the value argument back.`,
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', description: 'value to echo' } },
        required: ['value'],
      },
    });
  }
  return tools;
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handleCall(id, params) {
  const name = typeof params?.name === 'string' ? params.name : '';
  const value = typeof params?.arguments?.value === 'string' ? params.arguments.value : '';
  const respond = () =>
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo(${name}):${value}` }], isError: false },
    });
  if (name === SLOW_TOOL) setTimeout(respond, SLOW_DELAY_MS);
  else respond();
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  // Notifications carry no id — nothing to answer.
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fixture-stdio', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: listTools() } });
    return;
  }
  if (msg.method === 'tools/call') {
    handleCall(msg.id, msg.params);
    return;
  }
  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
});
