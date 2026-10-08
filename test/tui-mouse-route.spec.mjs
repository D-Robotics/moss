#!/usr/bin/env node
import assert from 'node:assert/strict';
import { routeMouse } from '../dist/cli/tui/input/mouse-route.js';
import { selectionText } from '../dist/cli/tui/selection.js';
import { composerCaretFromClick, createComposer } from '../dist/cli/tui/composer.js';

const layout = { composerTop: 20, composerLines: 1, viewportRows: 18 };

assert.equal(routeMouse({ button: 64, x: 1, y: 2, release: false }, layout).type, 'scroll');
assert.deepEqual(routeMouse({ button: 0, x: 4, y: 21, release: false }, layout), {
  type: 'caret',
  visibleRow: 0,
  cell: 3,
});
assert.equal(
  routeMouse({ button: 0, x: 2, y: 22, release: false }, { ...layout, jumpRow: 21 }).type,
  'pin'
);

const caret = composerCaretFromClick(
  createComposer('hello'),
  { width: 40, maxRows: 4, firstPrefix: '❯ ', restPrefix: '  ' },
  0,
  4
);
assert.ok(caret.caret > 0 && caret.caret < 5);

assert.equal(selectionText(['abcdef', 'ghijkl'], { x: 1, y: 0 }, { x: 3, y: 0 }), 'bc');
