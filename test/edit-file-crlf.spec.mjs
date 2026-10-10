#!/usr/bin/env node
/**
 * edit_file replaces only the matched span. Mixed endings outside the span stay.
 * An LF old_string can match a CRLF span; the replacement keeps that span's ending.
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

console.log('[PASS] edit_file CRLF span');
