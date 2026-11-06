#!/usr/bin/env node
/**
 * B80 (split from B74/B77): `moss doctor` names the context profile the run will
 * use - tiny at 4096, lean at 32k, nothing above the lean threshold.
 */
import assert from 'node:assert/strict';
import { bootDoctor } from './lib/tiny-window-boot.mjs';

const [tinyDoctor, leanDoctor, wideDoctor] = await Promise.all([
  bootDoctor(4096),
  bootDoctor(32_000),
  bootDoctor(100_000),
]);
assert.ok(
  tinyDoctor.includes('context profile') && tinyDoctor.includes('5 core tools'),
  `doctor must show the reduced profile at 4096, got: ${tinyDoctor.slice(0, 400)}`
);
assert.ok(
  tinyDoctor.includes('tool results capped at 341 tokens'),
  'the doctor row must state the tool-result cap the run really applies'
);
assert.ok(
  !tinyDoctor.includes('lean surface'),
  'the tiny profile already says more than the lean row, so it must not double up'
);
// B77: 32k windows get lean declarations (terse descriptions + pruned schemas).
assert.ok(!leanDoctor.includes('context profile'), 'doctor must not show the tiny profile at 32k');
assert.ok(
  leanDoctor.includes('lean surface') && leanDoctor.includes('pruned to one-step parameters'),
  `doctor must explain the lean surface at 32k, got: ${leanDoctor.slice(0, 400)}`
);
// B77 boundary: above the lean threshold neither profile applies.
assert.ok(
  !wideDoctor.includes('context profile') && !wideDoctor.includes('lean surface'),
  'doctor must not show a reduced profile above 64k'
);

console.log(
  '[tiny-window-diagnostics] ok: doctor reports the tiny profile at 4096, the lean surface at 32k, ' +
    'neither above 64k'
);
