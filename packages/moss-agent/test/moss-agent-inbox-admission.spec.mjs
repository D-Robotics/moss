#!/usr/bin/env node
/**
 * MossAgent admission API: admit prompts durably (steer/queue), inspect pending
 * work, and drain them through the real chat() path. Additive — chat()/streamChat()
 * are unchanged. Uses a fake `this` (only inboxes + streamChat) like the other
 * chat() regression tests, so no real provider/session store is required.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/index.js';

function makeAgent(calls) {
  return Object.assign(Object.create(MossAgent.prototype), {
    inboxes: new Map(),
    async *streamChat(_sessionKey, userMessage) {
      calls.push(userMessage);
      yield {
        type: 'done',
        result: { response: `echo:${userMessage}`, toolCalls: [], toolResults: [], stopReason: 'end_turn' },
      };
    },
  });
}

// --- admit records durably without running; pending reflects admission order ---
const calls = [];
const agent = makeAgent(calls);
agent.admit('s', 'first', { delivery: 'queue' });
agent.admit('s', 'second'); // default steer
assert.equal(calls.length, 0, 'admit does not run the prompt');
assert.deepEqual(agent.inboxPending('s').map((e) => e.prompt), ['first', 'second']);

// --- per-session isolation: another session's inbox is independent ---
agent.admit('other', 'x');
assert.equal(agent.inboxPending('s').length, 2);
assert.equal(agent.inboxPending('other').length, 1);

// --- drain: the steer runs first (boundary), then the one queued entry ---
const { chats, drain } = await agent.drainInbox('s');
assert.deepEqual(calls, ['second', 'first'], 'steer promoted before queued; each ran via chat()');
assert.deepEqual(chats.map((c) => c.response), ['echo:second', 'echo:first']);
assert.equal(drain.turns, 2);
assert.deepEqual(agent.inboxPending('s'), [], 's inbox fully drained');
assert.equal(agent.inboxPending('other').length, 1, 'unrelated session untouched');

console.log('[PASS] MossAgent admission API: admit / inboxPending / drainInbox over real chat()');
