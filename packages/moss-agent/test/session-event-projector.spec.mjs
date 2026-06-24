#!/usr/bin/env node
/**
 * Session event projector: replaying a durable log yields deterministic
 * conversation state (user prompts + assistant turns with text, reasoning, and
 * tool-call lifecycle).
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { SessionEventLog } from '../dist/core/session/session-event.js';
import { projectSessionMessages } from '../dist/core/session/session-event-projector.js';

const log = new SessionEventLog('ses-1');
log.append({ type: 'prompt.admitted', data: { prompt: 'invisible until promoted' } });
log.append({ type: 'prompt.promoted', data: { prompt: 'list failing tests' } });
log.append({ type: 'step.started', data: { model: 'm' } });
log.append({ type: 'reasoning.delta', data: { text: 'thinking…' } });
log.append({ type: 'text.delta', data: { text: 'Here are ' } });
log.append({ type: 'text.delta', data: { text: 'the tests:' } });
log.append({ type: 'tool.called', data: { callId: 'c1', name: 'shell' } });
log.append({ type: 'tool.succeeded', data: { callId: 'c1', name: 'shell' } });
log.append({ type: 'tool.called', data: { callId: 'c2', name: 'grep' } });
log.append({ type: 'tool.failed', data: { callId: 'c2', name: 'grep' } });
log.append({ type: 'step.ended', data: { tokens: 12 } });

const messages = projectSessionMessages(log.all());

assert.equal(messages.length, 2, 'one user + one assistant message');
assert.deepEqual(messages[0], { role: 'user', text: 'list failing tests' }, 'admitted-but-unpromoted is not visible');

const assistant = messages[1];
assert.equal(assistant.role, 'assistant');
assert.equal(assistant.text, 'Here are the tests:', 'streamed text deltas concatenate');
assert.equal(assistant.thinking, 'thinking…');
assert.deepEqual(
  assistant.tools.map((t) => `${t.name}:${t.status}`),
  ['shell:succeeded', 'grep:failed'],
  'tool-call lifecycle resolves by callId',
);

// Determinism: replaying the same events twice yields identical state.
assert.deepEqual(projectSessionMessages(log.all()), projectSessionMessages(log.toEvents()));

console.log('[PASS] session event projector: deterministic conversation projection from the log');
