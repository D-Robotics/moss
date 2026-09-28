#!/usr/bin/env node
/**
 * Failed exec rows should surface the real error tail, not only exit_code.
 */
import assert from 'node:assert/strict';

import {
  extractCommandFailurePreview,
  extractCommandOutputPreview,
} from '../dist/tools/tool-helpers.js';

{
  const text =
    'exit_code: 1\n' + "src/cli/tui.ts:12: error TS1005: ',' expected.\n" + 'Found 1 error.\n';
  const lines = extractCommandFailurePreview(text, 4);
  assert.ok(lines.length >= 1);
  assert.ok(!lines.some((l) => /^exit_code:/.test(l)), 'skips bare exit_code line');
  assert.match(lines.join('\n'), /TS1005|Found 1 error/);
}

{
  const text =
    'exit_code: 2\n' +
    'some stdout noise\n\n' +
    '--- stderr ---\n' +
    'npm ERR! missing script: test\n' +
    'npm ERR! A complete log of this run can be found in: /tmp/npm.log\n';
  const lines = extractCommandFailurePreview(text, 3);
  assert.ok(lines.length >= 1);
  assert.match(lines.join('\n'), /missing script|npm ERR/);
}

{
  const text =
    'Command failed (exit 1):\n' +
    "Error: Cannot find module './missing.js'\n" +
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1:1)\n';
  const lines = extractCommandFailurePreview(text, 2);
  assert.match(lines.join('\n'), /Cannot find module/);
}

{
  assert.deepEqual(extractCommandFailurePreview(''), []);
  assert.deepEqual(extractCommandFailurePreview('exit_code: 1\n'), []);
}

// Successful long exec: tail preview (not for tiny outputs)
{
  const tiny = 'ok\n';
  assert.deepEqual(extractCommandOutputPreview(tiny), [], 'tiny success output stays collapsed');

  const long = Array.from({ length: 12 }, (_, i) => `build step ${i + 1} done`).join('\n');
  const lines = extractCommandOutputPreview(long, { maxLines: 3, minLines: 4 });
  assert.ok(lines.length >= 3);
  assert.match(lines[0], /earlier lines|…/);
  assert.match(lines.join('\n'), /build step 12 done/);
}

console.log('[PASS] exec failure preview');
