#!/usr/bin/env node
/**
 * edit_file replaces only the matched span. Mixed endings outside the span stay.
 * The replacement's newlines follow the matched span (majority), or the line
 * the span sits on when the span itself has no newline. Both directions.
 */
import assert from 'node:assert/strict';

import { applyPreciseEditToContent } from '../dist/tools/file-tools.js';

function edit(content, oldString, newString, replaceAll) {
  const result = applyPreciseEditToContent(content, {
    oldString,
    newString,
    ...(replaceAll ? { replaceAll: true } : {}),
  });
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.content;
}

assert.equal(edit('a\nb\r\nc\nd\n', 'c', 'C'), 'a\nb\r\nC\nd\n');
assert.equal(edit('progress\rdone\nx\n', 'x', 'C'), 'progress\rdone\nC\n');
assert.equal(edit('a\r\nb\r\nc\r\n', 'c', 'C'), 'a\r\nb\r\nC\r\n');
assert.equal(edit('alpha\nbeta\ngamma\n', 'alpha\nbeta', 'ALPHA\nBETA'), 'ALPHA\nBETA\ngamma\n');
assert.equal(
  edit('alpha\r\nbeta\r\ngamma\r\n', 'alpha\nbeta', 'ALPHA\nBETA'),
  'ALPHA\r\nBETA\r\ngamma\r\n'
);
assert.equal(edit('a\nb\r\nc\nd\n', 'b\nc', 'B\nC'), 'a\nB\r\nC\nd\n');
assert.equal(edit('foo \r\nbar\r\n', 'foo\nbar', 'FOO\nBAR'), 'FOO\r\nBAR\r\n');

// (a) exact path: single-line old_string in a CRLF file, multi-line LF new_string.
assert.equal(edit('a\r\nb\r\nc\r\n', 'b', 'b1\nb2'), 'a\r\nb1\r\nb2\r\nc\r\n');
// exact path, the other direction: LF file, CRLF new_string.
assert.equal(edit('a\nb\nc\n', 'b', 'B1\r\nB2'), 'a\nB1\nB2\nc\n');
// (b) LF-view path: CRLF-written old/new against an LF file must not inject CR.
assert.equal(edit('a\nb\nc\n', 'a\r\nb', 'A\r\nB'), 'A\nB\nc\n');

{
  const dup = applyPreciseEditToContent('foo\nfoo\n', { oldString: 'foo', newString: 'bar' });
  assert.equal(dup.ok, false);
  assert.match(dup.ok ? '' : dup.error, /not unique/);
}
{
  const dup = applyPreciseEditToContent('a\r\nb\r\na\r\nb\r\n', {
    oldString: 'a\nb',
    newString: 'A\nB',
  });
  assert.equal(dup.ok, false);
  assert.match(dup.ok ? '' : dup.error, /not unique/);
}
assert.equal(edit('foo\nfoo\n', 'foo', 'bar', true), 'bar\nbar\n');

console.log('[PASS] edit_file CRLF span');
