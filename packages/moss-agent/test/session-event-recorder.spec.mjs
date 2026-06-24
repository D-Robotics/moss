#!/usr/bin/env node
/**
 * Session event recorder: wrapping an agent stream records a faithful durable log
 * (yielded events are unchanged), which projects back to the conversation.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { SessionEventLog } from '../dist/core/session/session-event.js';
import { recordAgentStream } from '../dist/core/session/session-event-recorder.js';
import { projectSessionMessages } from '../dist/core/session/session-event-projector.js';

async function* mockTurn() {
  yield { type: 'turn_start', turn: 0 };
  yield { type: 'thinking_delta', delta: 'hmm ' };
  yield { type: 'text_delta', delta: 'Running ' };
  yield { type: 'text_delta', delta: 'tests.' };
  yield { type: 'tool_start', toolName: 'shell', toolCallId: 'c1', input: {} };
  yield { type: 'tool_end', toolName: 'shell', toolCallId: 'c1', result: 'ok', isError: false };
  yield { type: 'turn_end', turn: 0, stopReason: 'end_turn' };
  yield { type: 'done', result: { response: 'Running tests.', toolCalls: [], toolResults: [], stopReason: 'end_turn' } };
}

const log = new SessionEventLog('ses-rec');
const forwarded = [];
for await (const e of recordAgentStream(log, 'run the tests', mockTurn())) {
  forwarded.push(e.type);
}

// The stream is forwarded unchanged (transparent middleware).
assert.deepEqual(forwarded, [
  'turn_start', 'thinking_delta', 'text_delta', 'text_delta', 'tool_start', 'tool_end', 'turn_end', 'done',
]);

// The recorded log projects back to the conversation.
const messages = projectSessionMessages(log.all());
assert.deepEqual(messages[0], { role: 'user', text: 'run the tests' });
assert.equal(messages[1].role, 'assistant');
assert.equal(messages[1].text, 'Running tests.', 'text deltas recorded + projected');
assert.equal(messages[1].thinking, 'hmm ');
assert.deepEqual(messages[1].tools.map((t) => `${t.name}:${t.status}`), ['shell:succeeded']);

console.log('[PASS] session event recorder: transparent middleware records a replayable log');
