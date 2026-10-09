#!/usr/bin/env node
/** Renderer selection: fullscreen by default, inline when the terminal cannot host it. */
import assert from 'node:assert/strict';
import {
  readTmuxMouse,
  rememberDrawnFrame,
  selectTuiRenderer,
  TERMINAL_RESTORE,
  TUI_KITTY_KEYBOARD,
  tuiExitSequence,
} from '../dist/cli/tui/renderer.js';

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
assert.equal(readTmuxMouse({}), undefined, 'outside tmux there is nothing to probe');
assert.equal(
  readTmuxMouse({ TMUX: '/tmp/moss-no-such-tmux-socket,1,0', PATH: process.env.PATH ?? '' }),
  'off',
  'a probe that cannot reach tmux stays on the inline-safe value'
);
assert.ok(TERMINAL_RESTORE.includes('\x1b[?1006l'), 'SGR mouse tracking is turned off');
assert.ok(TERMINAL_RESTORE.includes('\x1b[?1000l'), 'normal mouse tracking is turned off');
assert.ok(TERMINAL_RESTORE.includes('\x1b[?7h'), 'autowrap is restored');
assert.equal(
  TERMINAL_RESTORE.includes('\x1b[?1049l'),
  false,
  'leaving the alternate screen is fullscreen-only'
);
const inlineExit = tuiExitSequence('inline', { rows: 4, cursorRow: 2 });
assert.equal(inlineExit.includes('\x1b[H\x1b[2J'), false, 'inline exit does not wipe the screen');
assert.equal(inlineExit.includes('\x1b[?1049l'), false, 'inline exit stays on the primary screen');
assert.ok(inlineExit.includes('\x1b[2A'), 'inline exit moves to the top of the last frame');
assert.ok(inlineExit.includes('\x1b[J'), 'inline exit erases only that frame');
assert.ok(inlineExit.includes('moss --continue\n'), 'inline exit names how to continue');
rememberDrawnFrame({ rows: 3, cursorRow: 3 });
const remembered = tuiExitSequence('inline');
assert.ok(remembered.includes('\x1b[3A'), 'a recorded frame is what exit erases');
rememberDrawnFrame(undefined);
const fullscreenExit = tuiExitSequence('fullscreen');
assert.equal(
  fullscreenExit.includes('\x1b[H\x1b[2J'),
  false,
  'fullscreen exit keeps the primary buffer'
);
assert.ok(fullscreenExit.includes('\x1b[?1049l'), 'fullscreen exit leaves the alternate screen');
assert.ok(fullscreenExit.includes('\x1b[?7h'), 'fullscreen exit still restores autowrap');
assert.equal(
  TUI_KITTY_KEYBOARD.mode,
  'enabled',
  'kitty auto-detect unshifts the probe buffer and inserts the first keystroke twice'
);

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
