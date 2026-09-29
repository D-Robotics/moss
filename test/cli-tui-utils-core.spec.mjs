#!/usr/bin/env node
/**
 * Characterization tests for cli/tui-utils.ts core pure helpers (sanitizing,
 * truncation, append limit, resume replay). The queued-input model that used
 * to live here was dead code and was removed in v0.14-S3; its tests went with
 * it. Assertions lock CURRENT behavior against dist/, not intended behavior.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendLimited,
  buildResumeReplay,
  resumedToolLines,
  sanitizeTextForTerminal,
  truncateTerminalText,
  LOCAL_SHELL_OUTPUT_LIMIT,
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

// ─── appendLimited ───────────────────────────────────────────────────────────

test('appendLimited keeps the tail of the output within the limit (characterization)', () => {
  assert.equal(appendLimited('abc', 'de', 10), 'abcde');
  assert.equal(appendLimited('abcdef', 'ghijk', 4), 'hijk');
  assert.equal(LOCAL_SHELL_OUTPUT_LIMIT, 40_000);
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
