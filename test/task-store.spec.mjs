#!/usr/bin/env node
/**
 * Task store (Task OS M2): event-sourced lifecycle state — draft creation,
 * machine-validated transitions (invalid events throw), snapshot assembly
 * (plan/blocked/attempt/counters), failure+repair records, timeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossError } from '../dist/errors.js';
import {
  createDraftTask,
  appendTaskEvent,
  listTaskEvents,
  getTaskStateSnapshot,
  listTaskStateSnapshots,
  recordFailure,
  listFailures,
  recordRepair,
  listRepairs,
  buildTaskTimeline,
  formatTaskTimeline,
} from '../dist/core/task/task-store.js';
import {
  appendEvidenceRecord,
  appendAcceptanceVerdict,
} from '../dist/core/task-runtime/artifacts.js';

async function tmpWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-store-'));
  return dir;
}

test('createDraftTask writes contract + task_created; snapshot starts at draft/idle', async () => {
  const ws = await tmpWorkspace();
  const contract = await createDraftTask(ws, 'optimize camera FPS to >=30');
  assert.match(contract.taskId, /^task_/);
  assert.equal(contract.status, 'draft');
  assert.equal(contract.acceptanceCriteria.length, 0);

  const snapshot = await getTaskStateSnapshot(ws, contract.taskId);
  assert.equal(snapshot.phase, 'draft');
  assert.equal(snapshot.statusView, 'idle');
  assert.equal(snapshot.attempt, 0);
  assert.equal(snapshot.outcome, undefined);
  const events = await listTaskEvents(ws, contract.taskId);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'task_created');
  assert.equal(events[0].phase, 'draft');
});

test('appendTaskEvent moves the phase through the machine; invalid transitions throw', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');

  await appendTaskEvent(ws, taskId, 'task_understood');
  await appendTaskEvent(ws, taskId, 'planning_started');
  await appendTaskEvent(ws, taskId, 'plan_ready', {
    steps: [
      { stepId: 's1', title: 'Inspect pipeline', status: 'pending' },
      { stepId: 's2', title: 'Tune config', status: 'pending' },
    ],
  });
  await appendTaskEvent(ws, taskId, 'execution_started');

  let snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'executing');
  assert.equal(snapshot.plan.length, 2);
  assert.equal(snapshot.plan[0].title, 'Inspect pipeline');

  // acceptance cannot be granted while executing — the guard that matters
  await assert.rejects(
    () => appendTaskEvent(ws, taskId, 'acceptance_pass'),
    (err) => err instanceof MossError && err.code === 'EXECUTION_STATE_INVALID'
  );

  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_fail', { detail: 'camera_fps observed 17.2' });
  snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'diagnosing');
  assert.equal(snapshot.attempt, 1);

  await appendTaskEvent(ws, taskId, 'repair_applied', { detail: 'buffers 3->6' });
  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_pass');
  snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'accepted');
  assert.equal(snapshot.statusView, 'completed');
  assert.equal(snapshot.outcome, 'pass');
  assert.equal(snapshot.attempt, 2);

  // terminal: nothing further applies
  await assert.rejects(
    () => appendTaskEvent(ws, taskId, 'execution_started'),
    (err) => err instanceof MossError && err.code === 'EXECUTION_STATE_INVALID'
  );
});

test('blocked_on_user records reason; unblocked resumes to a chosen phase', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskEvent(ws, taskId, 'blocked_on_user', {
    reason: 'physical action authorization: restart perception service',
  });

  let snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'blocked');
  assert.equal(snapshot.statusView, 'blocked');
  assert.equal(snapshot.outcome, 'needs-user');
  assert.match(snapshot.blockedReason, /perception service/);

  await appendTaskEvent(ws, taskId, 'unblocked', { resumePhase: 'planning' });
  snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'planning');
  assert.equal(snapshot.blockedReason, undefined);
});

test('failures and repairs persist; failure updates are latest-wins', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  const failure = await recordFailure(ws, {
    taskId,
    stage: 'verifying',
    symptom: 'camera_fps expected >=30, observed 17.2',
    attempt: 1,
    resolved: false,
  });
  const repair = await recordRepair(ws, {
    taskId,
    failureId: failure.failureId,
    action: 'increase pipeline buffers',
    changedFiles: ['config.yaml'],
    redeployed: true,
  });
  // diagnosis arrives later: same failure re-recorded resolved with root cause
  await recordFailure(ws, {
    failureId: failure.failureId,
    taskId,
    stage: 'verifying',
    symptom: 'camera_fps expected >=30, observed 17.2',
    diagnosis: 'frame drops under load',
    rootCause: 'buffer count too low',
    attempt: 1,
    resolved: true,
  });

  const failures = await listFailures(ws, taskId);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].rootCause, 'buffer count too low');
  assert.equal(failures[0].resolved, true);
  const repairs = await listRepairs(ws, taskId);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].repairId, repair.repairId);
  assert.equal(repairs[0].failureId, failure.failureId);

  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.failures.length, 1);
  assert.equal(snapshot.repairs.length, 1);
});

test('snapshot counts evidence and surfaces the latest verdict', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendEvidenceRecord(ws, {
    evidenceId: 'ev_1',
    taskId,
    source: 'device_exec',
    metric: 'camera_fps',
    expected: '>=30',
    observed: 31.4,
    result: 'pass',
    timestamp: 1,
  });
  await appendAcceptanceVerdict(ws, {
    taskId,
    verdict: 'pass',
    acceptedAt: 2,
    criteriaResults: [],
    unmetRequired: 0,
    evidenceConsidered: 1,
  });

  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.evidenceCount, 1);
  assert.equal(snapshot.lastVerdict.verdict, 'pass');
  const all = await listTaskStateSnapshots(ws);
  assert.equal(all.length, 1);
});

test('timeline renders human-readable entries in order', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_fail', { detail: 'fps 17.2' });

  const events = await listTaskEvents(ws, taskId);
  const text = formatTaskTimeline(buildTaskTimeline(events));
  const lines = text.split('\n');
  assert.match(lines[0], /Task created — goal/);
  assert.match(lines[1], /Execution started/);
  assert.match(lines[3], /Acceptance failed — fps 17\.2/);
});
