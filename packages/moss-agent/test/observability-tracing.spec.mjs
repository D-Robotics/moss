#!/usr/bin/env node
// @rdk-moss/agent — withSpan: success path sets OK, error path records
// exception + rethrows. attributes constructors produce expected shape.
// setTracer/setTraceRedactor/TraceRegistry/getTracer legacy shims exist & are noop.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'tracing.js')).href
);
const {
  withSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
  setTracer,
  setTraceRedactor,
  getTracer,
  TraceRegistry,
} = mod;
const {
  MOSS_OBSERVABILITY_ATTRIBUTES,
  MOSS_OBSERVABILITY_CONTRACT_VERSION,
  readMossCompatibilityAttribute,
} = await import(pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'contract.js')).href);

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
  withSpan('test.err', {}, async () => {
    throw new Error('boom');
  }),
  /boom/
);

// attributes 构造器形状
assert.deepEqual(turnAttributes('r1', 3, 'm', 's1'), {
  [MOSS_OBSERVABILITY_ATTRIBUTES.contractVersion]: MOSS_OBSERVABILITY_CONTRACT_VERSION,
  [MOSS_OBSERVABILITY_ATTRIBUTES.runId]: 'r1',
  [MOSS_OBSERVABILITY_ATTRIBUTES.sessionId]: 's1',
  [MOSS_OBSERVABILITY_ATTRIBUTES.turnIndex]: 3,
  [MOSS_OBSERVABILITY_ATTRIBUTES.genAiRequestModel]: 'm',
  runId: 'r1',
  sessionKey: 's1',
  turn: 3,
  model: 'm',
});
assert.deepEqual(toolAttributes('r1', 'read_file', 'tc1'), {
  [MOSS_OBSERVABILITY_ATTRIBUTES.contractVersion]: MOSS_OBSERVABILITY_CONTRACT_VERSION,
  [MOSS_OBSERVABILITY_ATTRIBUTES.runId]: 'r1',
  [MOSS_OBSERVABILITY_ATTRIBUTES.sessionId]: 'r1',
  [MOSS_OBSERVABILITY_ATTRIBUTES.toolName]: 'read_file',
  [MOSS_OBSERVABILITY_ATTRIBUTES.toolCallId]: 'tc1',
  runId: 'r1',
  sessionKey: 'r1',
  toolName: 'read_file',
  toolCallId: 'tc1',
});
assert.deepEqual(llmRequestAttributes('r1', 'm', 100), {
  [MOSS_OBSERVABILITY_ATTRIBUTES.contractVersion]: MOSS_OBSERVABILITY_CONTRACT_VERSION,
  [MOSS_OBSERVABILITY_ATTRIBUTES.runId]: 'r1',
  [MOSS_OBSERVABILITY_ATTRIBUTES.sessionId]: 'r1',
  [MOSS_OBSERVABILITY_ATTRIBUTES.genAiOperationName]: 'chat',
  [MOSS_OBSERVABILITY_ATTRIBUTES.genAiRequestModel]: 'm',
  [MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageInputTokens]: 100,
  runId: 'r1',
  sessionKey: 'r1',
  model: 'm',
  inputTokens: 100,
});

assert.deepEqual(
  readMossCompatibilityAttribute(
    { [MOSS_OBSERVABILITY_ATTRIBUTES.runId]: 'canonical', runId: 'conflicting-legacy' },
    MOSS_OBSERVABILITY_ATTRIBUTES.runId,
    'runId'
  ),
  { value: 'canonical', source: 'canonical', drift: true },
  'canonical values win and conflicting aliases surface contract drift'
);
assert.deepEqual(
  readMossCompatibilityAttribute(
    { runId: 'legacy-only' },
    MOSS_OBSERVABILITY_ATTRIBUTES.runId,
    'runId'
  ),
  { value: 'legacy-only', source: 'legacy', drift: false },
  'legacy-only records remain readable during the compatibility window'
);

// 旧 API 保留为 noop shim，不抛
assert.doesNotThrow(() => setTracer('console'));
assert.doesNotThrow(() => setTraceRedactor((s) => s));
assert.ok(getTracer());
assert.ok(new TraceRegistry());
console.error('[spec] observability-tracing OK');
