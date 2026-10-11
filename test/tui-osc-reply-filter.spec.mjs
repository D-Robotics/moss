#!/usr/bin/env node
/**
 * OSC reply filter (composer leak fix): terminal replies such as the OSC 11
 * background answer must never land in the composer as typed text, even when
 * the pty splits the reply at an arbitrary byte boundary. Red-first: before
 * osc-reply-filter.ts existed, a reply split as `\x1b]11` + `;rgb:…\x07`
 * reached the composer verbatim (repro: scratch/tui-drive.py raw chunks).
 */
import assert from 'node:assert/strict';

import { createOsc11ReplyFilter } from '../dist/cli/tui/osc-reply-filter.js';

const REPLY = ']11;rgb:ffff/ffff/ffff\x07';

function feedAll(...chunks) {
  const filter = createOsc11ReplyFilter();
  return chunks.map((chunk) => filter.feed(chunk));
}

// Whole reply in one chunk: consumed, no passthrough, body extracted.
{
  const [r] = feedAll(REPLY);
  assert.equal(r.passthrough, '', 'a whole reply leaves no passthrough');
  assert.equal(r.body, 'rgb:ffff/ffff/ffff', 'the body is extracted');
}

// The observed real-world split: `\x1b]11` then `;rgb:…\x07`.
{
  const [a, b] = feedAll(']11', ';rgb:ffff/ffff/ffff\x07');
  assert.equal(a.passthrough, '', 'the split head is held, not passed through');
  assert.equal(a.body, undefined, 'no body until the reply completes');
  assert.equal(b.passthrough, '', 'the split tail completes the reply silently');
  assert.equal(b.body, 'rgb:ffff/ffff/ffff', 'the body survives the chunk split');
}

// Split in the middle of the payload.
{
  const [, b] = feedAll(']11;rgb:ffff/', 'ffff/ffff\x07');
  assert.equal(b.body, 'rgb:ffff/ffff/ffff', 'a payload split still reassembles');
}

// ST-terminated reply (xterm style), whole and split after the ESC.
{
  const [whole] = feedAll('\x1b]11;rgb:8080/8080/8080\x1b\\');
  assert.equal(whole.passthrough, '', 'an ST-terminated reply leaves no passthrough');
  assert.equal(whole.body, 'rgb:8080/8080/8080', 'ST terminates a reply');
  const [a, b] = feedAll(']11;rgb:1/1/1\x1b', '\\typed');
  assert.equal(a.body, 'rgb:1/1/1', 'the ESC of a split ST closes the reply');
  assert.equal(a.passthrough, '', 'nothing else rides with the split ESC');
  assert.equal(b.passthrough, 'typed', 'the lone ST tail backslash is swallowed');
}

// Text before and after the reply in one chunk.
{
  const [r] = feedAll(`abc\x1b${REPLY}def`);
  assert.equal(r.passthrough, 'abcdef', 'surrounding text is preserved');
  assert.equal(r.body, 'rgb:ffff/ffff/ffff');
}

// Ordinary typing passes through untouched.
{
  const [r] = feedAll('hello world');
  assert.equal(r.passthrough, 'hello world');
  assert.equal(r.body, undefined);
}

// A trailing `]` may be a split reply head: held briefly, then flushed intact.
{
  const [a, b] = feedAll('ls ]', 'x');
  assert.equal(a.passthrough, 'ls ', 'a trailing ] is held');
  assert.equal(b.passthrough, ']x', 'the held ] flushes with the next chunk');
}

// A held `]1` prefix that turns into normal typing flushes as text.
{
  const [a, b] = feedAll('a]1', '23');
  assert.equal(a.passthrough, 'a');
  assert.equal(b.passthrough, ']123', 'a false head rejoins the stream');
}

// An unterminated ]11; longer than the cap is typed text, not a reply.
{
  const [r] = feedAll(`]11;${'x'.repeat(64)}`);
  assert.equal(r.passthrough, `]11;${'x'.repeat(64)}`, 'the overflow guard flushes');
  assert.equal(r.body, undefined);
}

// A terminator inside the held text still closes the reply body early.
{
  const [r] = feedAll(`]11;rgb:1/2/3\x07${'x'.repeat(64)}`);
  assert.equal(r.body, 'rgb:1/2/3', 'the body ends at the terminator');
  assert.equal(r.passthrough, 'x'.repeat(64), 'the tail keeps flowing as input');
}

// An empty body does not emit one.
{
  const [r] = feedAll(']11;\x07');
  assert.equal(r.body, undefined, 'an empty body emits nothing');
}

// Repeated replies and continued typing after a reply.
{
  const filter = createOsc11ReplyFilter();
  const a = filter.feed(REPLY);
  const b = filter.feed('query');
  assert.equal(a.body, 'rgb:ffff/ffff/ffff');
  assert.equal(b.passthrough, 'query', 'the filter keeps working after a reply');
}
