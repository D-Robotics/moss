#!/usr/bin/env node
/**
 * MossAgent event sourcing: streamChatRecorded transparently records a turn into a
 * durable event log under the workspace; a fresh instance projects the same
 * conversation back. Without a workspace it degrades to a no-op recorder. Uses a
 * fake `this` (config + streamChat) so no real provider is needed.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MossAgent } from '../dist/core/index.js';

function makeAgent(workspaceDir) {
  return Object.assign(Object.create(MossAgent.prototype), {
    config: { workspaceDir },
    async *streamChat(_sessionKey, userMessage) {
      yield { type: 'turn_start', turn: 0 };
      yield { type: 'text_delta', delta: `echo:${userMessage}` };
      yield { type: 'tool_start', toolName: 'shell', toolCallId: 'c1', input: {} };
      yield { type: 'tool_end', toolName: 'shell', toolCallId: 'c1', result: 'ok', isError: false };
      yield { type: 'turn_end', turn: 0, stopReason: 'end_turn' };
      yield {
        type: 'done',
        result: { response: `echo:${userMessage}`, toolCalls: [], toolResults: [], stopReason: 'end_turn' },
      };
    },
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-es-'));
try {
  const a1 = makeAgent(tmp);

  // Drive a recorded turn; the stream is forwarded unchanged.
  const forwarded = [];
  for await (const e of a1.streamChatRecorded('work', 'run tests')) forwarded.push(e.type);
  assert.deepEqual(forwarded, ['turn_start', 'text_delta', 'tool_start', 'tool_end', 'turn_end', 'done']);

  // The event log is persisted under <workspace>/.moss/events/.
  assert.ok(fs.existsSync(path.join(tmp, '.moss', 'events')), 'event log dir created');

  // A second turn appends to the same durable log.
  for await (const _ of a1.streamChatRecorded('work', 'again')) { /* drain */ }

  // A fresh instance reads + projects the durable history (replay across restart).
  const a2 = makeAgent(tmp);
  const convo = a2.projectedConversation('work');
  assert.deepEqual(convo.map((m) => `${m.role}:${m.text}`), [
    'user:run tests', 'assistant:echo:run tests',
    'user:again', 'assistant:echo:again',
  ]);
  assert.deepEqual(convo[1].tools.map((t) => `${t.name}:${t.status}`), ['shell:succeeded']);
  assert.ok(a2.sessionEvents('work').length >= 12, 'durable events persisted across instances');

  // No workspace -> recorder is a transparent no-op (still forwards the stream).
  const mem = makeAgent(undefined);
  const seen = [];
  for await (const e of mem.streamChatRecorded('s', 'hi')) seen.push(e.type);
  assert.ok(seen.includes('done'));
  assert.deepEqual(mem.sessionEvents('s'), [], 'no events without a workspace');

  console.log('[PASS] MossAgent event sourcing: recorded turns persist + project across instances');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
