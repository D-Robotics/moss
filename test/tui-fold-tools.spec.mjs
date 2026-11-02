#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  foldReadonlyRows,
  renderTranscriptRow,
  renderTranscriptRows,
} from '../dist/cli/tui/transcript.js';
import { applyAgentEvent, beginRun, createTuiStore } from '../dist/cli/tui/render-bridge.js';

const rows = [
  { id: 1, kind: 'tool', text: 'Read(a.ts)', tool: { name: 'read_file' } },
  { id: 2, kind: 'result', text: 'one' },
  { id: 3, kind: 'tool', text: 'Read(b.ts)', tool: { name: 'read_file' } },
  { id: 4, kind: 'result', text: 'two' },
  { id: 5, kind: 'tool', text: 'List(.)', tool: { name: 'list_directory' } },
  { id: 6, kind: 'result', text: 'dir' },
  { id: 7, kind: 'tool', text: 'Write(c.ts)', tool: { name: 'write_file' } },
];

const folded = foldReadonlyRows(rows, false);
assert.equal(folded.length, 2);
assert.match(folded[0].text, /read 2 files/);
assert.match(folded[0].text, /listed 1 directory/);
assert.equal(folded[1].text, 'Write(c.ts)');
assert.equal(foldReadonlyRows(rows, true).length, rows.length);

// Concurrent reads must keep the error with the correct file and the other
// in-flight tool visible, even in the compact transcript.
{
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, {
    type: 'tool_start',
    toolCallId: 'a',
    toolName: 'read_file',
    input: { path: 'a.ts' },
  });
  applyAgentEvent(store, {
    type: 'tool_start',
    toolCallId: 'b',
    toolName: 'read_file',
    input: { path: 'b.ts' },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolCallId: 'a',
    toolName: 'read_file',
    result: 'Permission denied',
    isError: true,
  });
  assert.match(store.run.toolLine ?? '', /b\.ts/, 'the other tool is still running');
  assert.equal(renderTranscriptRow(store.rows[2], 100, false, store.rows[1])[0].text, '');
  applyAgentEvent(store, {
    type: 'tool_end',
    toolCallId: 'b',
    toolName: 'read_file',
    result: 'content B',
    isError: false,
  });
  const rendered = renderTranscriptRows(foldReadonlyRows(store.rows, false), 100)
    .map((line) => line.text)
    .join('\n');
  assert.match(rendered, /a\.ts[^\n]*failed/i);
  assert.match(rendered, /Permission denied/);
  assert.match(rendered, /b\.ts[^\n]*(Read|line)/i);
  assert.match(rendered, /content B/);
}
