#!/usr/bin/env node
/**
 * todo_write replaces the whole checklist. An item it cannot store used to be
 * dropped in silence: `[{ status: 'pending' }]` answered "Todo list cleared.",
 * which reads as an intentional clear and loses the step the model meant to add.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTodos, todoWriteTool } from '../dist/tools/todo-tool.js';

const ctx = () => ({
  workspaceDir: undefined,
  sessionKey: 'test',
  abortSignal: new AbortController().signal,
});

test('an item with no content is reported instead of clearing the list', async () => {
  const out = await todoWriteTool.execute({ todos: [{ id: 'a', status: 'pending' }] }, ctx());
  assert.match(out, /^Error: todo_write was not applied/);
  assert.match(out, /#1 \(empty content\)/);
  assert.doesNotMatch(out, /cleared/i);
});

test('one bad item blocks the whole write and names every bad index', async () => {
  const out = await todoWriteTool.execute(
    {
      todos: [
        { content: 'keep this', status: 'pending' },
        { content: '   ', status: 'pending' },
        null,
      ],
    },
    ctx()
  );
  assert.match(out, /#2 \(empty content\)/);
  assert.match(out, /#3 \(not an object\)/);
  assert.doesNotMatch(out, /keep this/, 'a partial list is not applied');
});

test('an empty list is still an intentional clear', async () => {
  const out = await todoWriteTool.execute({ todos: [] }, ctx());
  assert.equal(out, 'Todo list cleared.');
});

test('a valid list renders with progress', async () => {
  const out = await todoWriteTool.execute(
    {
      todos: [
        { content: 'read the spec', status: 'completed' },
        { content: 'write the fix', status: 'in_progress' },
      ],
    },
    ctx()
  );
  assert.match(out, /✓ read the spec \[completed\]/);
  assert.match(out, /Progress: 1\/2 complete\./);
});

test('formatTodos reads a cleared list as cleared', () => {
  assert.equal(formatTodos([]), 'Todo list cleared.');
});
