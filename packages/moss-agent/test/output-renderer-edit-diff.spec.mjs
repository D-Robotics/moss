#!/usr/bin/env node
/**
 * createCliRunRenderer — edit_file / write_file / apply_patch previews.
 * Progress and verbose modes both show a compact colored diff so oneshot
 * users can audit code changes (parity with TUI default previews).
 * Quiet mode still omits tool detail noise.
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

// ─── progress mode ALSO renders a compact diff (oneshot default) ──────────

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
  assert.ok(text.includes('diff:'), 'progress mode renders the diff block');
  assert.ok(/- return x \* 2/.test(text), 'progress diff shows removed line');
  assert.ok(/\+ return x \* 3/.test(text), 'progress diff shows added line');
  assert.ok(text.includes('edit_file'), 'progress mode still shows the tool name');
}

// ─── quiet mode omits code previews ───────────────────────────────────────

{
  const out = captureStream();
  const renderer = createCliRunRenderer({
    stdout: out.stream,
    stderr: out.stream,
    detailMode: 'quiet',
    interactive: false,
  });
  renderer.handle(toolStartEvent);
  renderer.handle(toolEndEvent);
  const text = out.text();
  assert.ok(!text.includes('diff:'), 'quiet mode does not render the diff block');
}

// ─── write_file content preview in progress ───────────────────────────────

{
  const out = captureStream();
  const renderer = createCliRunRenderer({
    stdout: out.stream,
    stderr: out.stream,
    detailMode: 'progress',
    interactive: false,
  });
  const id = 'w1';
  renderer.handle({
    type: 'tool_start',
    toolCallId: id,
    toolName: 'write_file',
    input: { path: 'hello.ts', content: 'export const hi = 1;\n' },
  });
  renderer.handle({
    type: 'tool_end',
    toolCallId: id,
    toolName: 'write_file',
    input: { path: 'hello.ts', content: 'export const hi = 1;\n' },
    result: 'Successfully wrote 20 chars',
    isError: false,
    durationMs: 1,
  });
  const text = out.text();
  assert.ok(text.includes('content:'), 'progress write_file shows content header');
  assert.ok(/export const hi/.test(text), 'progress write_file shows written content');
}

console.error('output-renderer: progress+verbose show code diffs; quiet omits them ✓');
