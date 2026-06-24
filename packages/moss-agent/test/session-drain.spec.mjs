#!/usr/bin/env node
/**
 * Session drain: the explicit per-turn runner that promotes admitted input with
 * steer/queue semantics and continues until the session would idle.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { SessionInbox } from '../dist/core/session/session-inbox.js';
import { runSessionDrain } from '../dist/core/session/session-drain.js';

// --- steers promote together, then one queued entry promotes when the drain idles ---
{
  const inbox = new SessionInbox();
  inbox.admit({ id: 's1', prompt: 'a', delivery: 'steer' });
  inbox.admit({ id: 's2', prompt: 'b', delivery: 'steer' });
  inbox.admit({ id: 'q1', prompt: 'c', delivery: 'queue' });
  const seen = [];
  const res = await runSessionDrain({
    inbox,
    runTurn: async (promoted, i) => (seen.push([i, promoted.map((e) => e.id)]), { continue: false }),
  });
  // turn 0 promotes both steers; turn 1 promotes one queued entry.
  assert.deepEqual(seen, [[0, ['s1', 's2']], [1, ['q1']]]);
  assert.deepEqual(res.promoted, ['s1', 's2', 'q1']);
  assert.equal(res.turns, 2);
  assert.equal(inbox.hasPendingWork(), false);
}

// --- a turn that owes continuation runs again with no new input ---
{
  const inbox = new SessionInbox();
  inbox.admit({ id: 's1', prompt: 'a' });
  let calls = 0;
  const seen = [];
  await runSessionDrain({
    inbox,
    runTurn: async (promoted, i) => {
      seen.push([i, promoted.map((e) => e.id)]);
      return { continue: calls++ === 0 }; // first turn owes a continuation
    },
  });
  assert.deepEqual(seen, [[0, ['s1']], [1, []]], 'continuation turn runs with empty promotion');
}

// --- a steer admitted DURING a run promotes at the next boundary ---
{
  const inbox = new SessionInbox();
  inbox.admit({ id: 's1', prompt: 'a' });
  const seen = [];
  let injected = false;
  await runSessionDrain({
    inbox,
    runTurn: async (promoted, i) => {
      seen.push(promoted.map((e) => e.id));
      if (!injected) {
        injected = true;
        inbox.admit({ id: 's2', prompt: 'mid-run steer' });
        return { continue: true };
      }
      return { continue: false };
    },
  });
  assert.deepEqual(seen, [['s1'], ['s2']], 'mid-run steer folds into the next boundary');
}

// --- maxTurns bounds an always-continuing turn ---
{
  const inbox = new SessionInbox();
  inbox.admit({ id: 's1', prompt: 'a' });
  const res = await runSessionDrain({ inbox, runTurn: async () => ({ continue: true }), maxTurns: 4 });
  assert.equal(res.turns, 4);
  assert.equal(res.stoppedAtLimit, true);
}

console.log('[PASS] runSessionDrain: steer/queue promotion, continuation, mid-run steering, maxTurns');
