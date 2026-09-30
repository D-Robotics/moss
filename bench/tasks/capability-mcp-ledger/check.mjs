#!/usr/bin/env node
// Bench-harness entry. The real post-condition lives in files/check-goal.mjs so
// the workspace copy and the harness copy can never drift apart.
//
// The bench harness runs this check with a minimal env (PATH/HOME/task dirs —
// deliberately WITHOUT task.env), so the bench nonce is recovered from
// task.json before delegating. The nonce there is a public bench constant (not
// a credential); the A/B driver instead injects a fresh random nonce per
// sample through the environment, which the same check reads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
if (!process.env.MOSS_MCP_BENCH_NONCE && task.env?.MOSS_MCP_BENCH_NONCE) {
  process.env.MOSS_MCP_BENCH_NONCE = String(task.env.MOSS_MCP_BENCH_NONCE);
}
if (!process.env.MOSS_MCP_BENCH_LOG) {
  process.env.MOSS_MCP_BENCH_LOG = 'mcp-calls.jsonl';
}
await import('./files/check-goal.mjs');
