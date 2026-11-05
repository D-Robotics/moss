#!/usr/bin/env node
/**
 * B80 (split from B69): a startup `-p` run announces the reduced profile exactly
 * when the effective window is tiny, and a disabled surface stays quiet.
 */
import assert from 'node:assert/strict';
import { bootStderr } from './lib/tiny-window-boot.mjs';

const tinyStderr = await bootStderr(4096);
assert.ok(
  tinyStderr.includes('context window is small (4k tokens)'),
  `a 4096 window must announce the reduced profile, stderr was: ${tinyStderr.slice(0, 400)}`
);
assert.ok(tinyStderr.includes('5 core tools'), 'the notice must say the tool surface is reduced');
const wideStderr = await bootStderr(32_000);
assert.ok(
  !wideStderr.includes('context window is small'),
  'a 32k window must not print the tiny-window notice'
);
const forcedOffStderr = await bootStderr(4096, { MOSS_TINY_WINDOW_TOOLS: '0' });
assert.ok(
  !forcedOffStderr.includes('context window is small'),
  'MOSS_TINY_WINDOW_TOOLS=0 must not announce a profile it disabled'
);

console.log(
  '[tiny-window-cli-boot] ok: a 4096 window announces the reduced profile (5 core tools), ' +
    '32k stays quiet and MOSS_TINY_WINDOW_TOOLS=0 announces nothing it disabled'
);
