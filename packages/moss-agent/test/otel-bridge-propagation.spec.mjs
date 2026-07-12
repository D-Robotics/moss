#!/usr/bin/env node
/**
 * otel-bridge propagation 测试 — getCurrentSpan / injectTraceparent
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableOtelTracing, getCurrentSpan, injectTraceparent } from '../dist/observability/otel-bridge.js';
import { withSpan } from '../dist/observability/tracing.js';

// Enable tracing so the otel-bridge tracer (with AsyncLocalStorage) is active.
enableOtelTracing({ serviceName: 'test', url: 'http://localhost:9999/v1/traces' });

test('getCurrentSpan: undefined outside withSpan', () => {
  assert.equal(getCurrentSpan(), undefined);
});

test('getCurrentSpan: set inside withSpan', async () => {
  await withSpan('test.span', undefined, async () => {
    const ctx = getCurrentSpan();
    assert.ok(ctx, 'current span should be set inside withSpan');
    assert.equal(ctx.name, 'test.span');
  });
});

test('injectTraceparent: returns original headers outside span', () => {
  const h = { 'content-type': 'application/json' };
  const out = injectTraceparent(h);
  assert.equal(out.traceparent, undefined, 'no traceparent outside span');
  assert.equal(out['content-type'], 'application/json');
});

test('injectTraceparent: valid W3C traceparent inside span', async () => {
  await withSpan('test.span', undefined, async () => {
    const out = injectTraceparent({});
    assert.ok(out.traceparent, 'traceparent should be set inside span');
    // 00-<32hex>-<16hex>-<2hex flags>
    assert.match(out.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    // Default ratio 1.0 → sampled → flags=01
    assert.equal(out.traceparent.slice(-2), '01', 'sampled flag=01 (ratio 1.0)');
  });
});

test('injectTraceparent: preserves existing headers', async () => {
  await withSpan('test.span', undefined, async () => {
    const out = injectTraceparent({ accept: 'text/html' });
    assert.equal(out.accept, 'text/html', 'existing header preserved');
    assert.ok(out.traceparent, 'traceparent added');
  });
});
