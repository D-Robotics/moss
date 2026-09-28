#!/usr/bin/env node
/**
 * Characterization tests for cli/tui-utils.ts core pure helpers (queue,
 * sanitizing, truncation) ahead of the tui-utils.ts split (cleanup plan
 * Task 6.2). Existing specs cover rendering paths; these lock the pure
 * function surface. Assertions are probe-observed against dist/ on
 * 2026-09-28 — they lock CURRENT behavior, not intended behavior.
 *
 * Probe findings that differ from the plan skeleton:
 *   - sanitizeTextForTerminal requires the { breakLongTokens } option
 *     (calling it without options throws TypeError).
 *   - queueItemKind takes QueuedInput { raw, message } — the skeleton's
 *     { kind, text } shape throws (raw is undefined).
 *   - dropLastQueuedInput returns { next, dropped } — not { items }.
 *   - OSC sequences are only partially stripped: "\u001b]" matches the
 *     two-char escape class in ANSI_RE, so ESC] and the BEL are removed
 *     but the payload text survives.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendLimited,
  buildResumeReplay,
  dropLastQueuedInput,
  formatQueueWait,
  isImmediateGoalCommand,
  isQueueControlCommand,
  LOCAL_SHELL_OUTPUT_LIMIT,
  MAX_INPUT_HISTORY,
  queueItemKind,
  queueItemMeta,
  queuePausedSubmissionMessage,
  queueResumedMessage,
  resumedToolLines,
  sanitizeTextForTerminal,
  SerialQueueDrain,
  shouldDrainQueue,
  stopRequestedMessage,
  truncateTerminalText,
} from '../dist/cli/tui-utils.js';

// ─── sanitizeTextForTerminal ─────────────────────────────────────────────────

test('sanitizeTextForTerminal requires the { breakLongTokens } option (characterization)', () => {
  assert.throws(() => sanitizeTextForTerminal('\u001b[31mred\u001b[0m\ttext'), TypeError);
});

test('sanitizeTextForTerminal strips ANSI CSI escapes (characterization)', () => {
  assert.equal(
    sanitizeTextForTerminal('\u001b[31mred\u001b[0m\ttext', { breakLongTokens: false }),
    'red\ttext'
  );
});

test('sanitizeTextForTerminal only partially strips OSC sequences (characterization)', () => {
  // ESC] matches the two-char escape class; the BEL is dropped as a control
  // char, but the OSC payload text survives. Locked as-is.
  assert.equal(
    sanitizeTextForTerminal('\u001b]0;title\u0007body', { breakLongTokens: false }),
    '0;titlebody'
  );
});

test('sanitizeTextForTerminal removes control chars but keeps tabs (characterization)', () => {
  assert.equal(
    sanitizeTextForTerminal('a\u0000b\u0007c\u001bd', { breakLongTokens: false }),
    'abcd'
  );
  assert.equal(sanitizeTextForTerminal('col1\tcol2', { breakLongTokens: false }), 'col1\tcol2');
});

test('sanitizeTextForTerminal breaks space-free ASCII tokens at 24 chars (characterization)', () => {
  // 32 chars: below the LONG_TOKEN_RE threshold of 33, never broken.
  assert.equal(sanitizeTextForTerminal('x'.repeat(32), { breakLongTokens: true }), 'x'.repeat(32));
  // 33 chars: space inserted after the first 24.
  assert.equal(
    sanitizeTextForTerminal('x'.repeat(33), { breakLongTokens: true }),
    `${'x'.repeat(24)} ${'x'.repeat(9)}`
  );
  assert.equal(
    sanitizeTextForTerminal('x'.repeat(40), { breakLongTokens: true }),
    `${'x'.repeat(24)} ${'x'.repeat(16)}`
  );
  // breakLongTokens: false leaves long tokens alone.
  assert.equal(sanitizeTextForTerminal('x'.repeat(40), { breakLongTokens: false }), 'x'.repeat(40));
});

test('sanitizeTextForTerminal never breaks copy-sensitive or CJK tokens (characterization)', () => {
  assert.equal(
    sanitizeTextForTerminal('a_'.repeat(20), { breakLongTokens: true }),
    'a_'.repeat(20)
  );
  assert.equal(
    sanitizeTextForTerminal('中'.repeat(30), { breakLongTokens: true }),
    '中'.repeat(30)
  );
});

test('sanitizeTextForTerminal wraps RTL lines with isolates (characterization)', () => {
  assert.equal(sanitizeTextForTerminal('שלום', { breakLongTokens: false }), '\u2067שלום\u2069');
});

// ─── truncateTerminalText ────────────────────────────────────────────────────

test('truncateTerminalText cuts to width with an ellipsis (characterization)', () => {
  assert.equal(truncateTerminalText('abcdef', 3), 'ab…');
  assert.equal(truncateTerminalText('abcdef', 5), 'abcd…');
  assert.equal(truncateTerminalText('abcdef', 6), 'abcdef', 'fits exactly: unchanged');
  assert.equal(truncateTerminalText('abcdef', 1), '…', 'width 1 collapses to just the ellipsis');
  assert.equal(truncateTerminalText('abcdef', 0), '', 'non-positive width: empty');
  assert.equal(truncateTerminalText('', 5), '');
  // CJK cells count as width 2, so nothing fits before the ellipsis.
  assert.equal(truncateTerminalText('中文中', 2), '…');
});

// ─── queueItemKind ───────────────────────────────────────────────────────────

test('queueItemKind classifies by raw bang line, then /command, then prompt (characterization)', () => {
  assert.equal(queueItemKind({ raw: '!ls -la', message: '!ls -la' }), 'local shell');
  assert.equal(queueItemKind({ raw: '!', message: '!' }), 'prompt', 'a bare ! is a prompt');
  assert.equal(queueItemKind({ raw: '/help', message: '/help' }), 'command');
  assert.equal(queueItemKind({ raw: 'hello world', message: 'hello world' }), 'prompt');
});

// ─── dropLastQueuedInput ─────────────────────────────────────────────────────

test('dropLastQueuedInput returns { next, dropped } (characterization)', () => {
  const items = [
    { raw: 'a', message: 'a' },
    { raw: 'b', message: 'b' },
  ];
  assert.deepEqual(dropLastQueuedInput(items), {
    next: [{ raw: 'a', message: 'a' }],
    dropped: { raw: 'b', message: 'b' },
  });
  assert.deepEqual(dropLastQueuedInput([{ raw: 'a', message: 'a' }]), {
    next: [],
    dropped: { raw: 'a', message: 'a' },
  });
  assert.deepEqual(dropLastQueuedInput([]), { next: [] }, 'empty queue: no dropped key');
});

// ─── shouldDrainQueue ────────────────────────────────────────────────────────

test('shouldDrainQueue drains only when idle, unpaused, and queued (characterization)', () => {
  const base = { busy: false, approvalActive: false, pausedAfterCancel: false, queueLength: 2 };
  assert.equal(shouldDrainQueue(base), true);
  assert.equal(shouldDrainQueue({ ...base, busy: true }), false);
  assert.equal(shouldDrainQueue({ ...base, approvalActive: true }), false);
  assert.equal(shouldDrainQueue({ ...base, pausedAfterCancel: true }), false);
  assert.equal(shouldDrainQueue({ ...base, queueLength: 0 }), false);
});

// ─── formatQueueWait ─────────────────────────────────────────────────────────

test('formatQueueWait buckets elapsed time with an explicit now (characterization)', () => {
  assert.equal(formatQueueWait(undefined, 1500), null);
  assert.equal(formatQueueWait(Number.NaN, 1500), null);
  assert.equal(formatQueueWait(1000, 1500), '<1s');
  assert.equal(formatQueueWait(1000, 61_000), '1m', '60s exactly moves to the minutes bucket');
  assert.equal(formatQueueWait(1000, 120_000), '1m');
  assert.equal(formatQueueWait(1000, 7_200_000), '1h');
  assert.equal(formatQueueWait(2000, 1000), '<1s', 'negative wait clamps to zero');
});

// ─── queue messages ──────────────────────────────────────────────────────────

test('queue status messages pluralize and embed the queue length (characterization)', () => {
  assert.equal(stopRequestedMessage(0), 'Stopping current run…');
  assert.equal(
    stopRequestedMessage(1),
    'Stopping current run… 1 queued prompt will run next — /queue drop to discard the next, /queue clear to discard all.'
  );
  assert.equal(
    stopRequestedMessage(2),
    'Stopping current run… 2 queued prompts will run next — /queue drop to discard the next, /queue clear to discard all.'
  );
  assert.equal(queueResumedMessage(0), 'Queue resumed.');
  assert.equal(queueResumedMessage(2), 'Queue resumed (2 items waiting).');
  assert.equal(
    queuePausedSubmissionMessage(3, 'do the thing'),
    'Queued #3; queue remains paused until /queue resume: do the thing'
  );
});

// ─── queue command predicates ────────────────────────────────────────────────

test('isQueueControlCommand and isImmediateGoalCommand match exact command forms (characterization)', () => {
  assert.equal(isQueueControlCommand('/queue'), true);
  assert.equal(isQueueControlCommand('/queue drop'), true);
  assert.equal(isQueueControlCommand('/queue bogus'), false);
  assert.equal(isQueueControlCommand('hello'), false);
  assert.equal(isImmediateGoalCommand('/goal clear'), true);
  assert.equal(isImmediateGoalCommand('/goal pause'), true);
  assert.equal(isImmediateGoalCommand('/goal complete'), true);
  assert.equal(isImmediateGoalCommand('/goal complete now'), true);
  assert.equal(isImmediateGoalCommand('/goal block x'), true);
  assert.equal(isImmediateGoalCommand('/goal other'), false);
});

// ─── queueItemMeta ───────────────────────────────────────────────────────────

test('queueItemMeta renders kind, wait, line/char counts, and attachments (characterization)', () => {
  assert.equal(
    queueItemMeta({ raw: 'hi', message: 'hi', enqueuedAt: 1000 }, 1500),
    'prompt · waiting <1s · 1 line · 2 chars'
  );
  assert.equal(
    queueItemMeta(
      { raw: 'x', message: 'a\nb\nc', enqueuedAt: 1000, attachments: [{}, {}] },
      61_000
    ),
    'prompt · waiting 1m · 3 lines · 5 chars · 2 attachments'
  );
  assert.equal(
    queueItemMeta({ raw: 'hi', message: 'hi' }, 1500),
    'prompt · 1 line · 2 chars',
    'no enqueuedAt: no waiting segment'
  );
});

// ─── SerialQueueDrain ────────────────────────────────────────────────────────

test('SerialQueueDrain serializes runs and rejects concurrent re-entry (characterization)', async () => {
  const queue = new SerialQueueDrain();
  const order = [];
  const first = queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push('first');
  });
  const second = await queue.run(async () => {
    order.push('second');
  });
  const firstResult = await first;
  assert.equal(second, false, 'concurrent run is refused with false');
  assert.equal(firstResult, true, 'the accepted run resolves true');
  assert.deepEqual(order, ['first'], 'second task never ran');
  assert.equal(queue.isRunning(), false);
});

// ─── appendLimited & constants ───────────────────────────────────────────────

test('appendLimited keeps the tail of the output within the limit (characterization)', () => {
  assert.equal(appendLimited('abc', 'de', 10), 'abcde');
  assert.equal(appendLimited('abcdef', 'ghijk', 4), 'hijk');
  assert.equal(LOCAL_SHELL_OUTPUT_LIMIT, 40_000);
  assert.equal(MAX_INPUT_HISTORY, 100);
});

// ─── resume replay ───────────────────────────────────────────────────────────

test('buildResumeReplay replays prose, appends tool lines, drops checkpoints (characterization)', () => {
  const replay = buildResumeReplay([
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi there' },
        { type: 'tool_use', name: 'exec', input: { command: 'ls' } },
      ],
    },
    {
      role: 'assistant',
      content: '<moss_working_context_checkpoint>x</moss_working_context_checkpoint>',
    },
  ]);
  assert.deepEqual(replay, {
    items: [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi there' },
      { kind: 'system', text: '⎿ exec (ls)' },
    ],
    hiddenCount: 0,
  });
  assert.deepEqual(
    resumedToolLines({
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'exec', input: { command: 'ls -la' } }],
    }),
    ['⎿ exec (ls -la)']
  );
});
