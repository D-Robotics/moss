#!/usr/bin/env node
/**
 * Failed exec/device_exec rows should surface the real error tail, not only exit_code.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import {
  extractCommandFailurePreview,
  extractCommandOutputPreview,
} from '../dist/tools/tool-helpers.js';
import { ActivityItemLine } from '../dist/cli/tui.js';

{
  const text =
    'exit_code: 1\n' +
    'src/cli/tui.ts:12: error TS1005: \',\' expected.\n' +
    'Found 1 error.\n';
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
    'Error: Cannot find module \'./missing.js\'\n' +
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1:1)\n';
  const lines = extractCommandFailurePreview(text, 2);
  assert.match(lines.join('\n'), /Cannot find module/);
}

{
  assert.deepEqual(extractCommandFailurePreview(''), []);
  assert.deepEqual(extractCommandFailurePreview('exit_code: 1\n'), []);
}

// TUI collapsed row shows tail error, not only exit_code
{
  const result =
    'exit_code: 1\n' +
    'FAIL packages/moss-agent/test/foo.spec.mjs\n' +
    'AssertionError: expected 1 to equal 2\n';
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'exec-fail',
        toolName: 'exec',
        toolCallId: 'exec-fail',
        status: 'failed',
        elapsedMs: 120,
        inputSummary: 'npm test',
        result,
      },
      expanded: false,
    }),
  );
  const frame = rendered.lastFrame() || '';
  rendered.unmount();
  assert.match(frame, /exec/);
  assert.match(frame, /AssertionError|expected 1 to equal 2|FAIL packages/);
  assert.ok(
    !/^\s*exit_code:\s*1\s*$/m.test(frame) || /AssertionError|FAIL packages/.test(frame),
    'must surface more than bare exit_code',
  );
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

// TUI collapsed success exec shows tail
{
  const result = [
    'Compiling packages/moss-agent...',
    'Checking types...',
    'Running tests...',
    'All checks passed.',
    'Done in 12.4s.',
  ].join('\n');
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'exec-ok',
        toolName: 'exec',
        toolCallId: 'exec-ok',
        status: 'ok',
        elapsedMs: 12400,
        inputSummary: 'npm run build',
        result,
      },
      expanded: false,
    }),
  );
  const frame = rendered.lastFrame() || '';
  rendered.unmount();
  assert.match(frame, /exec/);
  assert.match(frame, /All checks passed|Done in 12\.4s/);
}

// Sibling: exec_background success/failure also get previews (not only bare exec)
{
  const okResult = [
    'server listening on :3000',
    'ready',
    'GET /health 200',
    'startup complete',
  ].join('\n');
  const ok = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'bg-ok',
        toolName: 'exec_background',
        toolCallId: 'bg-ok',
        status: 'ok',
        elapsedMs: 40,
        inputSummary: 'npm run dev',
        result: okResult,
      },
      expanded: false,
    }),
  );
  const okFrame = ok.lastFrame() || '';
  ok.unmount();
  assert.match(okFrame, /exec_background/);
  assert.match(okFrame, /startup complete|GET \/health/);

  const fail = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'bg-fail',
        toolName: 'exec_background',
        toolCallId: 'bg-fail',
        status: 'failed',
        elapsedMs: 80,
        inputSummary: 'npm run dev',
        result: 'exit_code: 1\nError: listen EADDRINUSE :::3000\n',
      },
      expanded: false,
    }),
  );
  const failFrame = fail.lastFrame() || '';
  fail.unmount();
  assert.match(failFrame, /exec_background/);
  assert.match(failFrame, /EADDRINUSE|listen/);
}

console.log('[PASS] exec failure preview');
