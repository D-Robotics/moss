#!/usr/bin/env node
/**
 * /rewind conversation rewind — grok-style: rewinding a checkpoint also
 * discards the prompt's turn + everything after from the LLM context, not
 * only restoring files.
 *
 * - FileCheckpointStore records messageCount at open() and returns it from
 *   rewindTo() so the TUI can pass it to agent.rewindConversation.
 * - MossAgent.rewindConversation truncates the persisted message store to
 *   the recorded count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileCheckpointStore } from '../dist/cli/file-checkpoint.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';

function makeProvider() {
  return {
    id: 'rewind-test',
    capabilities: { streaming: false },
    async complete() {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

function makeAgent(store) {
  return new MossAgent({
    llmProvider: makeProvider(),
    sessionStore: store,
    baseSystemPrompt: 'test',
    domainPrompt: false,
    contextTokens: 10_000,
    maxTokens: 100,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
}

// ── FileCheckpointStore: messageCount recorded + returned ─────────────────

test('FileCheckpointStore.open records messageCount and rewindTo returns it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rewind-cp-'));
  try {
    const store = new FileCheckpointStore({ runtimeDir: dir, sessionKey: 's1' });
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'before');
    store.open('fix the bug', 4);
    store.trackBeforeWrite(target);
    fs.writeFileSync(target, 'after');
    store.noteAfterWrite(target);

    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].messageCount, 4, 'checkpoint records messageCount');

    const result = store.rewindTo(list[0].seq);
    assert.equal(result.found, true);
    assert.equal(
      result.messageCount,
      4,
      'rewindTo returns the messageCount for conversation rewind'
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'before', 'file restored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── MossAgent.rewindConversation ──────────────────────────────────────────

test('rewindConversation truncates the message store to the given count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rewind-agent-'));
  try {
    const store = new JsonlSessionStore({ dir });
    const agent = makeAgent(store);
    await store.replaceMessages('s1', [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'text', text: '1' }] },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: [{ type: 'text', text: '2' }] },
    ]);
    const rew = await agent.rewindConversation('s1', 2);
    assert.equal(rew.truncated, 2, 'reports the number of discarded messages');
    const after = await store.loadMessages('s1');
    assert.equal(after.length, 2, 'store truncated to 2');
    assert.equal(after[0].role, 'user');
    assert.equal(after[1].role, 'assistant');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rewindConversation is a no-op when the count is already at or before', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rewind-noop-'));
  try {
    const store = new JsonlSessionStore({ dir });
    const agent = makeAgent(store);
    await store.replaceMessages('s1', [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'text', text: '1' }] },
    ]);
    const rew = await agent.rewindConversation('s1', 5);
    assert.equal(rew.truncated, 0, 'nothing to truncate when count >= length');
    const after = await store.loadMessages('s1');
    assert.equal(after.length, 2, 'store unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
