#!/usr/bin/env node
/**
 * MossAgent durable inbox: admitted prompts persist under the workspace and are
 * replayed by a fresh agent instance (survives restart). With no workspaceDir the
 * inbox stays in-memory. Uses a fake `this` (config + inboxes + streamChat) so no
 * real provider/session store is needed.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MossAgent } from '../dist/core/index.js';

function makeAgent(workspaceDir, calls) {
  return Object.assign(Object.create(MossAgent.prototype), {
    config: { workspaceDir },
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-inbox-durable-'));
try {
  const calls = [];

  // Admit on one instance; the prompt is written under <workspace>/.moss/inbox/.
  const a1 = makeAgent(tmp, calls);
  a1.admit('work', 'remember me', { delivery: 'queue' });
  assert.ok(fs.existsSync(path.join(tmp, '.moss', 'inbox')), 'inbox dir created under workspace');

  // A fresh instance over the same workspace replays the pending admission.
  const a2 = makeAgent(tmp, calls);
  assert.deepEqual(a2.inboxPending('work').map((e) => e.prompt), ['remember me'], 'pending admission survives restart');

  // Draining it runs the prompt and clears the durable file's pending state.
  const { chats } = await a2.drainInbox('work');
  assert.deepEqual(chats.map((c) => c.response), ['echo:remember me']);
  const a3 = makeAgent(tmp, calls);
  assert.equal(a3.inboxPending('work').length, 0, 'drained inbox is empty after restart');

  // No workspaceDir -> purely in-memory, no files written.
  const memOnly = makeAgent(undefined, calls);
  memOnly.admit('s', 'ephemeral');
  assert.equal(memOnly.inboxPending('s').length, 1, 'in-memory admission still works without a workspace');

  console.log('[PASS] MossAgent durable inbox: admission persists + replays across instances');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
