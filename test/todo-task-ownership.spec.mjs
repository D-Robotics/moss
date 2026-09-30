#!/usr/bin/env node
/**
 * todo_write under the unified task runtime (Task OS M12 finding #3).
 *
 * Two checklists cost turns: the runtime plan (task_plan_update) drives the
 * timeline, acceptance and TUI, while a parallel todo list drives nothing.
 * The guard must be narrow: only a live task that actually has a plan owns the
 * checklist — an empty draft in .moss must not silently disable todo_write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { todoWriteTool } from '../dist/tools/todo-tool.js';
import { appendTaskEvent, createDraftTask } from '../dist/core/task/task-store.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-todo-task-'));
}

const TODOS = [{ content: 'wire the guard', status: 'in_progress' }];

test('todos still work when no task is live', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = await todoWriteTool.execute({ todos: TODOS }, ctx(dir));
  assert.match(out, /wire the guard/);
});

test('a draft task with no plan does not disable todos (ambient state is not a contract)', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await createDraftTask(dir, 'Investigate the camera pipeline');
  const out = await todoWriteTool.execute({ todos: TODOS }, ctx(dir));
  assert.match(out, /wire the guard/);
});

test('a live task with a plan owns the checklist and redirects todo_write', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const contract = await createDraftTask(dir, 'Ship the camera pipeline');
  await appendTaskEvent(dir, contract.taskId, 'plan_ready', {
    steps: [
      { stepId: 's1', title: 'read driver source', status: 'done' },
      { stepId: 's2', title: 'patch exposure control', status: 'in_progress' },
    ],
  });

  const out = await todoWriteTool.execute({ todos: TODOS }, ctx(dir));
  assert.match(out, /Not applied/);
  assert.match(out, new RegExp(contract.taskId));
  assert.match(out, /task_plan_update/);
  assert.match(out, /\[x\] read driver source/);
  assert.match(out, /\[>\] patch exposure control/);
  assert.doesNotMatch(out, /wire the guard/, 'the todo list must not be applied');
});
