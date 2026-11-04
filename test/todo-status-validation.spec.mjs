#!/usr/bin/env node
/**
 * todo_write must not launder a malformed status into `pending`.
 *
 * Nested item fields bypass `validateToolInputObject` (it checks top-level
 * parameters only), so `{status: "doing"}` used to render as `○ a [pending]`
 * with `Progress: 0/1 complete.` — an apparently applied write that the model
 * then believed. The list is replaced atomically, so a bad item fails the call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { todoWriteTool } from '../dist/tools/todo-tool.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-todo-status-'));
}

test('an unknown status is refused and named', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = await todoWriteTool.execute({ todos: [{ content: 'a', status: 'doing' }] }, ctx(dir));
  assert.match(out, /^Error: todo_write was not applied/);
  assert.match(out, /"a" \("doing"\)/);
  assert.match(out, /pending, in_progress or completed/);
  // Must not look like a checklist result: compaction and the sticky panel
  // parse `Progress: n/m complete.` out of todo_write output.
  assert.doesNotMatch(out, /Progress:/);
});

test('a missing status is refused instead of defaulting to pending', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = await todoWriteTool.execute({ todos: [{ content: 'a' }] }, ctx(dir));
  assert.match(out, /^Error: todo_write was not applied/);
  assert.match(out, /"a" \(missing\)/);
});

test('one bad item fails the whole list; the good items are not applied', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = await todoWriteTool.execute(
    {
      todos: [
        { content: 'good', status: 'completed' },
        { content: 'bad', status: 'in-progress' },
      ],
    },
    ctx(dir)
  );
  assert.match(out, /^Error:/);
  assert.doesNotMatch(out, /good/);
  assert.match(out, /"bad"/);
});

test('valid statuses still render the checklist', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = await todoWriteTool.execute(
    {
      todos: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress' },
        { content: 'three', status: 'pending' },
      ],
    },
    ctx(dir)
  );
  assert.match(out, /1\. ✓ one \[completed\]/);
  assert.match(out, /2\. ◐ two \[in_progress\]/);
  assert.match(out, /3\. ○ three \[pending\]/);
  assert.match(out, /Progress: 1\/3 complete\./);
});
