#!/usr/bin/env node
/**
 * MCP stdio fixture that reports back the `clientInfo` the client sent in the
 * initialize handshake (used by test/mcp-client-version.spec.mjs).
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout — same framing as
 * test/fixtures/mcp-stdio-server.mjs.
 */
import readline from 'node:readline';

let clientInfo = null;

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
    clientInfo = msg.params?.clientInfo ?? null;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'client-info-fixture', version: '1.0.0' },
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
        tools: [
          {
            name: 'report_client',
            description: 'Reports the clientInfo seen during initialize.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(clientInfo) }],
        isError: false,
      },
    });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
