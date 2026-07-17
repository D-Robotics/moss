import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  invalidateStaleReadToolResults,
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

function blockContent(messages, msgIdx, blockIdx) {
  return messages[msgIdx].content[blockIdx].content;
}

test('multi_edit invalidates stale reads for every edited file', () => {
  const messages = [
    assistantToolUse('read-a', 'read_file', { path: 'src/a.ts' }),
    toolResult('read-a', 'export const a = 1;'),
    assistantToolUse('read-b', 'read_file', { path: 'src/b.ts' }),
    toolResult('read-b', 'export const b = 1;'),
    assistantToolUse('me-1', 'multi_edit', {
      edits: [
        { path: 'src/a.ts', old_string: '1', new_string: '2' },
        { path: 'src/b.ts', old_string: '1', new_string: '2' },
      ],
    }),
    toolResult('me-1', 'Edited 2 files'),
  ];

  const result = invalidateStaleReadToolResults(messages);

  assert.equal(result.invalidatedCount, 2);
  // read-a sits at messages[1].content[0]; read-b at messages[3].content[0]
  assert.equal(blockContent(result.messages, 1, 0), STALE_READ_PLACEHOLDER);
  assert.equal(blockContent(result.messages, 3, 0), STALE_READ_PLACEHOLDER);
});

test('apply_patch invalidates stale reads for the patched file', () => {
  const messages = [
    assistantToolUse('read-c', 'read_file', { path: 'src/c.ts' }),
    toolResult('read-c', 'export const c = 1;'),
    assistantToolUse('patch-1', 'apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/c.ts\n@@\n-1\n+2\n*** End Patch',
    }),
    toolResult('patch-1', 'Patch applied'),
  ];

  const result = invalidateStaleReadToolResults(messages);

  assert.equal(result.invalidatedCount, 1);
  assert.equal(blockContent(result.messages, 1, 0), STALE_READ_PLACEHOLDER);
});

test('move_file invalidates stale reads for the source path', () => {
  const messages = [
    assistantToolUse('read-d', 'read_file', { path: 'src/d.ts' }),
    toolResult('read-d', 'export const d = 1;'),
    assistantToolUse('move-1', 'move_file', {
      source: 'src/d.ts',
      destination: 'src/e.ts',
    }),
    toolResult('move-1', 'Moved src/d.ts -> src/e.ts'),
  ];

  const result = invalidateStaleReadToolResults(messages);

  assert.equal(result.invalidatedCount, 1);
  assert.equal(blockContent(result.messages, 1, 0), STALE_READ_PLACEHOLDER);
});

test('single-file edit_file still invalidates (regression guard)', () => {
  const messages = [
    assistantToolUse('read-x', 'read_file', { path: 'src/x.ts' }),
    toolResult('read-x', 'export const x = 1;'),
    assistantToolUse('edit-x', 'edit_file', {
      path: 'src/x.ts',
      old_string: '1',
      new_string: '2',
    }),
    toolResult('edit-x', 'Edited src/x.ts'),
  ];

  const result = invalidateStaleReadToolResults(messages);

  assert.equal(result.invalidatedCount, 1);
  assert.equal(blockContent(result.messages, 1, 0), STALE_READ_PLACEHOLDER);
});

test('reads after a mutation are not invalidated', () => {
  const messages = [
    assistantToolUse('me-1', 'multi_edit', {
      edits: [{ path: 'src/a.ts', old_string: '1', new_string: '2' }],
    }),
    toolResult('me-1', 'Edited'),
    assistantToolUse('read-a', 'read_file', { path: 'src/a.ts' }),
    toolResult('read-a', 'export const a = 2;'),
  ];

  const result = invalidateStaleReadToolResults(messages);

  // The read happened after the mutation, so it is the current truth — keep it.
  assert.equal(result.invalidatedCount, 0);
  assert.equal(blockContent(result.messages, 3, 0), 'export const a = 2;');
});
