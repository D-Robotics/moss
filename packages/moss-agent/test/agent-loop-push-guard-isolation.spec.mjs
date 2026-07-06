#!/usr/bin/env node
/**
 * Run-epoch store isolation across MossAgent instances.
 *
 * The stream-push guard uses a per-sessionKey epoch to close over stale runs:
 * the "later run wins" pattern. Before this test, the epoch Map lived at
 * module scope (process-wide singleton). Two MossAgent instances sharing the
 * same sessionKey would stomp each other's epochs — instance B's new run
 * would silently cancel instance A's live stream.
 *
 * Contract: each MossAgent (or any AgentLoopParams provider) may pass its own
 * store; when it does, bumps on that store do NOT affect any other store.
 */
import assert from 'node:assert/strict';
import {
  bumpAgentLoopRunEpoch,
  guardMiniAgentStreamPush,
  getDefaultRunEpochStore,
} from '../dist/core/loop/agent-loop-push-guard.js';

// ─── 1. Isolated stores don't stomp each other ────────────────────────────
{
  const storeA = new Map();
  const storeB = new Map();
  const epochA1 = bumpAgentLoopRunEpoch('shared-key', storeA);
  const epochB1 = bumpAgentLoopRunEpoch('shared-key', storeB);
  assert.equal(epochA1, 1, 'first bump on A is 1');
  assert.equal(epochB1, 1, 'first bump on B is also 1 (separate store)');

  // Bumping B again must NOT touch A's epoch.
  bumpAgentLoopRunEpoch('shared-key', storeB);
  assert.equal(storeA.get('shared-key'), 1, 'A is unchanged after B bumps');
  assert.equal(storeB.get('shared-key'), 2, 'B is bumped to 2');
}

// ─── 2. guardMiniAgentStreamPush honors the passed store ──────────────────
{
  const storeA = new Map();
  const seen = [];
  const stream = { push: (e) => seen.push(e) };
  const epoch = bumpAgentLoopRunEpoch('k', storeA);
  guardMiniAgentStreamPush(stream, 'k', epoch, storeA);

  stream.push({ type: 'first' });
  assert.equal(seen.length, 1, 'push while epoch matches goes through');

  // Bumping storeA advances the epoch → guard drops later pushes.
  bumpAgentLoopRunEpoch('k', storeA);
  stream.push({ type: 'stale' });
  assert.equal(seen.length, 1, 'stale push after bump is dropped');

  // But bumping a DIFFERENT store must NOT affect this guard.
  const storeB = new Map();
  const seen2 = [];
  const stream2 = { push: (e) => seen2.push(e) };
  const epoch2 = bumpAgentLoopRunEpoch('k', storeB);
  guardMiniAgentStreamPush(stream2, 'k', epoch2, storeB);

  // Bump storeA — must not close storeB's guard.
  bumpAgentLoopRunEpoch('k', storeA);
  stream2.push({ type: 'B-live' });
  assert.equal(seen2.length, 1, 'B\'s guard is unaffected by A\'s bumps');
}

// ─── 3. Default store is a shared singleton (backwards-compat) ────────────
{
  const singleton = getDefaultRunEpochStore();
  assert.ok(singleton instanceof Map, 'default store is a Map');
  const before = singleton.get('backcompat-key') ?? 0;
  const bumped = bumpAgentLoopRunEpoch('backcompat-key'); // no store arg → default
  assert.equal(bumped, before + 1, 'no-arg bump uses the default singleton');
  assert.equal(singleton.get('backcompat-key'), bumped, 'default singleton is mutated');
}

// ─── 4. LRU trim triggers on the passed store (not the singleton) ─────────
{
  const store = new Map();
  // Fill past MAX_MAP_SIZE=1000 to trigger trim to 500.
  for (let i = 0; i < 1100; i++) {
    bumpAgentLoopRunEpoch(`key-${i}`, store);
  }
  assert.ok(store.size <= 1000, `LRU trim triggered on isolated store, size=${store.size}`);
  // Newest entries (oldest inserted last) must survive.
  assert.ok(store.has('key-1099'), 'newest entry survives trim');
}

console.error('agent-loop push-guard: per-instance store isolation ✓');
