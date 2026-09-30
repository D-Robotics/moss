#!/usr/bin/env node
/**
 * Task OS §14 — sub-agents share the live task context: spawned prompts carry
 * the goal/plan/acceptance brief (prepended, not replacing the task), and
 * stay untouched when no live task exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSubagentTool } from '../dist/tools/create-subagent.js';
import { createDraftTask, appendTaskEvent } from '../dist/core/task/task-store.js';

function makeCtx(ws, capture) {
  return {
    workspaceDir: ws,
    sessionKey: 'ctx-test',
    spawnSubagent: async (req) => {
      capture(req);
      return {
        runId: 'r-ctx',
        summary: 'looked around',
        success: true,
        turns: 1,
        toolResults: 1,
        durationMs: 4,
      };
    },
  };
}

test('spawned sub-agent prompt carries the live task brief', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ctx-'));
  const contract = await createDraftTask(ws, '优化 RDK 摄像头 FPS 到 30');
  await appendTaskEvent(ws, contract.taskId, 'plan_ready', {
    steps: [
      { stepId: 's1', title: 'Inspect pipeline', status: 'done' },
      { stepId: 's2', title: 'Tune config', status: 'in_progress' },
    ],
  });
  await appendTaskEvent(ws, contract.taskId, 'execution_started');

  let captured;
  const ctx = makeCtx(ws, (req) => {
    captured = req.task;
  });
  const result = await createSubagentTool.execute(
    { task: 'find the camera pipeline config', scope: 'read-only' },
    ctx
  );
  assert.match(result, /SUCCESS/);
  assert.match(captured, /\[Task context you are part of\]/);
  assert.match(captured, /goal: 优化 RDK 摄像头 FPS 到 30/);
  assert.match(captured, /plan: xInspect pipeline \| >Tune config/);
  assert.match(captured, /task_id: task_/);
  assert.match(captured, /---\n\nfind the camera pipeline config/);
  await fs.rm(ws, { recursive: true, force: true });
});

test('no live task → sub-agent prompt unchanged', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ctx-empty-'));
  let captured;
  const ctx = makeCtx(ws, (req) => {
    captured = req.task;
  });
  await createSubagentTool.execute({ task: 'plain job', scope: 'read-only' }, ctx);
  assert.equal(captured, 'plain job');
  await fs.rm(ws, { recursive: true, force: true });
});

test('settled (accepted) tasks are not injected', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ctx-done-'));
  const contract = await createDraftTask(ws, 'done thing');
  await appendTaskEvent(ws, contract.taskId, 'execution_started');
  await appendTaskEvent(ws, contract.taskId, 'verification_started');
  await appendTaskEvent(ws, contract.taskId, 'acceptance_pass');
  let captured;
  const ctx = makeCtx(ws, (req) => {
    captured = req.task;
  });
  await createSubagentTool.execute({ task: 'next job', scope: 'read-only' }, ctx);
  assert.equal(captured, 'next job');
  await fs.rm(ws, { recursive: true, force: true });
});
