import assert from 'node:assert/strict';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { resolveTraceSampler } from '../dist/observability/sdk.js';

assert.equal(
  resolveTraceSampler(0.1, true),
  undefined,
  'host processors require the SDK default AlwaysOn sampler so they see every span'
);
assert.ok(resolveTraceSampler(0.1, false) instanceof TraceIdRatioBasedSampler);
assert.equal(resolveTraceSampler(undefined, false), undefined);
assert.equal(resolveTraceSampler(1, false), undefined);

console.log('[PASS] observability SDK sampling policy');
