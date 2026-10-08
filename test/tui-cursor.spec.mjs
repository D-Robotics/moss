#!/usr/bin/env node
/**
 * Hardware cursor: the composer projection reports a cell column and does not
 * shift text when the caret moves (S13/S14).
 */
import assert from 'node:assert/strict';
import { createComposer, composerMove, renderComposerEditor } from '../dist/cli/tui/composer.js';
import { displayWidth } from '../dist/cli/tui/text.js';

function rowText(view) {
  return view.lines.map((runs) => runs.map((run) => run.text).join(''));
}

function caretColumn(state, width) {
  const view = renderComposerEditor(state, {
    width,
    maxRows: 8,
    firstPrefix: '❯ ',
    restPrefix: '  ',
  });
  const row = view.lines[view.caretRow] ?? [];
  const prefix = view.caretRow === 0 ? '❯ ' : '  ';
  const text = row.map((run) => run.text).join('');
  const content = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return { view, content, prefixWidth: displayWidth(prefix) };
}

const samples = ['hello', 'hello 世界', '测', 'ab中cd', 'a'.repeat(40)];
for (const value of samples) {
  for (const width of [20, 40, 80, 120]) {
    let state = createComposer(value);
    for (let step = 0; step < Math.min(value.length, 12); step += 1) {
      state = composerMove(state, 'left', width);
      const here = caretColumn(state, width);
      assert.equal(
        here.view.lines.some((runs) => runs.some((run) => run.inverse)),
        false
      );
      assert.equal(Number.isInteger(here.view.caretCol), true);
    }
  }
}

{
  const state = createComposer('hello 世界');
  const view = renderComposerEditor(state, {
    width: 40,
    maxRows: 4,
    firstPrefix: '❯ ',
    restPrefix: '  ',
  });
  assert.equal(view.caretCol, displayWidth('❯ hello 世界'));
  const moved = renderComposerEditor(composerMove(state, 'left', 40), {
    width: 40,
    maxRows: 4,
    firstPrefix: '❯ ',
    restPrefix: '  ',
  });
  assert.equal(rowText(view).join('\n'), rowText(moved).join('\n'));
  assert.ok(moved.caretCol < view.caretCol);
}
