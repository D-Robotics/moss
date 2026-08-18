#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryMossAsyncTaskRegistry } from '@rdk-moss/core';
import {
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
} from '../dist/tools/create-subagent.js';

function taskIdFrom(output) {
  return /\[Sub-agent task ([^\]]+)\]/.exec(output)?.[1];
}

test('background sub-agent reports progress and completion through status', async () => {
  const registry = createInMemoryMossAsyncTaskRegistry();
  const ctx = {
    workspaceDir: process.cwd(),
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
});

test('background sub-agent stop aborts the child signal', async () => {
  const registry = createInMemoryMossAsyncTaskRegistry();
  let childAborted = false;
  const ctx = {
    workspaceDir: process.cwd(),
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
});

test('fan-out runs up to eight independent tasks and aggregates failures', async () => {
  assert.match(fanOutSubagentsTool.description, /2-8/);
  let active = 0;
  let maxActive = 0;
  const spawnMetadata = [];
  const ctx = {
    workspaceDir: process.cwd(),
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
});
