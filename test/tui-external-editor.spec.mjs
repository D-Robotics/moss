#!/usr/bin/env node
/**
 * Ctrl+G external editor (plan v3 P6): the editor opens on the caret's line, and an
 * EDITOR value with arguments ("code --wait") is split instead of failing. Red-first.
 */
import assert from 'node:assert/strict';

import {
  caretLine,
  externalEditorArgs,
  splitEditorCommand,
} from '../dist/cli/tui/external-editor.js';

assert.deepEqual(splitEditorCommand('code --wait'), { bin: 'code', args: ['--wait'] });
assert.deepEqual(splitEditorCommand('vim'), { bin: 'vim', args: [] });

assert.deepEqual(
  externalEditorArgs('vim', '/tmp/d.txt', 3),
  ['+3', '/tmp/d.txt'],
  'vim takes +line'
);
assert.deepEqual(
  externalEditorArgs('nano', '/tmp/d.txt', 7),
  ['+7', '/tmp/d.txt'],
  'nano takes +line'
);
assert.deepEqual(
  externalEditorArgs('code', '/tmp/d.txt', 4),
  ['--wait', '-g', '/tmp/d.txt:4'],
  'VS Code waits and goes to file:line'
);
assert.deepEqual(
  externalEditorArgs('/usr/local/bin/cursor', '/tmp/d.txt', 2),
  ['--wait', '-g', '/tmp/d.txt:2'],
  'the basename decides the editor family'
);
assert.deepEqual(
  externalEditorArgs('unknown-editor', '/tmp/d.txt', 5),
  ['/tmp/d.txt'],
  'unknown: file only'
);

assert.equal(caretLine('abc', 0), 1, 'caret at the start is line 1');
assert.equal(caretLine('a\nbc', 4), 2, 'caret after a newline is on line 2');
assert.equal(caretLine('a\nb\nc', 2), 2, 'the newline before the caret counts');
console.log('[PASS] external editor opens on the caret line and accepts EDITOR arguments');
