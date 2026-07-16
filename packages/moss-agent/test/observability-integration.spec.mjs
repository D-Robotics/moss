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
const { initObservability, shutdownObservability, withSpan, mossMetrics } = mod;
const traceMod = await import(pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'file-trace.js')).href);
const { readTraceStats } = traceMod;
// api 'metrics' to assert the global MeterProvider got registered on init.
const otelApi = await import('@opentelemetry/api');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-int-'));
process.env.MOSS_OTEL_ENABLED = '1';
process.env.MOSS_OTEL_URL = 'http://localhost:4318';  // receiver 未起，fire-and-forget 不抛
process.env.MOSS_FILE_TRACE = '1';

// Before init: getMeterProvider() is the noop provider (constructor NoopMeterProvider).
// After init: SDK registered a real MeterProvider. This guards against the regression
// where mossMetrics binds to the noop meter at module load and never switches to real
// instruments (instruments must be resolved lazily AFTER setGlobalMeterProvider).
const providerBefore = otelApi.metrics.getMeterProvider();
assert.equal(providerBefore.constructor.name, 'NoopMeterProvider',
  'no global MeterProvider before init (default noop)');

initObservability({ workspaceDir: tmp });

const providerAfter = otelApi.metrics.getMeterProvider();
assert.notEqual(providerAfter.constructor.name, 'NoopMeterProvider',
  'initObservability registered a real MeterProvider (not noop)');
assert.notStrictEqual(providerAfter, providerBefore, 'provider changed after init');

// 三层 span：session → turn → llm（模拟 agent 调用栈）
// 在 llm span 内记一条 metric — 验证 instruments 在 SDK start 后解析为真
// （lazy 解析；eager 绑定会卡在 noop meter）。
await withSpan('moss.session', { runId: 'r1', model: 'm', sessionKey: 'sk' }, async () => {
  return withSpan('moss.agent.turn', { runId: 'r1', turn: 1, model: 'm' }, async () => {
    return withSpan('moss.llm.request', { runId: 'r1', model: 'm', inputTokens: 100 }, async (span) => {
      span.setAttribute('outputTokens', 50);
      mossMetrics.llmTokens.add(100, { direction: 'input', model: 'm' });
      mossMetrics.llmTokens.add(50, { direction: 'output', model: 'm' });
      mossMetrics.llmDuration.record(42, { model: 'm' });
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
