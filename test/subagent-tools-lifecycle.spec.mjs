#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInMemoryMossAsyncTaskRegistry } from '../dist/contracts/async-task.js';
import {
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
} from '../dist/tools/create-subagent.js';
import { buildTaskContextBrief, createDraftTask } from '../dist/core/task/task-store.js';

/**
 * The §14 live-task brief is read from '<workspaceDir>/.moss', so a spec that
 * points workspaceDir at process.cwd() silently inherits whatever task the
 * developer's checkout happens to hold — the fan-out contract stops being
 * tested (observed: 8 ok / 0 failed instead of 7 ok / 1 failed, because the
 * brief prefix no longer matched the mock's 'fail' sentinel). Every test below
 * gets its own empty workspace; the brief itself is locked by the last test.
 */
function hermeticWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-subagent-spec-'));
}

function taskIdFrom(output) {
  return /\[Sub-agent task ([^\]]+)\]/.exec(output)?.[1];
}

test('background sub-agent reports progress and completion through status', async () => {
  const workspaceDir = hermeticWorkspace();
  const registry = createInMemoryMossAsyncTaskRegistry();
  const ctx = {
    workspaceDir,
    sessionKey: 'parent',
    runId: 'run-1',
    abortSignal: new AbortController().signal,
    asyncTaskRegistry: registry,
    spawnSubagent: async ({ task, onProgress }) => {
      onProgress?.({
        runId: 'child-1',
        scope: 'explore',
        task,
        status: 'running',
        phase: 'turn',
        turn: 2,
        maxTurns: 8,
        toolResults: 1,
        lastTool: 'read_file',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        runId: 'child-1',
        sessionKey: 'child-session',
        summary: 'found the answer',
        success: true,
        turns: 2,
        toolResults: 1,
        durationMs: 20,
      };
    },
  };
  const started = await createSubagentTool.execute(
    { task: 'inspect parser', scope: 'explore', background: true, maxTurns: 8 },
    ctx
  );
  const taskId = taskIdFrom(started);
  assert.ok(taskId, started);
  const done = await subagentStatusTool.execute({ taskId, wait: true }, ctx);
  assert.match(done, /SUCCESS/);
  assert.match(done, /status: completed/);
  assert.match(done, /found the answer/);
  assert.match(done, /turns: 2/);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test('background sub-agent stop aborts the child signal', async () => {
  const workspaceDir = hermeticWorkspace();
  const registry = createInMemoryMossAsyncTaskRegistry();
  let childAborted = false;
  const ctx = {
    workspaceDir,
    sessionKey: 'parent',
    runId: 'run-stop',
    abortSignal: new AbortController().signal,
    asyncTaskRegistry: registry,
    spawnSubagent: ({ abortSignal }) =>
      new Promise((resolve) => {
        abortSignal?.addEventListener(
          'abort',
          () => {
            childAborted = true;
            resolve({
              runId: 'child-stop',
              sessionKey: 'child-stop',
              summary: 'cancelled',
              success: false,
            });
          },
          { once: true }
        );
      }),
  };
  const started = await createSubagentTool.execute(
    { task: 'wait forever', scope: 'explore', background: true },
    ctx
  );
  const taskId = taskIdFrom(started);
  assert.ok(taskId, started);
  const stopped = await subagentStopTool.execute({ taskId }, ctx);
  assert.match(stopped, /STOP/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(childAborted, true);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test('fan-out runs up to eight independent tasks and aggregates failures', async () => {
  assert.match(fanOutSubagentsTool.description, /2-8/);
  const workspaceDir = hermeticWorkspace();
  let active = 0;
  let maxActive = 0;
  const spawnMetadata = [];
  const ctx = {
    workspaceDir,
    sessionKey: 'parent',
    abortSignal: new AbortController().signal,
    spawnSubagent: async ({ task, mode, tasks }) => {
      spawnMetadata.push({ mode, taskCount: tasks?.length });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (task === 'fail') throw new Error('boom');
      return { runId: task, sessionKey: task, summary: `summary ${task}`, success: true };
    },
  };
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    task: index === 7 ? 'fail' : `task-${index}`,
    label: `angle-${index}`,
  }));
  const output = await fanOutSubagentsTool.execute({ tasks }, ctx);
  assert.equal(maxActive, 8, 'all independent tasks start concurrently');
  assert.deepEqual(
    spawnMetadata,
    Array.from({ length: 8 }, () => ({ mode: 'fan-out', taskCount: 8 })),
    'each child carries batch metadata used by the bounded retry budget'
  );
  assert.match(output, /8 sub-agents ran concurrently — 7 ok, 1 failed/);
  assert.match(output, /boom/);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test('sub-agent prompts carry the live task brief only when one exists', async () => {
  const workspaceDir = hermeticWorkspace();
  const seen = [];
  const ctx = {
    workspaceDir,
    sessionKey: 'parent',
    runId: 'run-brief',
    abortSignal: new AbortController().signal,
    spawnSubagent: async ({ task }) => {
      seen.push(task);
      return { runId: task, sessionKey: task, summary: `summary ${task}`, success: true };
    },
  };
  const batch = [
    { task: 'inspect camera driver', label: 'camera' },
    { task: 'check i2c bus', label: 'bus' },
  ];

  await fanOutSubagentsTool.execute({ tasks: batch }, ctx);
  assert.deepEqual(
    seen,
    ['inspect camera driver', 'check i2c bus'],
    'no live task: the child gets the bare task text'
  );

  seen.length = 0;
  const contract = await createDraftTask(
    workspaceDir,
    'Create hello-moss.txt containing exactly "MOSS_OK"'
  );
  const brief = await buildTaskContextBrief(workspaceDir);
  assert.match(brief, /^\[Task context you are part of\]/);
  assert.match(brief, new RegExp(`task_id: ${contract.taskId}`));

  await fanOutSubagentsTool.execute({ tasks: batch }, ctx);
  batch.forEach((entry, index) => {
    assert.ok(seen[index].startsWith(brief), `child ${index} carries the shared brief`);
    assert.ok(seen[index].endsWith(entry.task), `child ${index} keeps its own task text`);
  });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});
