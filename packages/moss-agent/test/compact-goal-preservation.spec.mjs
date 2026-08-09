#!/usr/bin/env node
/**
 * compactSession goal-checkpoint preservation — the contract that compactSession
 * must preserve the active goal's checkpoint across compaction.
 *
 * Before the fix, compactSession compacted ALL loaded messages (including the
 * goal checkpoint) and replaced the session with [summary, ...pruned] — if
 * pruning dropped the goal checkpoint, a later resume lost the goal state from
 * the LLM context. The fix: split the goal checkpoint out before compaction,
 * compact the clean conversation, then re-attach the checkpoint.
 *
 * This test exercises the round-trip compactSession now performs, using a real
 * JsonlSessionStore + the public goal helpers: write a session with a goal
 * checkpoint + many messages, simulate compaction (split → drop middle →
 * re-attach → replaceMessages), reload, and assert the goal survives.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import {
  createGoalState,
  createGoalCheckpointMessage,
  splitGoalCheckpointMessages,
  isGoalCheckpointMessage,
} from '../dist/core/goal/goal-state.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-compact-goal-'));
try {
  const store = new JsonlSessionStore({ dir: ws });
  const sessionKey = 's1';

  const goal = createGoalState({
    sessionKey,
    objective: 'add OAuth login page with tests',
  });
  const goalCheckpoint = createGoalCheckpointMessage(goal);

  // A conversation with the goal checkpoint somewhere in the middle.
  const messages = [
    { role: 'user', content: 'start working on the login page' },
    { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
    goalCheckpoint,
    { role: 'user', content: 'use Google OAuth' },
    { role: 'assistant', content: [{ type: 'text', text: 'got it' }] },
  ];
  await store.replaceMessages(sessionKey, messages);

  // Simulate compaction: split the goal out, "compact" the rest (here: keep
  // only a summary + the last turn), re-attach the goal checkpoint, persist.
  const loaded = await store.loadMessages(sessionKey);
  const split = splitGoalCheckpointMessages(loaded);
  assert.ok(split.goal, 'goal state parsed from the checkpoint');
  assert.equal(split.goal.objective, 'add OAuth login page with tests');
  assert.equal(split.goal.status, 'active');

  const summary = { role: 'user', content: '[compacted summary of earlier turns]' };
  const lastTurn = split.messages[split.messages.length - 1];
  const compacted = [
    summary,
    ...(split.messages.length > 1 ? [lastTurn] : []),
    createGoalCheckpointMessage(split.goal), // re-attach
  ];
  await store.replaceMessages(sessionKey, compacted);

  // Reload — the goal checkpoint must survive.
  const reloaded = await store.loadMessages(sessionKey);
  assert.ok(
    reloaded.some((m) => isGoalCheckpointMessage(m)),
    'goal checkpoint survived compaction (re-attached after)'
  );
  const reSplit = splitGoalCheckpointMessages(reloaded);
  assert.ok(reSplit.goal, 'goal state re-parses after compaction round-trip');
  assert.equal(reSplit.goal.objective, 'add OAuth login page with tests');
  assert.equal(reSplit.goal.status, 'active');
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

console.error(
  'compact-goal-preservation: goal checkpoint survives the split->compact->re-attach round-trip ✓'
);
