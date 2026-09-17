import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findReplayableToolResultContent } from '../dist/core/tools/index.js';
import {
  FILE_UNCHANGED_PLACEHOLDER,
  STALE_READ_PLACEHOLDER,
} from '../dist/context/stale-read-invalidate.js';

function assistantToolUse(id, name, input) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function toolResult(id, content) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  };
}

test('does not replay a file read after the same path was mutated', () => {
  const messages = [
    assistantToolUse('read-1', 'read_file', { path: 'src/example.ts' }),
    toolResult('read-1', 'export const value = 1;'),
    assistantToolUse('edit-1', 'edit_file', {
      path: 'src/example.ts',
      old_string: '1',
      new_string: '2',
    }),
    toolResult('edit-1', 'Updated src/example.ts'),
  ];

  assert.equal(
    findReplayableToolResultContent(
      messages,
      'read_file',
      { path: 'src/example.ts' },
      32,
      'readonly'
    ),
    null
  );
});

test('treats apply_patch as a write barrier for file reads', () => {
  const messages = [
    assistantToolUse('read-1', 'read_file', { path: 'src/example.ts' }),
    toolResult('read-1', 'export const value = 1;'),
    assistantToolUse('patch-1', 'apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-1\n+2\n*** End Patch',
    }),
    toolResult('patch-1', 'Done!'),
  ];

  assert.equal(
    findReplayableToolResultContent(
      messages,
      'read_file',
      { path: 'src/example.ts' },
      32,
      'readonly'
    ),
    null
  );
});

test('recognizes equivalent relative paths across read and mutation tools', () => {
  const messages = [
    assistantToolUse('read-1', 'read_file', { path: './src/example.ts' }),
    toolResult('read-1', 'export const value = 1;'),
    assistantToolUse('write-1', 'write_file', {
      path: 'src/example.ts',
      content: 'export const value = 2;',
    }),
    toolResult('write-1', 'Updated src/example.ts'),
  ];

  assert.equal(
    findReplayableToolResultContent(
      messages,
      'read_file',
      { path: './src/example.ts' },
      32,
      'readonly'
    ),
    null
  );
});

test('does not replay compacted read placeholders', () => {
  for (const placeholder of [STALE_READ_PLACEHOLDER, FILE_UNCHANGED_PLACEHOLDER]) {
    const messages = [
      assistantToolUse('read-1', 'read_file', { path: 'src/example.ts' }),
      toolResult('read-1', placeholder),
    ];

    assert.equal(
      findReplayableToolResultContent(
        messages,
        'read_file',
        { path: 'src/example.ts' },
        32,
        'readonly'
      ),
      null
    );
  }
});
