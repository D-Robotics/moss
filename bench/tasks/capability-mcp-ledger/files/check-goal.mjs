#!/usr/bin/env node
/**
 * Post-condition for the capability-mcp-ledger bench task.
 *
 * Passes only when BOTH hold:
 *  1. checksum.txt in the workspace contains exactly
 *     sha256("<MOSS_MCP_BENCH_NONCE>|ORD-4771") — a value the agent cannot
 *     invent, it has to come back from a real ledger_lookup tools/call;
 *  2. the MCP fixture server's request log (MOSS_MCP_BENCH_LOG) contains a
 *     tools/call for ledger_lookup with order ORD-4771.
 *
 * Used in two positions with identical semantics:
 *  - the A/B driver passes it as the engine acceptance command
 *    (`moss task run --accept "node check-goal.mjs"`);
 *  - the bench harness runs bench/tasks/capability-mcp-ledger/check.mjs after
 *    the sample, which re-exports this file.
 *
 * Env (both must be set by the harness/driver, never hardcoded):
 *  MOSS_MCP_BENCH_NONCE  per-sample random nonce (A/B driver) or the task
 *                         env constant (bench harness)
 *  MOSS_MCP_BENCH_LOG     MCP server request log; relative paths resolve
 *                         against the workspace (the server child and this
 *                         check share the workspace as cwd)
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ORDER = 'ORD-4771';

function fail(message) {
  console.error(`[check] FAIL: ${message}`);
  process.exit(1);
}

const nonce = process.env.MOSS_MCP_BENCH_NONCE;
if (!nonce) fail('MOSS_MCP_BENCH_NONCE is not set');
const logPath = process.env.MOSS_MCP_BENCH_LOG || 'mcp-calls.jsonl';
const expected = createHash('sha256').update(`${nonce}|${ORDER}`, 'utf8').digest('hex');

if (!existsSync('checksum.txt')) {
  fail(
    'checksum.txt not found — write the ledger checksum returned by the warehouse MCP tool to checksum.txt'
  );
}
const observed = readFileSync('checksum.txt', 'utf8').trim();
if (observed !== expected) {
  fail(
    `checksum.txt mismatch: got "${observed.slice(0, 80)}${observed.length > 80 ? '…' : ''}", want sha256(nonce|${ORDER})`
  );
}

if (!existsSync(logPath)) {
  fail(
    `MCP request log "${logPath}" not found — the checksum must come from a real ledger_lookup call`
  );
}
const entries = readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const ledgerCalls = entries.filter(
  (entry) =>
    entry.method === 'tools/call' &&
    entry.tool === 'ledger_lookup' &&
    entry.arguments?.order === ORDER
);
if (ledgerCalls.length === 0) {
  fail(
    `no ledger_lookup(${ORDER}) call in the MCP server log — checksum without a tool call is not accepted`
  );
}

console.log(
  `[check] PASS: checksum.txt matches sha256(nonce|${ORDER}) and ledger_lookup(${ORDER}) was called (${ledgerCalls.length} call(s))`
);
