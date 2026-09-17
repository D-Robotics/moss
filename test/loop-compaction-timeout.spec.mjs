#!/usr/bin/env node
/**
 * Compaction timeout — tests resolveCompactionPrepareTimeoutMs for
 * correct default/env resolution and runWithCompactionPrepareTimeout
 * for normal completion, timeout, and pre-aborted signal behavior.
 */
import assert from 'node:assert/strict';
import {
  resolveCompactionPrepareTimeoutMs,
  runWithCompactionPrepareTimeout,
} from '../dist/core/loop/compaction-timeout.js';

// ─── resolveCompactionPrepareTimeoutMs ───────────────────────────────────────

{
  // Default value (no env set)
  const original = process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  delete process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  const result = resolveCompactionPrepareTimeoutMs();
  assert.equal(result, 30_000, 'default timeout is 30000ms');
  if (original !== undefined) process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = original;
}

{
  // Env override — valid positive number
  const original = process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = '5000';
  const result = resolveCompactionPrepareTimeoutMs();
  assert.equal(result, 5000, 'env override to 5000ms');
  if (original !== undefined) {
    process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = original;
  } else {
    delete process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  }
}

{
  // Env override — invalid (non-numeric)
  const original = process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = 'not-a-number';
  const result = resolveCompactionPrepareTimeoutMs();
  assert.equal(result, 30_000, 'invalid env falls back to default 30000ms');
  if (original !== undefined) {
    process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = original;
  } else {
    delete process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  }
}

{
  // Env override — negative number
  const original = process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = '-100';
  const result = resolveCompactionPrepareTimeoutMs();
  assert.equal(result, 30_000, 'negative env falls back to default');
  if (original !== undefined) {
    process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = original;
  } else {
    delete process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  }
}

{
  // Env override — decimal gets floored
  const original = process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = '100.9';
  const result = resolveCompactionPrepareTimeoutMs();
  assert.equal(result, 100, 'decimal env value gets floored to 100');
  if (original !== undefined) {
    process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS = original;
  } else {
    delete process.env.MOSS_COMPACTION_PREPARE_TIMEOUT_MS;
  }
}

// ─── runWithCompactionPrepareTimeout — normal completion ─────────────────────

{
  const result = await runWithCompactionPrepareTimeout(
    async (signal) => {
      assert.ok(signal, 'signal is provided to task');
      assert.equal(signal.aborted, false, 'signal not aborted at start');
      return 'done';
    },
    { timeoutMs: 5000 }
  );
  assert.equal(result, 'done', 'task result returned on normal completion');
}

{
  // Task that takes some time but completes within timeout
  const result = await runWithCompactionPrepareTimeout(
    async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 42;
    },
    { timeoutMs: 5000 }
  );
  assert.equal(result, 42, 'slow task completes within timeout');
}

// ─── runWithCompactionPrepareTimeout — timeout ───────────────────────────────

{
  // Task that never completes — should timeout
  await assert.rejects(
    async () => {
      await runWithCompactionPrepareTimeout(
        async () => {
          // Never resolves within the timeout
          return new Promise(() => {});
        },
        { timeoutMs: 50, label: 'test' }
      );
    },
    (err) => {
      assert.ok(err instanceof Error, 'timeout produces Error');
      assert.ok(
        err.message.includes('timed out'),
        `error message mentions timeout: ${err.message}`
      );
      return true;
    },
    'never-completing task times out'
  );
}

// ─── runWithCompactionPrepareTimeout — pre-aborted signal ────────────────────

{
  // Pre-aborted signal should throw immediately
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));
  await assert.rejects(
    async () => {
      await runWithCompactionPrepareTimeout(async () => 'should not reach', {
        abortSignal: controller.signal,
        timeoutMs: 5000,
      });
    },
    (err) => {
      assert.ok(err instanceof Error, 'pre-abort produces Error');
      return true;
    },
    'pre-aborted signal throws immediately'
  );
}

// ─── runWithCompactionPrepareTimeout — custom label ──────────────────────────

{
  await assert.rejects(
    async () => {
      await runWithCompactionPrepareTimeout(async () => new Promise(() => {}), {
        timeoutMs: 50,
        label: 'custom-label',
      });
    },
    (err) => {
      assert.ok(
        err.message.includes('custom-label'),
        `error message includes custom label: ${err.message}`
      );
      return true;
    },
    'custom label appears in timeout error'
  );
}

console.log('✅ loop-compaction-timeout.spec.mjs — all tests passed');
