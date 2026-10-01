#!/usr/bin/env node
/**
 * Output integrity for locally-run shell commands (`! <cmd>`, `/diff`).
 *
 * Regression for the adversarial acceptance report's D-4 (HIGH) and the
 * producer half of D-11 (LOW): the transcript showed a token-mangled,
 * silently head-truncated capture whose first visible line was a mid-line
 * fragment, which the diff gutter then numbered as if it were line 1.
 *
 * Guarantees asserted here:
 *   1. stdout is shown VERBATIM — no space is injected inside a long token,
 *      whatever its first character (`+`, `-`, a quote, a path, a URL);
 *   2. a capture that exceeds `LOCAL_SHELL_OUTPUT_LIMIT` is truncated on a LINE
 *      boundary and starts with a marker that names how much was dropped
 *      (accumulating across chunks), so numbering cannot shift silently;
 *   3. the safety sanitization is untouched: ANSI, control characters and
 *      binary blobs are still removed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LOCAL_SHELL_OUTPUT_LIMIT,
  appendLimited,
  appendLimitedAnnounced,
  runLocalShellCommand,
} from '../dist/cli/repl-process.js';

const run = (command, onChunk) =>
  runLocalShellCommand({
    command,
    cwd: process.cwd(),
    ...(onChunk ? { onChunk } : {}),
  });

const NOTICE_RE = /^… output truncated · (\d+) chars? \((\d+) lines?\) hidden\n/;
const noticeOf = (value) => {
  const match = NOTICE_RE.exec(value);
  assert.ok(match, `expected a truncation notice, got ${JSON.stringify(value.slice(0, 80))}`);
  return { chars: Number(match[1]), lines: Number(match[2]) };
};
/** Everything after the notice line. */
const bodyOf = (value) => value.slice(value.indexOf('\n') + 1);

// ─── 1. the raw primitive and the announced wrapper ───────────────────────

{
  // Characterization of the low-level tail chopper (kept for callers that must
  // not grow a string) — production output goes through the announced wrapper.
  assert.equal(appendLimited('abc', 'de', 10), 'abcde', 'under the limit nothing is dropped');
  assert.equal(appendLimited('abcdef', 'ghijk', 4), 'hijk', 'the primitive keeps the tail');
  assert.equal(appendLimitedAnnounced('abc', 'de', 10), 'abcde', 'no notice while nothing is lost');
}

// ─── 2. truncation is announced, on a line boundary ───────────────────────

{
  const lines = `${Array.from({ length: 200 }, (_, index) => `row-${index + 1}`).join('\n')}\n`;
  const out = appendLimitedAnnounced('', lines, 400);
  assert.ok(out.length <= 400, `announced output stays inside the limit (${out.length})`);
  const notice = noticeOf(out);
  assert.ok(notice.chars > 0 && notice.lines > 0, 'the notice reports what was dropped');
  assert.match(
    bodyOf(out).split('\n')[0],
    /^row-\d+$/,
    'the first retained line is a WHOLE line, not a mid-line fragment'
  );

  // A second drop keeps accumulating instead of resetting the numbers.
  const twice = appendLimitedAnnounced(out, lines, 400);
  const second = noticeOf(twice);
  assert.ok(second.chars > notice.chars, 'hidden characters accumulate across chunks');
  assert.ok(second.lines > notice.lines, 'hidden lines accumulate across chunks');
  assert.match(bodyOf(twice).split('\n')[0], /^row-\d+$/, 'still line-aligned after a second drop');
  assert.ok(twice.length <= 400, 'the cumulative notice still fits the limit');
}

// ─── 3. one gigantic line: announced in chars, never space-broken ─────────

{
  const blob = `+${'A'.repeat(600)}`;
  const out = appendLimitedAnnounced('', blob, 400);
  assert.ok(out.length <= 400, 'a single over-long line still respects the limit');
  const notice = noticeOf(out);
  assert.equal(notice.lines, 0, 'there is no line boundary to cut on');
  assert.ok(notice.chars > 0, 'the dropped characters are counted');
  assert.equal(bodyOf(out).includes(' '), false, 'no space is injected into the token');
  assert.ok(blob.includes(bodyOf(out)), 'the retained text is a verbatim slice of the token');
}

// ─── 4. a limit too small for a notice stays inside the limit ─────────────

{
  const tiny = appendLimitedAnnounced('', 'abcdefghij', 5);
  assert.equal(tiny.length, 5, 'never returns more than the caller allowed');
  assert.equal(tiny, 'fghij', 'and still keeps the newest characters');
}

// ─── 5. D-4 repro: `!` stdout is verbatim for copy-sensitive tokens ───────

