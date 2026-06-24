#!/usr/bin/env node
/**
 * Context epoch: an immutable baseline (provider-cache prefix) plus incremental
 * reconciliation that emits chronological system-update messages instead of
 * rewriting the baseline when a source changes mid-conversation.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { initializeEpoch, reconcileEpoch, replaceEpoch } from '../dist/core/session/context-epoch.js';

// --- initialize captures a deterministic baseline (sorted) and snapshot ---
const epoch = initializeEpoch({ cwd: '/work', date: '2026-06-24' }, 5);
assert.equal(epoch.baselineSeq, 5);
assert.equal(epoch.baseline, 'cwd: /work\ndate: 2026-06-24', 'baseline renders sorted key: value lines');

// --- unchanged sources reconcile to no update ---
assert.deepEqual(reconcileEpoch(epoch, { cwd: '/work', date: '2026-06-24' }), { type: 'unchanged' });

// --- a changed source emits one chronological update; baseline is untouched ---
const changed = reconcileEpoch(epoch, { cwd: '/work', date: '2026-06-25' });
assert.equal(changed.type, 'updated');
assert.match(changed.message, /date is now: 2026-06-25/);
assert.doesNotMatch(changed.message, /cwd/, 'unchanged sources are not mentioned');
assert.equal(epoch.baseline, 'cwd: /work\ndate: 2026-06-24', 'baseline stays immutable across reconcile');
assert.equal(changed.snapshot.values.date, '2026-06-25', 'snapshot advances to current');

// --- added and removed sources are both reported ---
const addedRemoved = reconcileEpoch(epoch, { cwd: '/work', skills: 'rdk-camera' });
assert.equal(addedRemoved.type, 'updated');
assert.match(addedRemoved.message, /skills is now: rdk-camera/);
assert.match(addedRemoved.message, /date is no longer in effect/);

// --- replace begins a fresh baseline from current sources ---
const next = replaceEpoch({ cwd: '/work', date: '2026-06-25' }, 12);
assert.equal(next.baselineSeq, 12);
assert.match(next.baseline, /date: 2026-06-25/);

console.log('[PASS] ContextEpoch: immutable baseline + incremental system-update reconciliation');
