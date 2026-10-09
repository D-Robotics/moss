#!/usr/bin/env node
/**
 * Display channel: harness hint lines stay out of the transcript.
 * Model prose that quotes [System] or [task-phase: stays.
 */
import assert from 'node:assert/strict';

import { userFacingAssistantText, userFacingToolResult } from '../dist/cli/user-facing-text.js';
import {
  applyAgentEvent,
  beginRun,
  createTuiStore,
  endRun,
} from '../dist/cli/tui/render-bridge.js';

const source = 'export function stop() {\n  return exec_stop("bg_1");\n}\n';
assert.equal(userFacingToolResult(source, 'read_file'), source);

const edited =
  'Applied 1 edit(s).\n  code uses exec_stop("bg_1")\nVerify with tests instead of re-reading every file.';
assert.equal(
  userFacingToolResult(edited, 'multi_edit'),
  'Applied 1 edit(s).\n  code uses exec_stop("bg_1")'
);

assert.equal(
  userFacingToolResult(
    'Started bg_1. use exec_logs("bg_1") to monitor and exec_stop("bg_1") to terminate.\nchild printed exec_stop("bg_1")',
    'exec_background'
  ),
  'Started bg_1. use exec_logs("bg_1") to monitor and /stop to terminate.\nchild printed exec_stop("bg_1")'
);

const assistant = userFacingAssistantText(
  [
    'The board is up.',
    '[System] You described using tools.',
    '[task-phase: note for the reader]',
    '[task-phase:planning]',
    'Verify with tests instead of re-reading every file.',
  ].join('\n')
);
assert.equal(
  assistant,
  'The board is up.\n[System] You described using tools.\n[task-phase: note for the reader]'
);

{
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'read_file',
    toolCallId: 'c1',
    result: source,
    isError: false,
  });
  const read = store.rows.find((row) => row.kind === 'result');
  assert.ok(read, 'read_file lands in the transcript');
  assert.match(read.text, /exec_stop\("bg_1"\)/);

  applyAgentEvent(store, {
    type: 'text_delta',
    delta: '[System] The board is nominal.\n',
  });
  endRun(store, false);
  const answer = store.rows.filter((row) => row.kind === 'assistant').map((row) => row.text);
  assert.deepEqual(answer, ['[System] The board is nominal.']);
}

console.log('[PASS] user-facing text');
