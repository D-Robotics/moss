#!/usr/bin/env node
/**
 * Task OS M4 — tool layer wiring: task_acceptance emits lifecycle events,
 * task_plan_update / record_failure / record_repair persist through the
 * runtime store, record_evidence lands on the timeline, and the completion
 * gate consults the runtime for engine-settled acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  taskAcceptanceTool,
  taskPlanUpdateTool,
  recordFailureTool,
  recordRepairTool,
  taskDefineTool,
} from '../dist/tools/task-tools.js';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';
import {
  appendTaskEvent,
  createDraftTask,
  getTaskStateSnapshot,
  listTaskEvents,
} from '../dist/core/task/task-store.js';
import { createAcceptanceCompletionGate } from '../dist/core/loop/acceptance-completion-gate.js';

function makeCtx(workspaceDir) {
  return { workspaceDir, sessionKey: 'task-tools-runtime-test' };
}

async function tmpWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-tools-'));
}

async function liveExecutingTask(ws) {
  const { taskId } = await createDraftTask(ws, 'goal under test');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await taskDefineTool.execute(
    {
      goal: 'goal under test',
      task_id: taskId,
      acceptance_criteria: [{ metric: 'camera_fps', expected: '>=30' }],
    },
    makeCtx(ws)
  );
  return taskId;
}

function toolUseMessage(name, input) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: `use_${name}`, name, input }],
    timestamp: 1,
  };
}

function toolResultMessage(id, text) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
    timestamp: 2,
  };
}

test('task_acceptance from executing emits verification_started + verdict event', async () => {
  const ws = await tmpWorkspace();
  const taskId = await liveExecutingTask(ws);

  // no evidence → FAIL, phase moves executing -> verifying -> diagnosing
  const failText = await taskAcceptanceTool.execute({ task_id: taskId }, makeCtx(ws));
  assert.match(failText, /FINAL: not accepted/);
  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'diagnosing');

  // repair: record passing evidence, then acceptance passes -> accepted
  await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '31.4',
      source: 'device_exec',
      task_id: taskId,
    },
    makeCtx(ws)
  );
  const passText = await taskAcceptanceTool.execute({ task_id: taskId }, makeCtx(ws));
  assert.match(passText, /FINAL: PASS/);
  const accepted = await getTaskStateSnapshot(ws, taskId);
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.outcome, 'pass');

  const types = (await listTaskEvents(ws, taskId)).map((e) => e.type);
  assert.ok(types.includes('verification_started'));
  assert.ok(types.includes('acceptance_fail'));
  assert.ok(types.includes('evidence_recorded'));
  assert.equal(types[types.length - 1], 'acceptance_pass');
});

test('task_acceptance after acceptance is a lifecycle no-op (verdict still returned)', async () => {
  const ws = await tmpWorkspace();
  const taskId = await liveExecutingTask(ws);
  await recordEvidenceTool.execute(
    { metric: 'camera_fps', expected: '>=30', observed: '30.5', source: 'test', task_id: taskId },
    makeCtx(ws)
  );
  await taskAcceptanceTool.execute({ task_id: taskId }, makeCtx(ws));
  const before = (await listTaskEvents(ws, taskId)).length;
  const again = await taskAcceptanceTool.execute({ task_id: taskId }, makeCtx(ws));
  assert.match(again, /FINAL: PASS/);
  const after = (await listTaskEvents(ws, taskId)).length;
  assert.equal(after, before);
});

test('task_plan_update persists steps and rejects bad input', async () => {
  const ws = await tmpWorkspace();
  const taskId = await liveExecutingTask(ws);
  const ok = await taskPlanUpdateTool.execute(
    {
      task_id: taskId,
      steps: [
        { step_id: 's1', title: 'Inspect pipeline', status: 'done' },
        { step_id: 's2', title: 'Tune config', status: 'in_progress' },
        { step_id: 's3', title: 'Verify FPS' },
      ],
    },
    makeCtx(ws)
  );
  assert.match(ok, /Plan updated for/);
  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.plan.length, 3);
  assert.equal(snapshot.plan[1].status, 'in_progress');
  assert.equal(snapshot.plan[2].status, 'pending');

  assert.match(
    await taskPlanUpdateTool.execute(
      { task_id: taskId, steps: [{ step_id: 's1', title: 'x', status: 'wat' }] },
      makeCtx(ws)
    ),
    /status "wat" invalid/
  );
  assert.match(
    await taskPlanUpdateTool.execute(
      { task_id: 'task_nope', steps: [{ step_id: 'a', title: 'b' }] },
      makeCtx(ws)
    ),
    /unknown task_id/
  );
});

test('record_failure + record_repair form the failure trail', async () => {
  const ws = await tmpWorkspace();
  const taskId = await liveExecutingTask(ws);
  const failText = await recordFailureTool.execute(
    {
      task_id: taskId,
      symptom: 'camera_fps expected >=30, observed 17.2',
      diagnosis: 'frames dropped under load',
      root_cause: 'buffer count too low',
    },
    makeCtx(ws)
  );
  assert.match(failText, /Failure fail_\S+ recorded/);
  const repairText = await recordRepairTool.execute(
    {
      task_id: taskId,
      action: 'buffers 3 -> 6',
      changed_files: ['config.yaml'],
      redeployed: true,
    },
    makeCtx(ws)
  );
  assert.match(repairText, /Repair rep_\S+ recorded/);
  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.failures.length, 1);
  assert.equal(snapshot.failures[0].rootCause, 'buffer count too low');
  assert.equal(snapshot.repairs.length, 1);
  assert.deepEqual(snapshot.repairs[0].changedFiles, ['config.yaml']);
});

test('completion gate consults the runtime for engine-settled acceptance', async () => {
  const messages = [
    toolUseMessage('task_define', {}),
    toolResultMessage('use_task_define', 'Task contract task_x: active'),
  ];
  const request = { messages, toolCallsByName: { task_define: 1 } };

  // Empty workspace: gate blocks as before (string-based detection only).
  const emptyWs = await tmpWorkspace();
  const blockingGate = createAcceptanceCompletionGate({ workspaceDir: emptyWs });
  const blocked = await blockingGate(request);
  assert.equal(blocked.ok, false);

  // Workspace where the runtime already accepted the latest task: gate opens
  // even though the message history has no task_acceptance result.
  const settledWs = await tmpWorkspace();
  const taskId = await liveExecutingTask(settledWs);
  await recordEvidenceTool.execute(
    { metric: 'camera_fps', expected: '>=30', observed: '33', source: 'test', task_id: taskId },
    makeCtx(settledWs)
  );
  await taskAcceptanceTool.execute({ task_id: taskId }, makeCtx(settledWs));
  const runtimeGate = createAcceptanceCompletionGate({ workspaceDir: settledWs });
  const opened = await runtimeGate(request);
  assert.equal(opened.ok, true);

  // Still blocks at most once per gate instance.
  const twice = await blockingGate(request);
  assert.equal(twice.ok, true);
});
