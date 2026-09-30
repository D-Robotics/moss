#!/usr/bin/env node
/**
 * MCP stdio fixture with a small but semantically distinct tool catalog, used by
 * test/mcp-capability-selection.spec.mjs to check that capability discovery
 * selects the *right* tools per task (and only those).
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout.
 */
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'camera_tune',
    description: 'tune camera exposure and gain for the board camera pipeline',
  },
  { name: 'camera_probe', description: 'measure camera frame rate and capture latency' },
  { name: 'led_blink', description: 'blink the status LED a number of times' },
  { name: 'invoice_list', description: 'list invoices for the billing system' },
  { name: 'gpio_read', description: 'read the level of a GPIO pin' },
  { name: 'robot_navigate', description: 'send a navigation goal to the robot base' },
  {
    name: 'verbose_tool',
    description: `verbose sensor calibration notes ${'y'.repeat(3000)}`,
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'catalog-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name ?? 'unknown';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `called(${name})` }],
        isError: false,
      },
    });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
