#!/usr/bin/env node
/**
 * Offline stand-in for rdk-docs-mcp. Speaks newline JSON-RPC on stdio and
 * exposes list_manuals / search_docs / get_page / list_toc. No network.
 *
 * `--fail` exits before the handshake so connect tests can observe a failure.
 */
import fs from 'node:fs';
import readline from 'node:readline';

if (process.argv.includes('--fail')) {
  process.stderr.write('rdk-docs fixture refused\n');
  process.exit(1);
}

const delayArg = process.argv.find((arg) => arg.startsWith('--delay-ms='));
const delayMs = Math.max(0, Number(delayArg?.slice('--delay-ms='.length) ?? 0) || 0);
const startupArg = process.argv.find((arg) => arg.startsWith('--startup-delay-ms='));
const startupDelayMs = Math.max(
  0,
  Number(startupArg?.slice('--startup-delay-ms='.length) ?? 0) || 0
);
const recordArg = process.argv.find((arg) => arg.startsWith('--record='));
const recordPath = recordArg?.slice('--record='.length);

function noteMethod(method) {
  if (!recordPath || typeof method !== 'string' || method.length === 0) return;
  fs.appendFileSync(recordPath, `${method}\n`);
}

const extraArg = process.argv.find((arg) => arg.startsWith('--extra-tools='));
const extraNames = (extraArg?.slice('--extra-tools='.length) ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const TOOLS = [
  {
    name: 'list_manuals',
    description: 'List official RDK manual ids.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_docs',
    description: 'Search official manuals. Pass manual when a board is named.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        manual: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_page',
    description: 'Fetch one manual page by URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_toc',
    description: 'List the table of contents for one manual.',
    inputSchema: {
      type: 'object',
      properties: { manual: { type: 'string' } },
      required: ['manual'],
    },
  },
  ...extraNames.map((name) => ({
    name,
    description: `Extra fixture tool ${name}.`,
    inputSchema: { type: 'object', properties: {} },
  })),
];

function send(msg) {
  const write = () => process.stdout.write(`${JSON.stringify(msg)}\n`);
  if (delayMs > 0) setTimeout(write, delayMs);
  else write();
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof msg.method === 'string') noteMethod(msg.method);
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rdk-docs', version: '0.2.0-fixture' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `fixture:${name}` }],
        isError: false,
      },
    });
    return;
  }
  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let accept = startupDelayMs === 0;
const queued = [];
if (!accept) {
  setTimeout(() => {
    accept = true;
    for (const line of queued.splice(0)) handleLine(line);
  }, startupDelayMs);
}
rl.on('line', (line) => {
  if (!accept) {
    queued.push(line);
    return;
  }
  handleLine(line);
});
