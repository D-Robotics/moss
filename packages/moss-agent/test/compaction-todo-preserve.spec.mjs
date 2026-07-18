#!/usr/bin/env node
/**
 * Compaction must preserve the active todo checklist across context compression.
 *
 * A long coding session's todo_write result often lands in the pruned middle;
 * before the fix the LLM/deterministic summary did not carry the structured
 * checklist forward, so the agent lost its todo thread after compaction. The
 * fix appends an `<active-todos>` block (extracted from the full pre-prune
 * message list) to the summary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compactHistoryIfNeeded } from '../dist/context/compaction.js';

const TODO_TEXT = [
  '1. ○ Fix the login bug [pending]',
  '2. ◐ Refactor the auth module [in_progress]',
  '3. ✓ Add regression tests [completed]',
  '',
  'Progress: 1/3 complete.',
].join('\n');

/** A long-ish conversation where the todo_write round-trip sits early (gets
 * pruned when forceCompaction keeps only the tail). */
function conversationWithTodo() {
  return [
    { role: 'user', content: 'fix the login bug, then refactor auth, then add tests' },
    { role: 'assistant', content: [{ type: 'text', text: 'on it — planning first' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'todo_write', input: { todos: [] } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', name: 'todo_write', content: TODO_TEXT }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'starting on the login bug now' }] },
    { role: 'user', content: 'remember to keep the tests minimal' },
    { role: 'assistant', content: [{ type: 'text', text: 'understood' }] },
    { role: 'user', content: 'any progress?' },
    { role: 'assistant', content: [{ type: 'text', text: 'investigating the login flow' }] },
  ];
}

async function compact(messages) {
  const result = await compactHistoryIfNeeded({
    summarize: async () => '', // unused — skipLlmCompaction forces the deterministic path
    messages,
    contextWindowTokens: 1000,
    forceCompaction: true,
    skipLlmCompaction: true,
  });
  assert.ok(result.summary, 'compaction produced a summary');
  return result.summary;
}

test('compaction summary carries the active todo checklist forward', async () => {
  const summary = await compact(conversationWithTodo());
  assert.match(summary, /<active-todos>/, 'summary includes an <active-todos> block');
  assert.match(summary, /Fix the login bug/, 'carries the pending todo content');
  assert.match(summary, /Refactor the auth module/, 'carries the in-progress todo content');
  assert.match(summary, /\[in_progress\]/, 'preserves todo status markers');
  assert.match(summary, /Progress: 1\/3 complete\./, 'preserves the progress line');
});

test('compaction summary omits <active-todos> when no todo_write happened', async () => {
  const messages = [
    { role: 'user', content: 'just a quick question' },
    { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
    { role: 'user', content: 'follow up' },
    { role: 'assistant', content: [{ type: 'text', text: 'answered' }] },
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: [{ type: 'text', text: 'anytime' }] },
  ];
  const summary = await compact(messages);
  assert.doesNotMatch(summary, /<active-todos>/, 'no todo block when no todo_write ran');
});
