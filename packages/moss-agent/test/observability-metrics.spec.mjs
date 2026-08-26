#!/usr/bin/env node
// @rdk-moss/agent — mossMetrics instruments export + noop behavior (no provider registered).
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'metrics.js')).href
);
const { mossMetrics, sanitizeMetricAttributes } = mod;

// 未 setGlobalMeterProvider 时返回 noop meter，instruments 仍可调用不抛错。
assert.ok(mossMetrics, 'mossMetrics should be exported');
assert.equal(typeof mossMetrics.llmTokens.add, 'function', 'llmTokens.add is a function');
assert.equal(typeof mossMetrics.llmDuration.record, 'function', 'llmDuration.record is a function');
assert.equal(
  typeof mossMetrics.toolInvocations.add,
  'function',
  'toolInvocations.add is a function'
);
assert.equal(
  typeof mossMetrics.toolDuration.record,
  'function',
  'toolDuration.record is a function'
);
assert.equal(typeof mossMetrics.sessionCount.add, 'function', 'sessionCount.add is a function');
assert.equal(
  typeof mossMetrics.sessionDuration.record,
  'function',
  'sessionDuration.record is a function'
);
assert.equal(
  typeof mossMetrics.sessionToolCount.record,
  'function',
  'sessionToolCount.record is a function'
);

// noop 调用零成本、不抛
assert.doesNotThrow(() => {
  mossMetrics.llmTokens.add(10, { direction: 'input', model: 'm' });
  mossMetrics.llmDuration.record(123, { model: 'm' });
  mossMetrics.toolInvocations.add(1, { tool: 't', status: 'ok' });
  mossMetrics.sessionCount.add(1, { outcome: 'ok' });
  mossMetrics.sessionToolCount.record(3, { outcome: 'ok' });
});

assert.deepEqual(
  sanitizeMetricAttributes('moss.llm.tokens', {
    direction: 'input',
    model: 'gpt-5.2-2026-01-01',
    outcome: 'ok',
    runId: 'run-secret',
    sessionKey: 'session-secret',
    trace_id: 'a'.repeat(32),
    accountId: 'account-secret',
    rawError: 'private provider response',
  }),
  { 'moss.outcome': 'ok', direction: 'input', 'model.family': 'gpt' },
  'LLM dimensions are bounded and reject identifiers/raw errors'
);
assert.deepEqual(
  sanitizeMetricAttributes('moss.tool.invocations', {
    tool: 'customer_defined_tool_9284',
    toolCallId: 'call-secret',
    outcome: 'blocked',
  }),
  { 'moss.outcome': 'blocked', 'tool.category': 'other' },
  'unbounded tool names collapse to other and tool-call ids are dropped'
);

console.error('[spec] observability-metrics OK');
