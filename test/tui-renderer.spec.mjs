#!/usr/bin/env node
/** Renderer selection: fullscreen by default, inline when the terminal cannot host it. */
import assert from 'node:assert/strict';
import { selectTuiRenderer, TERMINAL_RESTORE } from '../dist/cli/tui/renderer.js';

assert.equal(selectTuiRenderer({ rows: 30, term: 'xterm-256color' }).mode, 'fullscreen');
assert.equal(selectTuiRenderer({ env: { MOSS_TUI_RENDERER: 'inline' }, rows: 40 }).mode, 'inline');
assert.equal(selectTuiRenderer({ rows: 8, term: 'xterm-256color' }).mode, 'inline');
assert.equal(selectTuiRenderer({ term: 'dumb', rows: 40 }).mode, 'inline');
assert.equal(
  selectTuiRenderer({ inTmux: true, tmuxMouse: 'off', rows: 40, term: 'screen' }).mode,
  'inline'
);
assert.equal(
  selectTuiRenderer({ inTmux: true, tmuxMouse: 'on', rows: 40, term: 'tmux-256color' }).mode,
  'fullscreen'
);
assert.equal(selectTuiRenderer({ inScreen: true, rows: 40, term: 'screen' }).mode, 'inline');
assert.ok(TERMINAL_RESTORE.includes('\x1b[?1006l'), 'SGR mouse tracking is turned off');
assert.ok(TERMINAL_RESTORE.includes('\x1b[?1000l'), 'normal mouse tracking is turned off');
assert.ok(TERMINAL_RESTORE.includes('\x1b[?7h'), 'autowrap is restored');

// P2: a window narrower than the fullscreen chrome falls back to inline.
assert.equal(selectTuiRenderer({ rows: 30, columns: 39, term: 'xterm-256color' }).mode, 'inline');
assert.match(
  selectTuiRenderer({ rows: 30, columns: 39, term: 'xterm-256color' }).reason,
  /narrower than 40 columns/
);
assert.equal(
  selectTuiRenderer({ rows: 30, columns: 40, term: 'xterm-256color' }).mode,
  'fullscreen'
);
assert.equal(
  selectTuiRenderer({ rows: 30, term: 'xterm-256color' }).mode,
  'fullscreen',
  'no width probe keeps the default'
);
