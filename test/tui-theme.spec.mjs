#!/usr/bin/env node
/**
 * Colour themes (plan v3 P5): NO_COLOR and the background decide the palette, and
 * the paint boundary applies it. Red-first: these fail before theme.ts existed.
 */
import assert from 'node:assert/strict';

import { currentTuiTheme, detectTheme, paintColor, setTuiTheme } from '../dist/cli/tui/theme.js';
import { inkTextStyle } from '../dist/cli/tui/app-helpers.js';

assert.equal(detectTheme({}), 'dark', 'the default is dark');
assert.equal(detectTheme({ NO_COLOR: '1' }), 'mono', 'NO_COLOR forces mono');
assert.equal(detectTheme({ NO_COLOR: '' }), 'dark', 'an empty NO_COLOR is ignored (no-color.org)');
assert.equal(detectTheme({ COLORFGBG: '0;15' }), 'light', 'a light background (bg 15) is light');
assert.equal(detectTheme({ COLORFGBG: '15;0' }), 'dark', 'a dark background (bg 0) is dark');
assert.equal(detectTheme({ MOSS_TUI_THEME: 'light', COLORFGBG: '15;0' }), 'light', 'explicit wins');
assert.equal(detectTheme({ MOSS_TUI_THEME: 'purple' }), 'dark', 'an unknown theme is ignored');
assert.equal(
  detectTheme({ NO_COLOR: '1', MOSS_TUI_THEME: 'light' }),
  'mono',
  'NO_COLOR outranks the theme choice'
);

import { themeFromOsc11, themeLockedByEnv } from '../dist/cli/tui/theme.js';

assert.equal(themeFromOsc11('rgb:ffff/ffff/ffff'), 'light', 'a white background is light');
assert.equal(themeFromOsc11('rgb:0000/0000/0000'), 'dark', 'a black background is dark');
assert.equal(themeFromOsc11('not a colour'), undefined, 'a garbled reply is ignored');
assert.equal(themeLockedByEnv({ NO_COLOR: '1' }), true);
assert.equal(themeLockedByEnv({}), false);

try {
  setTuiTheme('light');
  assert.equal(paintColor('yellow'), 'magenta', 'yellow is remapped on a light background');
  assert.equal(paintColor('cyan'), 'cyan', 'other colours are unchanged');

  setTuiTheme('mono');
  assert.equal(paintColor('cyan'), undefined, 'mono paints nothing');
  assert.deepEqual(
    inkTextStyle({ color: 'cyan', bold: true, italic: true }),
    { bold: true, italic: true },
    'mono keeps the emphasis that carries meaning'
  );

  setTuiTheme('dark');
  assert.equal(currentTuiTheme(), 'dark');
  assert.deepEqual(inkTextStyle({ color: 'cyan' }), { color: 'cyan' });
} finally {
  setTuiTheme('dark');
}
console.log('[PASS] TUI colour themes (detection, light remap, mono paint boundary)');
