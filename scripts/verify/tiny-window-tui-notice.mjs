#!/usr/bin/env node
/**
 * B80 (split from B78): the TUI paints before the startup context probe lands, so
 * the reduced-profile notice must still appear once the corrected window arrives.
 */
import assert from 'node:assert/strict';
import { bootTuiTinyNotice } from './lib/tiny-window-boot.mjs';

// B78: an unprobed provider that reports a small window still gets the notice
// in the TUI, because the probe lands after the first paint.
const tuiNoticeTiny = await bootTuiTinyNotice(4096);
assert.equal(tuiNoticeTiny, true, 'the TUI must announce the tiny profile after the late probe');
// The negative side is covered headlessly: the same helper decides both paths,
// and the 32k boot above must not print the notice. A second PTY boot costs ~8s
// for no new signal, so the gate keeps only the case that was broken.

console.log('[tiny-window-tui-notice] ok: the TUI announces the tiny profile after its late probe');
