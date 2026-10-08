#!/usr/bin/env node
/**
 * Overlay input boxes (plan v3 P6): the history search and the session picker
 * show their query without a painted caret glyph. The terminal's own cursor sits
 * on the query (so IME and screen readers follow it), as it does in the composer.
 * Red-first: these lines carried a fake `▌` before.
 */
import assert from 'node:assert/strict';

import { renderHistorySearch } from '../dist/cli/tui/history-search.js';
import { renderSessionPicker } from '../dist/cli/tui/app-helpers.js';

const search = renderHistorySearch('deploy', ['deploy the camera'], { width: 60, selected: 0 });
assert.equal(search[0].text, '⌕ deploy', 'the search query has no fake caret glyph');
assert.ok(!search[0].text.includes('▌'));

const picker = renderSessionPicker('abc', [], 0, 60);
assert.ok(picker[0].text.includes('⌕ abc'), 'the picker query is shown');
assert.ok(!picker[0].text.includes('▌'), 'the picker query has no fake caret glyph');
console.log('[PASS] overlay query lines leave the caret to the terminal');
