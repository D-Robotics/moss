#!/usr/bin/env node
/**
 * Pending tool aborts — tests notePendingAbortedToolCalls and
 * consumePendingAbortedToolSyntheticMessages for correct
 * note/consume lifecycle and session isolation.
 */
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { PendingToolAbortStore } from '../dist/core/loop/pending-tool-aborts.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { PendingToolAbortStore as PublicPendingToolAbortStore } from '../dist/index.js';

assert.equal(
  PublicPendingToolAbortStore,
  PendingToolAbortStore,
  'the public barrel exposes the store required for direct runAgentLoop isolation'
);

const pendingAborts = new PendingToolAbortStore();

// ─── consume with no prior note returns empty ────────────────────────────────

{
  const result = pendingAborts.consumeSyntheticMessages('never-noted');
  assert.deepEqual(result, [], 'consume without note returns empty array');
}

// ─── note then consume returns synthetic messages ────────────────────────────

{
  const sessionKey = 'test-note-consume-' + Date.now();
  pendingAborts.note(sessionKey, [
    { id: 'tool-1', name: 'exec' },
    { id: 'tool-2', name: 'file_read' },
  ]);

  const messages = pendingAborts.consumeSyntheticMessages(sessionKey);
  assert.equal(messages.length, 1, 'returns single user message');
  assert.equal(messages[0].role, 'user', 'message role is user');

  const content = messages[0].content;
  assert.ok(Array.isArray(content), 'content is array');
  assert.equal(content.length, 2, '2 tool_result blocks');

  // Each block should be a tool_result with is_error
  for (const block of content) {
    assert.equal(block.type, 'tool_result', 'block type is tool_result');
    assert.equal(block.is_error, true, 'block is_error is true');
    const parsed = JSON.parse(block.content);
    assert.equal(parsed.output, 'aborted', 'output is aborted');
    assert.equal(parsed.metadata.exit_code, 1, 'exit_code is 1');
    assert.equal(parsed.metadata.reason, 'user_cancelled', 'reason is user_cancelled');
  }
}

// ─── consume clears the pending aborts ───────────────────────────────────────

{
  const sessionKey = 'test-clear-' + Date.now();
  pendingAborts.note(sessionKey, [{ id: 'tool-a', name: 'exec' }]);
  pendingAborts.consumeSyntheticMessages(sessionKey);

  // Second consume should return empty
  const result = pendingAborts.consumeSyntheticMessages(sessionKey);
  assert.deepEqual(result, [], 'second consume returns empty after first consume cleared');
}

// ─── session isolation ───────────────────────────────────────────────────────

{
  const sessionA = 'session-a-' + Date.now();
  const sessionB = 'session-b-' + Date.now();

  pendingAborts.note(sessionA, [{ id: 'tool-a1', name: 'exec' }]);
  pendingAborts.note(sessionB, [{ id: 'tool-b1', name: 'file_read' }]);

  const messagesA = pendingAborts.consumeSyntheticMessages(sessionA);
  const messagesB = pendingAborts.consumeSyntheticMessages(sessionB);

  assert.equal(messagesA.length, 1, 'session A has 1 message');
  assert.equal(messagesB.length, 1, 'session B has 1 message');

  // Verify content isolation
  const contentA = messagesA[0].content;
  const contentB = messagesB[0].content;
  assert.equal(contentA[0].name, 'exec', 'session A has exec tool');
  assert.equal(contentB[0].name, 'file_read', 'session B has file_read tool');
}

// ─── empty calls array is a no-op ────────────────────────────────────────────

{
  const sessionKey = 'test-empty-' + Date.now();
  pendingAborts.note(sessionKey, []);
  const result = pendingAborts.consumeSyntheticMessages(sessionKey);
  assert.deepEqual(result, [], 'noting empty calls array produces nothing to consume');
}

// ─── note accumulates across calls ───────────────────────────────────────────

{
  const sessionKey = 'test-accumulate-' + Date.now();
  pendingAborts.note(sessionKey, [{ id: 'tool-1', name: 'exec' }]);
  pendingAborts.note(sessionKey, [{ id: 'tool-2', name: 'file_read' }]);

  const messages = pendingAborts.consumeSyntheticMessages(sessionKey);
  assert.equal(messages[0].content.length, 2, 'accumulated 2 tool calls across notes');
}

// ─── tool_use_id preserved in synthetic messages ─────────────────────────────

{
  const sessionKey = 'test-id-' + Date.now();
  pendingAborts.note(sessionKey, [{ id: 'call-xyz-123', name: 'exec' }]);
  const messages = pendingAborts.consumeSyntheticMessages(sessionKey);
  assert.equal(
    messages[0].content[0].tool_use_id,
    'call-xyz-123',
    'tool_use_id preserved in synthetic message'
  );
}

// ─── MossAgent instances isolate the same sessionKey ────────────────────────

{
  const provider = {
    id: 'pending-tool-abort-isolation',
    capabilities: { streaming: true },
    async complete() {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async stream(options, onEvent) {
      const result = await this.complete(options);
      onEvent({ type: 'content_block_delta', text: 'done' });
      onEvent({ type: 'message_stop' });
      return result;
    },
  };
  const createAgent = () => {
    const sessionStore = new InMemorySessionStore();
    return {
      sessionStore,
      agent: new MossAgent({
        llmProvider: provider,
        sessionStore,
        baseSystemPrompt: 'test',
        domainPrompt: false,
        enableSteering: false,
        enableFollowUpGuard: false,
      }),
    };
  };
  const { agent: agentA, sessionStore: storeA } = createAgent();
  const { agent: agentB, sessionStore: storeB } = createAgent();
  const sessionKey = 'shared-session-key';

  assert.notEqual(
    agentA.pendingToolAborts,
    agentB.pendingToolAborts,
    'each MossAgent owns a distinct pending-abort store'
  );
  agentA.pendingToolAborts.note(sessionKey, [{ id: 'tool-a', name: 'exec' }]);

  await agentB.chat(sessionKey, 'run B');
  assert.doesNotMatch(JSON.stringify(await storeB.loadMessages(sessionKey)), /tool-a/);

  await agentA.chat(sessionKey, 'resume A');
  assert.match(
    JSON.stringify(await storeA.loadMessages(sessionKey)),
    /"tool_use_id":"tool-a"/,
    'agent A consumes and persists its own aborted tool'
  );
}

console.log('✅ loop-pending-tool-aborts.spec.mjs — all tests passed');
