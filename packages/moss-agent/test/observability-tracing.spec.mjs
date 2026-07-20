#!/usr/bin/env node
// @rdk-moss/agent — withSpan: success path sets OK, error path records
// exception + rethrows. attributes constructors produce expected shape.
// setTracer/setTraceRedactor/TraceRegistry/getTracer legacy shims exist & are noop.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'tracing.js')).href);
const {
  withSpan, turnAttributes, toolAttributes, llmRequestAttributes,
  setTracer, setTraceRedactor, getTracer, TraceRegistry,
} = mod;

// 未注册 tracer provider 时为 noop tracer，withSpan 仍正常执行 fn 并返回结果。
const result = await withSpan('test.span', { a: 1 }, async (span) => {
  assert.equal(typeof span.setAttribute, 'function');
  assert.equal(typeof span.addEvent, 'function');
  assert.equal(typeof span.setStatus, 'function');
  assert.equal(typeof span.end, 'function');
  span.setAttribute('k', 'v');
  span.addEvent('ev', { x: 1 });
  return 42;
});
assert.equal(result, 42, 'withSpan returns fn result');

// 异常路径：rethrow（不吞错）
await assert.rejects(
  withSpan('test.err', {}, async () => { throw new Error('boom'); }),
  /boom/,
);

// attributes 构造器形状
assert.deepEqual(turnAttributes('r1', 3, 'm'), { runId: 'r1', turn: 3, model: 'm' });
assert.deepEqual(toolAttributes('r1', 'read_file', 'tc1'), { runId: 'r1', toolName: 'read_file', toolCallId: 'tc1' });
assert.deepEqual(llmRequestAttributes('r1', 'm', 100), { runId: 'r1', model: 'm', inputTokens: 100 });

// 旧 API 保留为 noop shim，不抛
assert.doesNotThrow(() => setTracer('console'));
assert.doesNotThrow(() => setTraceRedactor((s) => s));
assert.ok(getTracer());
assert.ok(new TraceRegistry());
console.error('[spec] observability-tracing OK');
