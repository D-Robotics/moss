#!/usr/bin/env node
/**
 * pi-ai watchdog — first-event vs inter-event timeout phase.
 *
 * Verifies the timeout error distinguishes "no event before the initial
 * deadline" (phase 'first') from "stream stalled mid-response" (phase 'inter'),
 * so an inter-event timeout does not misleadingly say "未吐出任何流事件" when
 * events WERE emitted.
 *
 * Note: resolveFirstEventTimeoutMs clamps to a 5s minimum, so the test uses
 * 5000ms and waits 5.2s per case.
 */
import assert from 'node:assert/strict';
import {
  startFirstEventWatchdog,
  PiAiFirstEventTimeoutError,
} from '../dist/provider/pi-ai-watchdog.js';

const model = { provider: 'test-prov', id: 'test-model' };

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Force the minimum clamped timeout (5s) so the test doesn't take 45s.
const timeoutEnv = {
  MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS: '5000',
  PI_AI_FIRST_EVENT_TIMEOUT_MS: '5000',
};

// ─── 1. first-event timeout: phase 'first' ──────────────────────────────────
await withEnv(timeoutEnv, async () => {
  const wd = startFirstEventWatchdog(undefined, model);
  await new Promise((r) => setTimeout(r, 5200));
  const err = wd.translateError(new Error('orig'));
  assert.ok(
    err instanceof PiAiFirstEventTimeoutError,
    'first-event timeout produces PiAiFirstEventTimeoutError'
  );
  assert.equal(err.phase, 'first', 'phase is "first" (no event before the initial deadline)');
  assert.ok(/未吐出任何流事件/.test(err.message), 'first-event message says "no events emitted"');
  wd.dispose();
});

// ─── 2. inter-event timeout: phase 'inter' ──────────────────────────────────
await withEnv(timeoutEnv, async () => {
  const wd = startFirstEventWatchdog(undefined, model);
  wd.onActivity(); // first event received → watchdog switches to the inter-event timer
  await new Promise((r) => setTimeout(r, 5200));
  const err = wd.translateError(new Error('orig'));
  assert.ok(err instanceof PiAiFirstEventTimeoutError);
  assert.equal(err.phase, 'inter', 'phase is "inter" (stream stalled mid-response)');
  assert.ok(
    /中途停滞|无新事件/.test(err.message),
    'inter-event message says "stalled mid-response"'
  );
  assert.ok(
    !/未吐出任何流事件/.test(err.message),
    'inter-event message does NOT say "no events" (events were emitted)'
  );
  wd.dispose();
});

console.log('  [PASS] pi-ai-watchdog: first-event vs inter-event timeout phase distinction');
