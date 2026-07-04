#!/usr/bin/env node
/**
 * MultiProviderRouter — fallback routing, abort propagation, health.
 *
 * The router had zero test coverage. These cover the highest-value paths:
 *  (1) primary retryable failure → fallback succeeds;
 *  (2) user abort during a fallback propagates immediately and does NOT mark
 *      the fallback unhealthy (no cooldown penalty for a user-initiated cancel
 *      — the bug this test pins down);
 *  (3) a non-abort, non-retryable fallback failure (e.g. context_length_exceeded)
 *      DOES mark the provider unhealthy so the next call skips it.
 */
import assert from 'node:assert/strict';
import { MultiProviderRouter } from '../dist/provider/multi-provider-router.js';

function mockProvider({ id, behavior }) {
  return {
    id,
    displayName: id,
    capabilities: { streaming: true },
    complete: async () => {
      throw new Error('not used');
    },
    stream: async (opts, onEvent) => behavior(opts, onEvent),
  };
}

const baseOpts = () => ({ abortSignal: new AbortController().signal });

// Access the router's private health array (TS-private is compile-time only).
function healthOf(router) {
  return router.fallbackHealth;
}

// ─── 1. primary retryable failure → fallback succeeds ──────────────────────
{
  const fallback = mockProvider({
    id: 'fb',
    behavior: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    }),
  });
  const primary = mockProvider({
    id: 'p',
    behavior: async () => {
      throw new Error('Request timed out');
    },
  });
  const router = new MultiProviderRouter({
    primary,
    createProvider: () => fallback,
    fallbacks: [{ provider: 'fb' }],
  });
  const res = await router.stream(baseOpts(), () => {});
  assert.ok(
    res.content.some((b) => b.type === 'text' && b.text === 'ok'),
    'fallback result returned when primary fails with a retryable error',
  );
}

// ─── 2. user abort during fallback propagates, does NOT mark unhealthy ──────
{
  const fb1 = mockProvider({
    id: 'fb1',
    behavior: async () => {
      throw new Error('Request was aborted');
    },
  });
  let fb2Called = false;
  const fb2 = mockProvider({
    id: 'fb2',
    behavior: async () => {
      fb2Called = true;
      return { stopReason: 'end_turn', content: [] };
    },
  });
  const primary = mockProvider({
    id: 'p',
    behavior: async () => {
      throw new Error('Request timed out');
    },
  });
  const router = new MultiProviderRouter({
    primary,
    createProvider: (cfg) => (cfg.provider === 'fb1' ? fb1 : fb2),
    fallbacks: [{ provider: 'fb1' }, { provider: 'fb2' }],
  });
  await assert.rejects(
    () => router.stream(baseOpts(), () => {}),
    /aborted/i,
    'user abort during a fallback propagates (not swallowed as "all providers exhausted")',
  );
  assert.ok(!fb2Called, 'early-exit: fb2 not tried after a user abort on fb1');
  assert.equal(
    healthOf(router)[0].unhealthyUntil,
    0,
    'fb1 NOT marked unhealthy for a user-initiated abort',
  );
}

// ─── 3. non-abort non-retryable fallback failure marks unhealthy ───────────
{
  const fb1 = mockProvider({
    id: 'fb1',
    behavior: async () => {
      throw new Error('context_length_exceeded: prompt too long');
    },
  });
  const fb2 = mockProvider({
    id: 'fb2',
    behavior: async () => {
      throw new Error('Request timed out');
    },
  });
  const primary = mockProvider({
    id: 'p',
    behavior: async () => {
      throw new Error('Request timed out');
    },
  });
  const router = new MultiProviderRouter({
    primary,
    createProvider: (cfg) => (cfg.provider === 'fb1' ? fb1 : fb2),
    fallbacks: [{ provider: 'fb1' }, { provider: 'fb2' }],
  });
  await assert.rejects(() => router.stream(baseOpts(), () => {}), /context_length|timed out/i);
  assert.ok(
    healthOf(router)[0].unhealthyUntil > 0,
    'fb1 marked unhealthy after a non-abort non-retryable failure (context_length_exceeded)',
  );
}

console.log('  [PASS] multi-provider-router: fallback success, abort propagation, health marking');
