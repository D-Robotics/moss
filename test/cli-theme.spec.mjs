#!/usr/bin/env node
/**
 * Terminal background detection + theme application — tested from the user's
 * perspective: a white terminal must resolve to the readable light palette
 * (light input box, dark text) and a black terminal to the dark palette.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  parseOsc11Background,
  terminalModeFromBackgroundRgb,
  detectTerminalBackgroundMode,
} from '../dist/cli/theme/terminal-background.js';
import { legacyTheme as theme, applyTerminalThemeMode } from '../dist/cli/theme/theme.js';

// ─── parseOsc11Background ─────────────────────────────────────────────────────

{
  const white = parseOsc11Background('\x1b]11;rgb:ffff/ffff/ffff\x07');
  assert.deepEqual(white, { r: 255, g: 255, b: 255 }, 'parses a 4-hex white reply');

  const black = parseOsc11Background('\x1b]11;rgb:0000/0000/0000\x1b\\');
  assert.deepEqual(black, { r: 0, g: 0, b: 0 }, 'parses a black reply (ST terminator)');

  const short = parseOsc11Background('\x1b]11;rgb:ff/80/00\x07');
  assert.deepEqual(short, { r: 255, g: 128, b: 0 }, 'scales 2-hex channels to a byte');

  const embedded = parseOsc11Background('garbage\x1b]11;rgb:1e1e/1e1e/1e1e\x07trailing');
  assert.deepEqual(embedded, { r: 30, g: 30, b: 30 }, 'finds the reply amid other bytes');

  assert.equal(parseOsc11Background('no escape here'), null, 'returns null without a reply');
}

// ─── terminalModeFromBackgroundRgb ────────────────────────────────────────────

{
  assert.equal(terminalModeFromBackgroundRgb(255, 255, 255), 'light', 'white => light');
  assert.equal(terminalModeFromBackgroundRgb(0, 0, 0), 'dark', 'black => dark');
  assert.equal(terminalModeFromBackgroundRgb(30, 30, 30), 'dark', 'near-black => dark');
  assert.equal(terminalModeFromBackgroundRgb(245, 245, 244), 'light', 'off-white => light');
}

// ─── detectTerminalBackgroundMode ─────────────────────────────────────────────

/** Minimal fake TTY pair: stdout.write triggers stdin to emit `reply` once. */
function makeFakeTty(reply) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (v) => {
    stdin.isRaw = v;
  };
  stdin.resume = () => {};
  stdin.pause = () => {};

  let requested = '';
  const stdout = {
    isTTY: true,
    write: (chunk) => {
      requested += chunk;
      if (reply !== null && requested.includes('\x1b]11;?')) {
        setImmediate(() => stdin.emit('data', Buffer.from(reply, 'latin1')));
      }
      return true;
    },
  };
  return { stdin, stdout, getRequested: () => requested };
}

{
  // White background => light, and raw mode is restored to its prior value.
  const { stdin, stdout, getRequested } = makeFakeTty('\x1b]11;rgb:ffff/ffff/ffff\x07');
  const mode = await detectTerminalBackgroundMode({ stdin, stdout, env: {} });
  assert.equal(mode, 'light', 'white terminal resolves to the light theme');
  assert.ok(getRequested().includes('\x1b]11;?'), 'sends the OSC 11 background query');
  assert.equal(stdin.isRaw, false, 'restores raw mode after the query');
  assert.equal(stdin.listenerCount('data'), 0, 'removes its data listener');
}

{
  const { stdin, stdout } = makeFakeTty('\x1b]11;rgb:1c1c/1c1c/2828\x07');
  const mode = await detectTerminalBackgroundMode({ stdin, stdout, env: {} });
  assert.equal(mode, 'dark', 'dark terminal resolves to the dark theme');
}

{
  // No reply within the window => null (graceful fallback, no hang).
  const { stdin, stdout } = makeFakeTty(null);
  const mode = await detectTerminalBackgroundMode({ stdin, stdout, env: {}, timeoutMs: 30 });
  assert.equal(mode, null, 'times out to null when the terminal stays silent');
  assert.equal(stdin.listenerCount('data'), 0, 'cleans up its listener on timeout');
}

{
  // Non-TTY and explicit opt-out both short-circuit without querying.
  const nonTty = { isTTY: false };
  assert.equal(
    await detectTerminalBackgroundMode({ stdin: nonTty, stdout: nonTty, env: {} }),
    null,
    'no query on a non-TTY'
  );
  const { stdin, stdout } = makeFakeTty('\x1b]11;rgb:ffff/ffff/ffff\x07');
  assert.equal(
    await detectTerminalBackgroundMode({ stdin, stdout, env: { MOSS_NO_TERM_QUERY: '1' } }),
    null,
    'MOSS_NO_TERM_QUERY=1 opts out of detection'
  );
}

// ─── applyTerminalThemeMode (mutates the shared theme bag) ─────────────────────

{
  applyTerminalThemeMode('light');
  assert.equal(theme.promptBackground, '#f5f5f4', 'light mode gives a light input box');
  assert.equal(theme.text, '#0a0a0a', 'light mode gives dark body text');
  assert.equal(theme.textMuted, '#4b5563', 'light mode darkens muted greys for white terminals');
  assert.equal(theme.warn, theme.warning, 'keeps the legacy warn alias in sync');

  applyTerminalThemeMode('dark');
  assert.equal(theme.promptBackground, '#1c1c28', 'dark mode restores the dark input box');
  assert.equal(theme.text, '#d4d4d4', 'dark mode gives light body text');
}

console.log('cli-theme.spec: all assertions passed');