{
  const envToken = '+process.env.MOSS_NO_BUNDLED_DEFAULT_LONG_TOKEN_XYZ';
  const bang = await run(`printf '%s\\n' '${envToken}'`);
  assert.equal(bang.exitCode, 0, 'the command runs');
  assert.equal(bang.output, `${envToken}\n`, 'a leading + does not defeat verbatim output');

  const pathToken = "'../dist/core/task-runtime/runtime.js';";
  const path = await run(`echo "${pathToken}"`);
  // cmd.exe (`spawn …, { shell: true }` → `cmd /d /s /c`) has its own rules for
  // how many of the surrounding double quotes survive an echo, so the round
  // trip asserts the TOKEN, not cmd's quoting: every path character must
  // arrive un-split and un-spaced (quote normalization on both sides).
  const tokenChars = (value) => value.trimEnd().replace(/["']/g, '');
  assert.equal(
    tokenChars(path.output),
    tokenChars(pathToken),
    'a quoted path is not split every 24 chars'
  );
  assert.ok(
    path.output.includes('task-runtime/runtime.js'),
    'the path body survives the shell round trip verbatim'
  );

  const url = 'https://example.com/a/very/long/repository/file/name/runtime.js?rev=1234567890';
  const fetched = await run(`printf '%s\\n' '${url}'`);
  assert.equal(fetched.output.trimEnd(), url, 'a long URL survives untouched');

  // Nothing the sanitizer produced contains the injected-space shapes the
  // verifier captured (`task-runti me`, `MOSS_NO_BUN DLED`, `tui/ help.js`).
  for (const value of [bang.output, path.output, fetched.output]) {
    assert.doesNotMatch(
      value,
      /\S \S/,
      `no space injected inside a token: ${JSON.stringify(value)}`
    );
  }

  // Streaming sees exactly what the resolved capture sees.
  const chunks = [];
  const streamed = await run(`printf '%s\\n' '${envToken}'`, (text) => chunks.push(text));
  assert.equal(chunks.join(''), envToken + '\n', 'onChunk carries the verbatim chunk');
  assert.equal(streamed.output, chunks.join(''), 'streamed and committed text agree');
}

// ─── 6. D-4 repro: a big capture announces its truncation ─────────────────

{
  // The generator is a script ON DISK invoked with zero quoting (`node <abs>`):
  // the old `seq 1 20000 | sed 's/^/row-/'` pipeline needs `seq`, which the
  // Windows runners do not have on PATH (Git Bash ships sed/printf but not
  // seq) — the established Windows-CI rule is scripts-on-disk, never inline
  // shell pipelines (see the Windows CI pitfalls ledger).
  const genPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'moss-output-integrity-')),
    'gen-rows.mjs'
  );
  fs.writeFileSync(
    genPath,
    'for (let i = 1; i <= 20000; i += 1) console.log(`row-${i}`);\n',
    'utf8'
  );
  const big = await run(`node ${genPath}`);
  assert.equal(
    big.exitCode,
    0,
    `the generator runs (exit ${big.exitCode}: ${big.output.slice(0, 120)})`
  );
  assert.ok(big.output.length <= LOCAL_SHELL_OUTPUT_LIMIT, 'the capture respects the limit');
  const notice = noticeOf(big.output);
  assert.ok(notice.lines > 1000, `a 20k-line capture reports its scale (${notice.lines} lines)`);
  assert.match(
    bodyOf(big.output).split('\n')[0],
    /^row-\d+$/,
    'the visible capture starts at a real line boundary, so numbering cannot shift'
  );
  assert.ok(big.output.trimEnd().endsWith('row-20000'), 'the newest output is the one kept');
}

// ─── 7. D-11 producer half: a `+` line is emitted verbatim ────────────────

{
  // The gutter number the verifier captured (`⎿   1 +process.env.X`) is added by
  // the transcript renderer, not here: the producer must hand over the exact
  // line so any numbering stays the renderer's responsibility.
  const plus = await run(`printf '+process.env.X\\n'`);
  assert.equal(plus.output, '+process.env.X\n', 'a `+`-leading line is not decorated');

  const minus = await run(`printf -- '-not a diff\\n'`);
  assert.equal(minus.output, '-not a diff\n', 'a `-`-leading line is not decorated');
}

// ─── 8. safety sanitization is untouched ──────────────────────────────────

{
  const ansi = await run(`printf '\\033[31mRED\\033[0m plain\\n'`);
  assert.equal(ansi.output, 'RED plain\n', 'ANSI colour is stripped');

  const cursor = await run(`printf 'a\\033[2Kb\\n'`);
  assert.equal(cursor.output, 'ab\n', 'ANSI erase sequences are stripped');

  const control = await run(`printf 'a\\001b\\177\\n'`);
  assert.equal(control.output, 'ab\n', 'control characters are stripped');

  const exit = await run('exit 3');
  assert.equal(exit.exitCode, 3, 'a failing command reports its real exit code');
  assert.equal(exit.output, '', 'and its real (empty) output');
}

console.log('OK cli-output-integrity');
