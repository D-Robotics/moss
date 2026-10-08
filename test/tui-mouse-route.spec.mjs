#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isExpandAffordance, routeMouse } from '../dist/cli/tui/input/mouse-route.js';
import { selectionText } from '../dist/cli/tui/selection.js';
import { composerCaretFromClick, createComposer } from '../dist/cli/tui/composer.js';

const layout = { composerTop: 20, composerLines: 1, viewportRows: 18 };

assert.equal(routeMouse({ button: 64, x: 1, y: 2, release: false }, layout).type, 'scroll');
assert.equal(routeMouse({ button: 64, x: 1, y: 2, release: true }, layout).type, 'ignore');
assert.equal(isExpandAffordance('    … 51 more lines · ctrl+o'), true);
assert.equal(isExpandAffordance('  ⎿ thinking · click or ctrl+o'), true);
assert.equal(isExpandAffordance('hello'), false);
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

// P1: the scroll bar column owns its presses and drags only when it exists.
{
  const barred = { ...layout, scrollbarCol: 79 };
  assert.deepEqual(routeMouse({ button: 0, x: 80, y: 3, release: false }, barred), {
    type: 'scrollbar',
    phase: 'start',
    y: 2,
  });
  assert.deepEqual(routeMouse({ button: 32, x: 80, y: 5, release: false }, barred), {
    type: 'scrollbar',
    phase: 'move',
    y: 4,
  });
  assert.equal(routeMouse({ button: 0, x: 80, y: 3, release: true }, barred).phase, 'end');
  assert.equal(
    routeMouse({ button: 0, x: 80, y: 3, release: false }, layout).type,
    'select',
    'without a bar the same cell is ordinary text selection'
  );
}

// P1 hover: motion with no button is a hover (shows the scroll bar), not a drag.
{
  const barred = { ...layout, scrollbarCol: 79 };
  assert.deepEqual(routeMouse({ button: 35, x: 80, y: 4, release: false }, barred), {
    type: 'hover',
    x: 79,
    y: 3,
  });
  assert.equal(
    routeMouse({ button: 35, x: 4, y: 21, release: false }, barred).type,
    'hover',
    'hover over the composer does not reach the caret'
  );
  assert.equal(
    routeMouse({ button: 32, x: 80, y: 4, release: false }, barred).type,
    'scrollbar',
    'a drag (button held) still drives the bar'
  );
}
