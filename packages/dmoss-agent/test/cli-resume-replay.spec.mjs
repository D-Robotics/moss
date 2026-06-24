#!/usr/bin/env node
/**
 * /resume must re-display the conversation, not land on a blank screen.
 * These cover the pure helpers that turn stored messages into transcript rows.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-resume-replay.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  buildResumeReplay,
  resumedMessageText,
  RESUME_REPLAY_MAX,
} from '../dist/cli/tui.js';

// resumedMessageText: string content passes through; blocks keep only text.
assert.equal(resumedMessageText({ role: 'user', content: '  fix the parser  ' }), 'fix the parser');
assert.equal(
  resumedMessageText({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Looking at it.' },
      { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } },
    ],
  }),
  'Looking at it.',
);
// A turn carrying only tool protocol (no human text) yields nothing.
assert.equal(
  resumedMessageText({ role: 'user', content: [{ type: 'tool_result', content: 'rdk-x5\n' }] }),
  '',
);
// Internal goal checkpoints are not conversation — they must be dropped.
assert.equal(
  resumedMessageText({ role: 'user', content: '<dmoss_working_context_checkpoint>{...}</dmoss_working_context_checkpoint>' }),
  '',
);

// buildResumeReplay: keeps user/assistant text turns in order, drops tool/checkpoint/empty.
{
  const messages = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }, { type: 'tool_use', name: 'exec', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] }, // dropped
    { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    { role: 'system', content: 'system noise' }, // dropped (not user/assistant)
    { role: 'user', content: '<dmoss_working_context_checkpoint>x</dmoss_working_context_checkpoint>' }, // dropped
    { role: 'user', content: 'follow-up' },
  ];
  const replay = buildResumeReplay(messages);
  assert.equal(replay.hiddenCount, 0, 'short conversation hides nothing');
  assert.deepEqual(
    replay.items,
    [
      { kind: 'user', text: 'first question' },
      { kind: 'assistant', text: 'first answer' },
      { kind: 'assistant', text: 'second answer' },
      { kind: 'user', text: 'follow-up' },
    ],
    'only real user/assistant text survives, in order',
  );
}

// Caps to the most recent `max` turns and reports how many were elided.
{
  const many = Array.from({ length: RESUME_REPLAY_MAX + 5 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const replay = buildResumeReplay(many);
  assert.equal(replay.items.length, RESUME_REPLAY_MAX, 'replay is capped to RESUME_REPLAY_MAX rows');
  assert.equal(replay.hiddenCount, 5, 'hiddenCount reports elided older turns');
  assert.equal(replay.items[0].text, 'msg 5', 'keeps the most recent turns, not the oldest');
  assert.equal(replay.items[RESUME_REPLAY_MAX - 1].text, `msg ${RESUME_REPLAY_MAX + 4}`);
}

// An empty/failed load replays nothing rather than throwing.
{
  const replay = buildResumeReplay([]);
  assert.deepEqual(replay.items, []);
  assert.equal(replay.hiddenCount, 0);
}

console.log('[PASS] /resume replays the conversation into the transcript');
