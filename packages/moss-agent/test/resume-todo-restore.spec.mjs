#!/usr/bin/env node
/**
 * Resume restores sticky todo checklist from session history.
 */
import assert from 'node:assert/strict';

import { extractLatestTodosFromMessages } from '../dist/cli/coding-completion-gate.js';
import { formatTodos } from '../dist/tools/todo-tool.js';

const checklist = formatTodos([
  { content: 'Locate auth entry', status: 'completed' },
  { content: 'Fix token refresh', status: 'in_progress' },
  { content: 'Add regression test', status: 'pending' },
]);

const messages = [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tu_todo_1',
        name: 'todo_write',
        input: { todos: [] },
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu_todo_1',
        content: checklist,
      },
    ],
  },
  {
    role: 'assistant',
    content: 'Working on the token refresh fix…',
  },
];

const todos = extractLatestTodosFromMessages(messages);
assert.ok(todos, 'resume can find the latest todo_write checklist');
assert.equal(todos.length, 3);
assert.equal(todos[0].status, 'completed');
assert.equal(todos[1].content, 'Fix token refresh');
assert.equal(todos[1].status, 'in_progress');
assert.equal(todos[2].status, 'pending');

// Cleared list
const cleared = extractLatestTodosFromMessages([
  ...messages,
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_todo_2', name: 'todo_write', input: { todos: [] } }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_todo_2', content: 'Todo list cleared.' }],
  },
]);
assert.deepEqual(cleared, []);

console.log('[PASS] resume todo restore');
