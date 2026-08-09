#!/usr/bin/env node
// @rdk-moss/agent — FileSpanProcessor buffers spans, flushes to traces.jsonl,
// and readTraceStats aggregates. Uses minimal ReadableSpan-shaped objects.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'file-trace.js')).href
);
const { FileSpanProcessor, readTraceStats } = mod;

// 构造一个最小 ReadableSpan 形状 (SDK 的 ReadableSpan 是接口，鸭子类型即可)
function fakeSpan(name, attrs, isError) {
  const now = Date.now();
  const sec = Math.trunc(now / 1000);
  return {
    name,
    kind: 0,
    spanContext: () => ({ traceId: 't'.repeat(32), spanId: 's'.repeat(16) }),
    startTime: [sec, 0],
    endTime: [sec, 1_000_000],
    attributes: attrs ?? {},
    status: isError ? { code: 2, message: 'boom' } : { code: 1 },
    events: [],
    resource: { attributes: [] },
    instrumentationScope: { name: 'moss-agent' },
    duration: [0, 1_000_000],
    ended: true,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    links: [],
  };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-trace-'));
const proc = new FileSpanProcessor(tmp);
proc.onStart(fakeSpan('noop'), undefined);
proc.onEnd(fakeSpan('moss.tool.invoke', { toolName: 'read_file' }, false));
proc.onEnd(fakeSpan('moss.tool.invoke', { toolName: 'read_file' }, true));
proc.onEnd(fakeSpan('moss.llm.request', { model: 'm' }, false));
await proc.forceFlush();

const file = path.join(tmp, '.moss', 'analytics', 'traces.jsonl');
const content = await fs.readFile(file, 'utf8');
const lines = content.split('\n').filter(Boolean);
assert.equal(lines.length, 3, 'should write 3 span lines');

const stats = await readTraceStats(file);
assert.equal(stats.totalSpans, 3, 'totalSpans');
assert.equal(stats.totalErrors, 1, 'totalErrors');
assert.ok(stats.byName['moss.tool.invoke'], 'tool span aggregated by name');
assert.equal(stats.byName['moss.tool.invoke'].count, 2, '2 tool spans');
assert.equal(stats.byName['moss.tool.invoke'].errors, 1, '1 tool error');
assert.equal(stats.toolSpans[0].toolName, 'read_file', 'tool breakdown by toolName');

await proc.shutdown();
await fs.rm(tmp, { recursive: true, force: true });
console.error('[spec] observability-file-trace OK');
