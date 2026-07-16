#!/usr/bin/env node
// @rdk-moss/agent — End-to-end integration: enable SDK, run nested withSpan
// (session→turn→llm), verify the local file trace lands the three nested spans.
// Does NOT require a live receiver — OTLP sends are fire-and-forget; the
// FileSpanProcessor writes to disk regardless of network.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'index.js')).href);
const { initObservability, shutdownObservability, withSpan } = mod;
const traceMod = await import(pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'file-trace.js')).href);
const { readTraceStats } = traceMod;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-int-'));
process.env.MOSS_OTEL_ENABLED = '1';
process.env.MOSS_OTEL_URL = 'http://localhost:4318';  // receiver 未起，fire-and-forget 不抛
process.env.MOSS_FILE_TRACE = '1';

initObservability({ workspaceDir: tmp });

// 三层 span：session → turn → llm（模拟 agent 调用栈）
await withSpan('moss.session', { runId: 'r1', model: 'm', sessionKey: 'sk' }, async () => {
  return withSpan('moss.agent.turn', { runId: 'r1', turn: 1, model: 'm' }, async () => {
    return withSpan('moss.llm.request', { runId: 'r1', model: 'm', inputTokens: 100 }, async (span) => {
      span.setAttribute('outputTokens', 50);
      return 'done';
    });
  });
});

await shutdownObservability();

const file = path.join(tmp, '.moss', 'analytics', 'traces.jsonl');
const stats = await readTraceStats(file);
assert.equal(stats.totalSpans, 3, 'three nested spans landed in file');
assert.ok(stats.byName['moss.session'], 'session span present');
assert.ok(stats.byName['moss.agent.turn'], 'turn span present');
assert.ok(stats.byName['moss.llm.request'], 'llm span present');

await fs.rm(tmp, { recursive: true, force: true });
delete process.env.MOSS_OTEL_ENABLED;
delete process.env.MOSS_OTEL_URL;
delete process.env.MOSS_FILE_TRACE;
console.error('[spec] observability-integration OK');
