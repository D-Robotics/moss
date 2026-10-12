#!/usr/bin/env node
/**
 * O114 — mid-stream (inter-event) stall is retryable, and the inter-event idle
 * default is a true 60s, decoupled from the 45s first-event deadline.
 */
import assert from 'node:assert/strict';
import {
  startFirstEventWatchdog,
  resolveFirstEventTimeoutMs,
  resolveInterEventTimeoutMs,
  PiAiFirstEventTimeoutError,
} from '../dist/provider/pi-ai-watchdog.js';
import {
  classifyLlmError,
  LlmRetriesExhaustedError,
} from '../dist/provider/llm-error-classifier.js';
import { toMossErrorOutcome } from '../dist/core/loop/agent-error-outcome.js';
import { runAgentLoopLlmTurn } from '../dist/core/loop/agent-loop-stream-helpers.js';

const ENV_KEYS = [
  'MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS',
  'PI_AI_FIRST_EVENT_TIMEOUT_MS',
  'MOSS_PI_AI_INTER_EVENT_TIMEOUT_MS',
  'PI_AI_INTER_EVENT_TIMEOUT_MS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ENV_KEYS) delete process.env[k];
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  [PASS] ${name}`);
};

// Fake timers: capture setTimeout delays used by the watchdog.
function captureTimers(fn) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const delays = [];
  globalThis.setTimeout = (cb, ms) => {
    delays.push(ms);
    return { cb, ms };
  };
  globalThis.clearTimeout = () => {};
  try {
    fn();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  return delays;
}

const model = { provider: 'p', id: 'm' };

try {
  // ─── A. defaults decoupled ────────────────────────────────────────────────
  // Explicitly clear BOTH env vars (and legacy aliases) for the default case.
  for (const k of [
    'MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS',
    'PI_AI_FIRST_EVENT_TIMEOUT_MS',
    'MOSS_PI_AI_INTER_EVENT_TIMEOUT_MS',
    'PI_AI_INTER_EVENT_TIMEOUT_MS',
  ]) {
    delete process.env[k];
    assert.equal(process.env[k], undefined, `${k} cleared`);
  }
  assert.equal(resolveFirstEventTimeoutMs(), 45_000);
  assert.equal(resolveInterEventTimeoutMs(), 60_000);
  {
    let wd;
    const delays = captureTimers(() => {
      wd = startFirstEventWatchdog(undefined, model);
      wd.onActivity();
    });
    assert.deepEqual(delays, [45_000, 60_000], 'first=45s, inter=60s (not capped to 45s)');
  }
  ok('defaults: first-event 45s, inter-event idle 60s (decoupled)');

  process.env.MOSS_PI_AI_INTER_EVENT_TIMEOUT_MS = '90000';
  process.env.MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS = '20000';
  {
    const delays = captureTimers(() => startFirstEventWatchdog(undefined, model).onActivity());
    assert.deepEqual(delays, [20_000, 90_000], 'env overrides apply independently');
  }
  delete process.env.MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS;
  process.env.MOSS_PI_AI_INTER_EVENT_TIMEOUT_MS = '30000';
  {
    const delays = captureTimers(() => startFirstEventWatchdog(undefined, model).onActivity());
    assert.deepEqual(delays, [45_000, 30_000]);
  }
  delete process.env.MOSS_PI_AI_INTER_EVENT_TIMEOUT_MS;
  ok('env: MOSS_PI_AI_{FIRST,INTER}_EVENT_TIMEOUT_MS override independently');

  // ─── B. classification ────────────────────────────────────────────────────
  const stall = () =>
    new PiAiFirstEventTimeoutError({
      timeoutMs: 60_000,
      ...{ provider: 'p', model: 'm' },
      phase: 'inter',
    });
  const c = classifyLlmError(stall());
  assert.equal(c.category, 'timeout');
  assert.equal(c.retryable, true, 'phase=inter stall is retryable');
  assert.match(c.message, /中途停滞/);
  const exhausted = classifyLlmError(new LlmRetriesExhaustedError(stall(), 3));
  assert.equal(exhausted.retryable, false, 'exhausted stall is not retried again');
  ok('classifier: phase=inter → retryable timeout; exhausted → not retryable');

  // ─── C. one stall then success → completes ────────────────────────────────
  const baseParams = (streamFn, pushes) => ({
    stream: { push: (e) => pushes.push(e) },
    modelDef: { api: 'test', provider: 'test', id: 'stall', maxTokens: 128 },
    piContext: { messages: [] },
    streamFn,
    maxLLMRetries: 2,
    abortSignal: new AbortController().signal,
    messagesForModel: [],
    toolsForRun: [],
    sessionKey: 'o114',
    turn: 1,
    runStartMs: Date.now(),
    firstTokenMs: null,
    logDebug() {},
  });
  const stallingStream = () => ({
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(stall()) };
    },
    result: () => Promise.reject(stall()),
  });
  const finalMsg = {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  };
  const okStream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: 'stop', message: finalMsg };
    },
    result: () => Promise.resolve(finalMsg),
  });

  {
    let calls = 0;
    const pushes = [];
    const res = await runAgentLoopLlmTurn(
      baseParams(() => (++calls === 1 ? stallingStream() : okStream()), pushes)
    );
    assert.equal(calls, 2, 'one stall → one automatic retry');
    const retries = pushes.filter((e) => e.type === 'retry');
    assert.equal(retries.length, 1, 'retry event emitted (user-visible "retrying" note)');
    assert.equal(retries[0].category, 'timeout');
    assert.ok(res && res.streamStopReason !== undefined, 'turn completes after retry');
  }
  ok('one mid-stream stall then success → retried once and completes');

  // ─── D. stalls beyond budget → honest failure ─────────────────────────────
  {
    let calls = 0;
    const pushes = [];
    let caught;
    try {
      await runAgentLoopLlmTurn(baseParams(() => (calls++, stallingStream()), pushes));
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught instanceof LlmRetriesExhaustedError,
      'exhausted retries throw (never success)'
    );
    assert.equal(calls, 3, 'retry cap: 1 attempt + 2 retries');
    assert.match(caught.message, /中途停滞/, 'error still says upstream stream stalled');
    const outcome = toMossErrorOutcome(caught);
    assert.equal(
      outcome.code,
      'PROVIDER_UPSTREAM_ERROR',
      'maps to upstream error (non-zero exit 6)'
    );
    assert.equal(outcome.recoverable, false, 'exhausted stall is reported recoverable: false');
    assert.equal(
      toMossErrorOutcome(stall()).recoverable,
      true,
      'a single (non-exhausted) stall stays recoverable'
    );
  }
  ok('stalls beyond retry budget → LlmRetriesExhaustedError, upstream error code, not success');

  console.log(`[PASS] o114-stream-stall-retry: ${passed}/5`);
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
