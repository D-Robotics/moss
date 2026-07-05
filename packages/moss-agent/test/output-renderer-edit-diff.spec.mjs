#!/usr/bin/env node
/**
 * createCliRunRenderer — verbose mode edit_file diff rendering. The renderer's
 * tool_end path (output.ts) reuses diffLinesForApproval to render an inline
 * old_string -> new_string diff under a "diff:" header in verbose mode.
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { createCliRunRenderer } from '../dist/cli/output.js';

function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); },
  });
  stream.isTTY = false;
  return { stream, text: () => chunks.join('') };
}

// Synthetic tool_start + tool_end for an edit_file call.
const toolCallId = 'tc_1';
const toolStartEvent = {
  type: 'tool_start',
  toolCallId,
  toolName: 'edit_file',
  input: { path: 'app.js', old_string: 'return x * 2;', new_string: 'return x * 3;' },
};
const toolEndEvent = {
  type: 'tool_end',
  toolCallId,
  toolName: 'edit_file',
  input: toolStartEvent.input,
  result: 'Edited app.js (replaced 1 occurrence).',
  isError: false,
  durationMs: 2,
};

// ─── verbose mode renders the edit_file diff ──────────────────────────────

{
  const out = captureStream();
  const renderer = createCliRunRenderer({
    stdout: out.stream,
    stderr: out.stream,
    detailMode: 'verbose',
    interactive: false,
  });
  renderer.handle(toolStartEvent);
  renderer.handle(toolEndEvent);
  const text = out.text();
  assert.ok(text.includes('diff:'), 'verbose edit_file output has a diff: header');
  assert.ok(/- return x \* 2/.test(text), 'diff shows the removed old line');
  assert.ok(/\+ return x \* 3/.test(text), 'diff shows the added new line');
  assert.ok(text.includes('Edited app.js'), 'result summary still present');
}

// ─── progress (non-verbose) mode does NOT render the diff ─────────────────

{
  const out = captureStream();
  const renderer = createCliRunRenderer({
    stdout: out.stream,
    stderr: out.stream,
    detailMode: 'progress',
    interactive: false,
  });
  renderer.handle(toolStartEvent);
  renderer.handle(toolEndEvent);
  const text = out.text();
  assert.ok(!text.includes('diff:'), 'progress mode does not render the diff block');
  assert.ok(text.includes('updating file'), 'progress mode still shows the tool label');
}

console.error('output-renderer: verbose edit_file diff rendered, progress mode omits it ✓');
