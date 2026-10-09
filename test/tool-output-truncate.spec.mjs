#!/usr/bin/env node
/**
 * Tool-output truncation byte budget — regression for multi-byte (CJK/emoji).
 *
 * truncateToolOutput budgets in estimated tokens (UTF-8 bytes / 4). The slice
 * point finder used to apply that BYTE budget directly as a UTF-16 char index,
 * so CJK output (3 bytes/char) kept ~3x the budget, emoji (4 bytes/char) ~2x,
 * and char-index slicing could split surrogate pairs. Locks: truncated size
 * stays within limit + newline-snap slack for any encoding width, output never
 * contains lone surrogates, ASCII behavior is unchanged, and under-limit input
 * passes through verbatim.
 */
import assert from 'node:assert/strict';

import { truncateToolOutput } from '../dist/context/index.js';

const BYTES_PER_TOKEN = 4;
const EXEC_LIMIT_TOKENS = 4500;
// Slack: ±100-char newline snap per side at 4 bytes/char (2 * 100 * 4 / 4)
// plus the truncation marker line.
const SLACK_TOKENS = 256;

const estTokens = (s) => Math.ceil(Buffer.byteLength(s, 'utf8') / BYTES_PER_TOKEN);

function assertWithinBudget(out, label) {
  const tokens = estTokens(out);
  assert.ok(
    tokens <= EXEC_LIMIT_TOKENS + SLACK_TOKENS,
    `${label}: truncated output is ${tokens} tokens, exceeds limit ${EXEC_LIMIT_TOKENS} + slack ${SLACK_TOKENS}`
  );
  assert.ok(
    tokens >= EXEC_LIMIT_TOKENS - 200,
    `${label}: truncated output is only ${tokens} tokens, over-truncated below limit`
  );
  assert.match(out, /tokens truncated/, `${label}: truncation marker present`);
}

function assertNoLoneSurrogates(s, label) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      assert.ok(
        n >= 0xdc00 && n <= 0xdfff,
        `${label}: high surrogate at index ${i} is not followed by a low surrogate`
      );
      i++;
    } else {
      assert.ok(!(c >= 0xdc00 && c <= 0xdfff), `${label}: lone low surrogate at index ${i}`);
    }
  }
}

// ─── 1. CJK over-limit output stays within budget (was ~3x over) ──────────

{
  // No newlines: slice points must land exactly on the byte budget.
  const out = truncateToolOutput('exec', '中'.repeat(20_000));
  assertWithinBudget(out, 'CJK single-char run');
  assertNoLoneSurrogates(out, 'CJK single-char run');
}

{
  // Realistic CJK log lines: newline snapping must not blow the budget.
  const line = '这是一行中文日志输出，包含标点和数字 12345。\n';
  const out = truncateToolOutput('exec', line.repeat(Math.ceil(20_000 / line.length)));
  assertWithinBudget(out, 'CJK log lines');
}

// ─── 2. Emoji: budget respected, surrogate pairs never split ──────────────

{
  const out = truncateToolOutput('exec', '🤖'.repeat(20_000));
  assertWithinBudget(out, 'emoji run');
  assertNoLoneSurrogates(out, 'emoji run');
}

{
  // Mixed widths + newlines: snap windows land mid-pair in the buggy code.
  const line = 'ok🤖中文 mixed line\n';
  const out = truncateToolOutput('exec', line.repeat(6_000));
  assertWithinBudget(out, 'mixed emoji/CJK lines');
  assertNoLoneSurrogates(out, 'mixed emoji/CJK lines');
}

// ─── 3. ASCII baseline unchanged ──────────────────────────────────────────

{
  const out = truncateToolOutput('exec', 'x'.repeat(100_000));
  assertWithinBudget(out, 'ASCII run');
  assert.ok(out.startsWith('x'), 'ASCII run: head preserved');
  assert.ok(out.endsWith('x'), 'ASCII run: tail preserved');
}

{
  const lastLine = `line-2999 ${'y'.repeat(40)}`;
  const text = Array.from({ length: 3_000 }, (_, i) => `line-${i} ${'y'.repeat(40)}`).join('\n');
  const out = truncateToolOutput('exec', text);
  assertWithinBudget(out, 'ASCII lines');
  assert.ok(out.startsWith('line-0 '), 'ASCII lines: head is the true prefix');
  assert.ok(out.endsWith(lastLine), 'ASCII lines: tail is the true suffix');
}

// ─── 4. Under-limit input passes through verbatim (boundary samples) ─────

for (const [label, text] of [
  ['empty string', ''],
  ['whitespace-only', '   \n\t  '],
  ['ascii small', 'hello world'],
  ['cjk small', '中文'.repeat(100)],
  ['emoji small', '🤖🤖🤖'],
]) {
  assert.equal(truncateToolOutput('exec', text), text, `${label} passes through unchanged`);
}

function assertWholeRedactionMarkers(out, label) {
  const stripped = out.replaceAll('[REDACTED]', '');
  assert.equal(stripped.includes('[REDACTED'), false, `${label}: marker lost its closing bracket`);
  assert.equal(stripped.includes('REDACTED]'), false, `${label}: marker lost its opening bracket`);
}

{
  const secret =
    'https://user:pass@docs.example/guide/page?X-Amz-Signature=secretvalue&X-Amz-Credential=AKIAEXAMPLE';
  const body = `${'y'.repeat(20_000)}\n${secret}\n${'y'.repeat(20_000)}`;
  const kept = truncateToolOutput('mcp__rdk-docs__search_docs', body);
  assert.match(kept, /Doc URLs:/);
  assert.match(kept, /https:\/\/docs\.example\/guide\/page/);
  assert.doesNotMatch(kept, /user:pass/);
  assert.doesNotMatch(kept, /X-Amz-Signature/);
  assert.doesNotMatch(kept, /secretvalue/);
  assertWholeRedactionMarkers(kept, 'rdk cite');

  const page = truncateToolOutput('mcp__rdk-docs__get_page', body);
  assert.match(page, /https:\/\/docs\.example\/guide\/page/);
  assert.doesNotMatch(page, /user:pass/);

  const execOut = truncateToolOutput('exec', body);
  assert.equal(execOut.includes('Doc URLs:'), false);
  assert.equal(execOut.includes('docs.example'), false);
  assert.equal(execOut.includes('secretvalue'), false);

  const byName = truncateToolOutput('rdk_search', body);
  assert.equal(byName.includes('Doc URLs:'), false);

  const other = truncateToolOutput('mcp__other__search_docs', body);
  assert.equal(other.includes('Doc URLs:'), false);

  const short = `see ${secret}`;
  assert.equal(truncateToolOutput('mcp__rdk-docs__get_page', short), short);

  const anchored = 'https://user:[REDACTED]@docs.example/guide/page?token=abc123DEF456#setup';
  const cited = truncateToolOutput(
    'mcp__rdk-docs__get_page',
    `${'y'.repeat(20_000)}\n${anchored}\n${'y'.repeat(20_000)}`
  );
  assert.match(cited, /https:\/\/docs\.example\/guide\/page#setup/);
  assert.doesNotMatch(cited, /\[REDACTED\]@/);
  assert.doesNotMatch(cited, /abc123DEF456/);
}

{
  const marker = '[REDACTED]';
  const text = `${'a'.repeat(7996)}${marker}${'b'.repeat(20_000)}`;
  const out = truncateToolOutput('custom_budget', text);
  assert.match(out, /tokens truncated/);
  assertWholeRedactionMarkers(out, 'cut');
}

console.log('[PASS] tool-output truncation byte budget (CJK/emoji/ASCII)');
