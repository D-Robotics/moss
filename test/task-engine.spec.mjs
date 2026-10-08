#!/usr/bin/env node
/**
 * Task engine (Task OS M3): goal → plan → execute → verify → (fail → repair
 * → reverify) → acceptance, with a mock agent whose only powers are the
 * store/artifact writes a real agent would do through tools. PASS can only
 * come from the verdict provider — asserted end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_MAX_TURNS,
  runTask,
  resumeTask,
  summarizeTaskRun,
} from '../dist/core/task/task-engine.js';
import { listTaskEvents, recordFailure, recordRepair } from '../dist/core/task/task-store.js';
import { appendTaskRecord, appendEvidenceRecord } from '../dist/core/task-runtime/artifacts.js';
import { createCommandVerdictProvider } from '../dist/core/task/verdict.js';

test('long-horizon defaults outlast a short demo loop', () => {
  assert.ok(DEFAULT_MAX_TURNS >= 24, `turn budget is ${DEFAULT_MAX_TURNS}`);
  assert.ok(DEFAULT_MAX_REPAIR_ATTEMPTS >= 5, `repair budget is ${DEFAULT_MAX_REPAIR_ATTEMPTS}`);
});

async function tmpWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-engine-'));
}

function mockAgent(workspaceDir, script) {
  const calls = [];
  const runTurn = async (prompt, phase) => {
    calls.push({ prompt, phase });
    const action = script[calls.length - 1] ?? (() => {});
    await action(workspaceDir, calls.length - 1);
    return `turn ${calls.length} (${phase}) done`;
  };
  return { runTurn, calls };
}

test('full chain: fail → repair → reverify → accepted, driven only by evidence', async () => {
  const ws = await tmpWorkspace();
  let taskId;
  const { runTurn } = mockAgent(ws, [
    // planning turn: define the contract
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'camera FPS >=30 on device',
        acceptanceCriteria: [{ metric: 'camera_fps', expected: '>=30' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    // first execution turn: no evidence recorded yet → verdict must fail
    () => {},
    // repair turn: record failure, repair, and passing evidence
    async (dir) => {
      await recordFailure(dir, {
        taskId,
        stage: 'verifying',
        symptom: 'camera_fps: no evidence',
        diagnosis: 'pipeline never measured',
        attempt: 1,
        resolved: true,
      });
      await recordRepair(dir, { taskId, action: 'measure pipeline fps', changedFiles: [] });
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'device_exec',
        metric: 'camera_fps',
        expected: '>=30',
        observed: 31.4,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
    // second execution turn: evidence already passing; acceptance confirms
    () => {},
  ]);

  const result = await runTask({ workspaceDir: ws, runTurn }, 'camera FPS >=30 on device');
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  assert.equal(result.snapshot.attempt, 2);
  assert.equal(result.snapshot.statusView, 'completed');
  assert.equal(result.snapshot.failures.length, 1);
  assert.equal(result.snapshot.repairs.length, 1);
  assert.equal(result.snapshot.evidenceCount, 1);
  assert.equal(result.snapshot.lastVerdict.verdict, 'pass');

  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.deepEqual(types, [
    'task_created',
    'task_understood',
    'planning_started',
    'plan_ready',
    'execution_started',
    'verification_started',
    'acceptance_fail',
    'repair_applied',
    'verification_started',
    'acceptance_pass',
  ]);

  const summary = summarizeTaskRun(result);
  assert.match(summary, /Task task_\S+ — PASS/);
  assert.match(summary, /attempts: 2 · repairs: 1 · failures: 1/);
  assert.match(summary, /Acceptance passed/);

  // v0.25: locale-aware summary. Labels follow the caller's locale and match
  // formatTaskStatus's wording; the outcome token, task id and verdict body
  // stay verbatim. Default (no locale) stays English for SDK callers.
  const zhSummary = summarizeTaskRun(result, 'zh_CN.UTF-8');
  assert.match(zhSummary, /任务 task_\S+ — PASS/);
  assert.match(zhSummary, /目标: camera FPS >=30 on device/);
  assert.match(zhSummary, /尝试: 2 · 修复: 1 · 失败: 1/);
  assert.match(zhSummary, /最终裁决:/);
  assert.match(zhSummary, /Acceptance passed/, 'verdict body stays verbatim under zh');
  assert.doesNotMatch(summarizeTaskRun(result), /任务/, 'no locale → English default');
  assert.match(summarizeTaskRun(result, 'en_US.UTF-8'), /^Task task_/, 'explicit en stays English');
  // phases recorded on events never regress
  const phases = (await listTaskEvents(ws, taskId)).map((event) => event.phase);
  assert.equal(phases[phases.length - 1], 'accepted');
});

test('repair budget exhausted ends as failed — no prose can flip it', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'never satisfiable',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    () => {},
    () => {},
  ]);
  const result = await runTask(
    { workspaceDir: ws, runTurn, maxRepairAttempts: 0 },
    'never satisfiable'
  );
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.phase, 'failed');
  assert.equal(result.snapshot.attempt, 1);
  const types = (await listTaskEvents(ws, result.snapshot.taskId)).map((e) => e.type);
  assert.ok(types.includes('task_failed'));
});

test('command verdict provider: exit-code acceptance without criteria (goal-loop unification)', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'make `npm test` pass',
        acceptanceCriteria: [{ metric: 'command', expected: 'exists' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    () => {},
  ]);
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn,
      verdictProvider: createCommandVerdictProvider('true'),
    },
    'make `npm test` pass'
  );
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  assert.equal(result.snapshot.attempt, 1);
  assert.match(result.verdictDetail, /exited 0/);
});

test('turn budget exhausted fails the task instead of looping forever', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'stuck task',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
  ]);
  const result = await runTask({ workspaceDir: ws, runTurn, maxTurns: 1 }, 'stuck task');
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.phase, 'failed');
  const events = await listTaskEvents(ws, result.snapshot.taskId);
  assert.match(events.find((e) => e.type === 'task_failed').data.detail, /turn budget exhausted/);
});

test('resumeTask re-enters execution and can finish a failed task', async () => {
  const ws = await tmpWorkspace();
  let taskId;
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'resume me',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    () => {},
    () => {},
  ]);
  const first = await runTask({ workspaceDir: ws, runTurn, maxRepairAttempts: 0 }, 'resume me');
  assert.equal(first.outcome, 'fail');

  const repairAgent = mockAgent(ws, [
    async (dir) => {
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'device_exec',
        metric: 'x',
        expected: '>=1',
        observed: 2,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
  ]);
  const second = await resumeTask({ workspaceDir: ws, runTurn: repairAgent.runTurn }, taskId);
  assert.equal(second.outcome, 'pass');
  assert.equal(second.snapshot.phase, 'accepted');
  const types = (await listTaskEvents(ws, taskId)).map((e) => e.type);
  assert.ok(types.includes('task_resumed'));
  assert.equal(types[types.length - 1], 'acceptance_pass');
});

test('resumeTask refuses accepted and live tasks', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'done task',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId: tid,
        source: 'test',
        metric: 'x',
        expected: '>=1',
        observed: 5,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
    () => {},
  ]);
  const done = await runTask({ workspaceDir: ws, runTurn }, 'done task');
  await assert.rejects(
    () => resumeTask({ workspaceDir: ws, runTurn }, done.snapshot.taskId),
    /already accepted/
  );
  await assert.rejects(
    () => resumeTask({ workspaceDir: ws, runTurn }, 'task_missing'),
    /not found/
  );
});

test('a crashed run marks the task failed — never stuck unresumable in a live phase', async () => {
  const ws = await tmpWorkspace();
  const crash = async () => {
    throw new Error('gateway exploded mid-turn');
  };
  await assert.rejects(
    () => runTask({ workspaceDir: ws, runTurn: crash }, 'camera FPS >=30 on device'),
    /gateway exploded/
  );

  // The only task in the workspace is the crashed one; it must be failed, not
  // stuck in planning, so the user can /task resume it.
  const { listTaskStateSnapshots } = await import('../dist/core/task/task-store.js');
  const snapshots = await listTaskStateSnapshots(ws);
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.phase, 'failed', 'a crashed run lands in the failed phase');
  const types = (await listTaskEvents(ws, snapshot.taskId)).map((e) => e.type);
  assert.ok(types.includes('task_failed'), 'the crash is recorded as task_failed');

  // resumeTask re-enters the cycle instead of refusing with "nothing to resume".
  await assert.rejects(
    () => resumeTask({ workspaceDir: ws, runTurn: crash }, snapshot.taskId),
    (err) => !/nothing to resume/.test(err.message),
    'a failed-by-crash task is resumable'
  );
});
