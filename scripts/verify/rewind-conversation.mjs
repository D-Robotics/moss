#!/usr/bin/env node
/**
 * Conversation-rewind probe (offline, scripted provider).
 *
 * Claude's `/rewind` restores code AND conversation. This checks the two
 * halves of Moss's plan: `countSessionMessages` is the rollback point a
 * checkpoint records, and `rewindConversation` truncates the persisted LLM
 * history (so the next prompt never sees the undone turn).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const { MossAgent } = await import(dist('core/agent/moss-agent.js'));
const { InMemorySessionStore } = await import(dist('core/session/session.js'));

const provider = {
  id: 'scripted',
  displayName: 'scripted (offline)',
  capabilities: { streaming: true },
  async complete() {
    return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ack' }] };
  },
  async stream(_options, onEvent) {
    const response = await this.complete();
    onEvent({ type: 'message_start' });
    onEvent({ type: 'content_block_start' });
    onEvent({ type: 'content_block_delta', text: 'ack' });
    onEvent({ type: 'content_block_stop' });
    onEvent({ type: 'message_delta', stopReason: response.stopReason });
    onEvent({ type: 'message_stop' });
    return response;
  },
};

const store = new InMemorySessionStore();
const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: store,
  baseSystemPrompt: 'You are a test agent.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
});
const sessionKey = 'rewind-probe';
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[rewind-conversation] ok ${name}`);
};

try {
  assert.equal(await agent.countSessionMessages(sessionKey), 0);
  await agent.chat(sessionKey, 'first message');
  const afterFirst = await agent.countSessionMessages(sessionKey);
  assert.ok(afterFirst >= 2, `first turn stored ${afterFirst} messages`);

  await agent.chat(sessionKey, 'second message');
  const afterSecond = await agent.countSessionMessages(sessionKey);
  assert.ok(afterSecond > afterFirst, 'second turn grew the history');
  ok('countSessionMessages tracks the stored history');

  const { truncated } = await agent.rewindConversation(sessionKey, afterFirst);
  assert.equal(truncated, afterSecond - afterFirst);
  assert.equal(await agent.countSessionMessages(sessionKey), afterFirst);
  const kept = await store.loadMessages(sessionKey);
  const texts = JSON.stringify(kept);
  assert.ok(texts.includes('first message'));
  assert.ok(!texts.includes('second message'), 'the undone turn is gone from LLM history');
  ok('rewindConversation drops exactly the undone turn');

  const noop = await agent.rewindConversation(sessionKey, afterFirst + 50);
  assert.equal(noop.truncated, 0, 'a target beyond the history is a no-op');
  ok('a forward target truncates nothing');

  // The checkpoint records the rollback point and hands it back on rewind.
  const runtimeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rewind-cp-')));
  const { FileCheckpointStore } = await import(dist('cli/file-checkpoint.js'));
  const ws = path.join(runtimeDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const target = path.join(ws, 'x.txt');
  fs.writeFileSync(target, 'orig');
  const cp = new FileCheckpointStore({ runtimeDir, sessionKey: 'cp' });
  cp.open('turn two', afterFirst);
  cp.trackBeforeWrite(target);
  fs.writeFileSync(target, 'changed');
  cp.noteAfterWrite(target);
  const restarted = new FileCheckpointStore({ runtimeDir, sessionKey: 'cp' });
  const result = restarted.rewindTo(1);
  assert.equal(result.messageCount, afterFirst);
  assert.equal(fs.readFileSync(target, 'utf8'), 'orig');
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  ok('a checkpoint carries the rollback point across a restart');
} finally {
  await agent.close();
}

// 5. B203: a stored harness correction never replays as a user turn.
{
  const { buildResumeReplay } = await import(dist('cli/resume-replay.js'));
  const replay = buildResumeReplay([
    { role: 'user', content: [{ type: 'text', text: 'add subtract() to sum.js' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Added subtract().' }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[System] You changed files but the last thing you did was answer your own claim.',
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Verified with node --test.' }] },
  ]);
  assert.deepEqual(
    replay.items.map((item) => `${item.kind}:${item.text}`),
    [
      'user:add subtract() to sum.js',
      'assistant:Added subtract().',
      'assistant:Verified with node --test.',
    ],
    'the correction is dropped; real user/assistant turns remain'
  );
  ok('a stored [System] correction is not replayed as a user turn');

  // 6. B204: the injected <turn-context> preamble never replays as user text.
  const withContext = buildResumeReplay([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Add subtract() to sum.js\n\n<turn-context>\n## Environment\n- Working directory: /tmp/x\n</turn-context>',
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Added.' }] },
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi\n\n<turn-context>\n## Available skills\n- a: b' }],
    },
  ]);
  assert.deepEqual(
    withContext.items.map((item) => `${item.kind}:${item.text}`),
    ['user:Add subtract() to sum.js', 'assistant:Added.', 'user:hi'],
    'the preamble is stripped, including an unclosed block'
  );
  ok('the injected <turn-context> preamble is stripped from replay');
}

console.log(`[rewind-conversation] ${checks}/${checks} checks passed`);
