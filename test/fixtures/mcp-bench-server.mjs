#!/usr/bin/env node
/**
 * MCP stdio fixture for the capability-layer bench (`bench/tasks/capability-mcp-ledger`).
 *
 * A small "warehouse operations" tool catalog with three semantically distinct
 * tools. Exactly one (`ledger_lookup`) is required by the bench goal, so the
 * capability layer should select and reveal it while the decoys stay hidden —
 * that selection difference is what the A/B arms measure.
 *
 * Deterministic-but-unguessable results: the verification checksum is
 * sha256("<nonce>|<order>") where the nonce comes from MOSS_MCP_BENCH_NONCE
 * (a fresh random value per bench sample, passed via the workspace
 * `.moss/mcp.json` env block). The checksum therefore cannot be invented — it
 * must come back from a real tools/call.
 *
 * Every JSON-RPC request is appended (best-effort) to the file named by
 * MOSS_MCP_BENCH_LOG, one JSON object per line: the post-run check and the A/B
 * report read that log as ground truth for which tools the agent actually
 * called and in what order.
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout, same framing as
 * test/fixtures/mcp-catalog-server.mjs.
 */
import { appendFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline';

const NONCE = process.env.MOSS_MCP_BENCH_NONCE || 'mcp-bench-default-nonce';
const LOG_PATH = process.env.MOSS_MCP_BENCH_LOG || '';

function logRequest(entry) {
  if (!LOG_PATH) return;
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* logging must never break the server */
  }
}

function checksumFor(order) {
  return createHash('sha256').update(`${NONCE}|${order}`, 'utf8').digest('hex');
}

const TOOLS = [
  {
    name: 'ledger_lookup',
    description: 'look up a warehouse ledger entry and return its verification checksum',
    inputSchema: {
      type: 'object',
      properties: {
        order: { type: 'string', description: 'order id, e.g. ORD-4771' },
      },
      required: ['order'],
    },
    handle: (input) => {
      const order = typeof input?.order === 'string' ? input.order.trim() : '';
      if (!order) {
        return {
          content: [{ type: 'text', text: 'ledger_lookup requires {order: string}' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: checksumFor(order) }],
        isError: false,
      };
    },
  },
  {
    name: 'inventory_count',
    description: 'count SKUs currently in stock across storage bins',
    inputSchema: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'sku code' } },
      required: ['sku'],
    },
    handle: (input) => {
      const sku = typeof input?.sku === 'string' ? input.sku : '';
      const n = createHash('sha256').update(`count|${NONCE}|${sku}`).digest().readUInt16BE(0) % 500;
      return { content: [{ type: 'text', text: String(n) }], isError: false };
    },
  },
  {
    name: 'shipping_eta',
    description: 'estimated carrier delivery date for a tracking number',
    inputSchema: {
      type: 'object',
      properties: { tracking: { type: 'string', description: 'carrier tracking number' } },
      required: ['tracking'],
    },
    handle: (input) => {
      const tracking = typeof input?.tracking === 'string' ? input.tracking : '';
      const day =
        (createHash('sha256').update(`eta|${NONCE}|${tracking}`).digest().readUInt8(0) % 28) + 1;
      return {
        content: [{ type: 'text', text: `2026-10-${String(day).padStart(2, '0')}` }],
        isError: false,
      };
    },
  },
];

// Unknown-but-random boot nonce: proves nothing to the model (never returned),
// only keeps this fixture from being confusable with a cached copy.
const BOOT_NONCE = randomBytes(8).toString('hex');

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
        serverInfo: { name: 'warehouse-bench-fixture', version: '1.0.0' },
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
          inputSchema: tool.inputSchema,
        })),
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        },
      });
      return;
    }
    logRequest({
      ts: Date.now(),
      nonce: BOOT_NONCE,
      method: 'tools/call',
      id: msg.id,
      tool: tool.name,
      arguments: msg.params?.arguments ?? {},
    });
    let outcome;
    try {
      outcome = tool.handle(msg.params?.arguments ?? {});
    } catch (err) {
      outcome = {
        content: [{ type: 'text', text: `${tool.name} failed: ${err?.message ?? err}` }],
        isError: true,
      };
    }
    send({ jsonrpc: '2.0', id: msg.id, result: outcome });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
