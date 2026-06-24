#!/usr/bin/env node
/**
 * Session inbox: durable prompt admission with steer/queue delivery semantics,
 * separated from execution, and serializable for durable replay.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { SessionInbox, SessionInboxConflictError } from '../dist/core/session/session-inbox.js';

// --- admission assigns monotonic sequences; default delivery is steer ---
const inbox = new SessionInbox();
const a = inbox.admit({ prompt: 'first' });
const b = inbox.admit({ prompt: 'second', delivery: 'queue' });
const c = inbox.admit({ prompt: 'third', delivery: 'steer' });
assert.equal(a.delivery, 'steer', 'default delivery is steer');
assert.deepEqual([a.admittedSeq, b.admittedSeq, c.admittedSeq], [1, 2, 3], 'admission seq is monotonic');
assert.equal(inbox.pending().length, 3);

// --- steers promote together (admission order); queue excluded ---
assert.deepEqual(
  inbox.promotableSteers().map((e) => e.prompt),
  ['first', 'third'],
  'promotableSteers returns all pending steers in admission order',
);
assert.equal(inbox.nextQueued().prompt, 'second', 'nextQueued returns the first pending queued entry');

// --- promoting steers leaves only the queued entry, which promotes one at a time ---
inbox.promote(a.id);
inbox.promote(c.id);
assert.deepEqual(inbox.promotableSteers(), [], 'no steers pending after promotion');
assert.equal(inbox.nextQueued().prompt, 'second', 'queued entry still pending');
assert.equal(inbox.hasPendingWork(), true);
inbox.promote(b.id);
assert.equal(inbox.nextQueued(), undefined);
assert.equal(inbox.hasPendingWork(), false, 'inbox drains once every entry is promoted');

// --- duplicate admission id is a clear conflict, not a silent overwrite ---
const inbox2 = new SessionInbox();
inbox2.admit({ id: 'p1', prompt: 'x' });
assert.throws(() => inbox2.admit({ id: 'p1', prompt: 'y' }), SessionInboxConflictError);

// --- serialize + restore: counters resume, pending state preserved ---
const fresh = new SessionInbox();
fresh.admit({ id: 'k1', prompt: 'kept', delivery: 'queue' });
fresh.admit({ id: 'k2', prompt: 'gone', delivery: 'steer' });
fresh.promote('k2');
const restored = SessionInbox.fromEntries(fresh.toEntries());
assert.equal(restored.hasPendingWork(), true, 'restored inbox keeps unpromoted work');
assert.equal(restored.nextQueued().id, 'k1', 'restored queued entry survives');
// next admission continues the sequence (3), not restart at 1
assert.equal(restored.admit({ prompt: 'new' }).admittedSeq, 3, 'admission seq resumes after restore');

console.log('[PASS] SessionInbox: durable admission with steer/queue delivery + replay');
