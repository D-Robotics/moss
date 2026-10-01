#!/usr/bin/env node
/**
 * Task Runtime (mission control core): state machine derivation over .moss/
 * artifacts + live agent events, task kind classification, current-action
 * phrasing, repair cycles, and the canvas projection. Pure dist imports —
 * no ink.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TaskRuntime,
  classifyTaskKind,
  describeToolCall,
  formatDeploymentLine,
} from '../dist/core/task-runtime/runtime.js';
import {
  appendTaskRecord,
  appendEvidenceRecord,
  appendAcceptanceVerdict,
} from '../dist/core/task-runtime/artifacts.js';
import { createDraftTask, appendTaskEvent } from '../dist/core/task/task-store.js';

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-runtime-'));
  return dir;
}

function task(overrides = {}) {
  return {
    taskId: 'task_a',
    goal: 'stream camera at 30 fps on the robot',
    acceptanceCriteria: [
      { metric: 'camera_fps', expected: '>=30' },
      { metric: 'cpu_percent', expected: '<=80', required: false },
    ],
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('classifyTaskKind: camera / ros / model / navigation / general', () => {
  assert.equal(classifyTaskKind('stream camera at 30fps', ['camera_fps']), 'camera');
  assert.equal(classifyTaskKind('bring up ros2 nodes', ['topic_hz:/cmd_vel']), 'ros');
  assert.equal(classifyTaskKind('quantize yolo and measure latency', ['latency_ms']), 'model');
  assert.equal(classifyTaskKind('drive to waypoint with slam', ['position_error_m']), 'navigation');
  assert.equal(classifyTaskKind('refactor the build script', ['build_ok']), 'general');
});

test('describeToolCall: human phrasing, no raw tool noise', () => {
  assert.match(describeToolCall('task_define', { goal: 'make camera work' }), /^defining task/);
  assert.match(describeToolCall('device_exec', { command: 'fps_probe.sh' }), /^device ▸ fps_probe/);
  assert.match(
    describeToolCall('device_deploy', { artifact_path: 'bin/app' }),
    /^deploying bin\/app/
  );
  assert.match(
    describeToolCall('record_evidence', { metric: 'camera_fps' }),
    /^verifying: camera_fps/
  );
  assert.equal(describeToolCall('some_future_tool', {}), 'some future tool');
});

test('mission state derivation: PASS / FAIL / IDLE from artifacts', async () => {
  const dir = await tempWorkspace();
  await appendTaskRecord(dir, task({ taskId: 'task_pass', status: 'accepted' }));
  await appendAcceptanceVerdict(dir, {
    taskId: 'task_pass',
    verdict: 'pass',
    acceptedAt: 1100,
    criteriaResults: [],
    unmetRequired: 0,
    evidenceConsidered: 1,
  });
  await appendTaskRecord(dir, task({ taskId: 'task_fail', updatedAt: 1200 }));
  await appendAcceptanceVerdict(dir, {
    taskId: 'task_fail',
    verdict: 'fail',
    acceptedAt: 1200,
    criteriaResults: [
      { metric: 'camera_fps', expected: '>=30', required: true, result: 'no-evidence' },
    ],
    unmetRequired: 1,
    evidenceConsidered: 0,
  });
  await appendTaskRecord(dir, task({ taskId: 'task_idle', updatedAt: 900 }));

  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 5000 });
  await runtime.refresh();

  const byId = new Map(runtime.taskSummaries().map((s) => [s.taskId, s]));
  assert.equal(byId.get('task_pass').state, 'COMPLETED');
  assert.equal(byId.get('task_pass').result, 'PASS');
  assert.equal(byId.get('task_fail').state, 'BLOCKED');
  assert.equal(byId.get('task_fail').result, 'FAIL');
  assert.equal(byId.get('task_idle').state, 'IDLE');
  assert.equal(byId.get('task_idle').result, undefined);
  assert.equal(byId.get('task_pass').kind, 'camera');
});

test('Task OS events drive the TUI projection: failed/blocked never render as IDLE', async () => {
  const dir = await tempWorkspace();
  const failed = await createDraftTask(dir, 'deploy the vision model to the RDK board');
  await appendTaskEvent(dir, failed.taskId, 'plan_ready');
  await appendTaskEvent(dir, failed.taskId, 'task_failed');

  const blocked = await createDraftTask(dir, 'stream camera at 30 fps');
  await appendTaskEvent(dir, blocked.taskId, 'execution_started');
  await appendTaskEvent(dir, blocked.taskId, 'blocked_on_user', {
    reason: 'device credentials missing',
  });

  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 5000 });
  await runtime.refresh();

  const byId = new Map(runtime.taskSummaries().map((s) => [s.taskId, s]));
  assert.equal(byId.get(failed.taskId).state, 'COMPLETED', 'a Task OS failed task is terminal');
  assert.equal(byId.get(failed.taskId).result, 'FAIL');
  assert.equal(
    byId.get(blocked.taskId).state,
    'BLOCKED',
    'a blocked task never falls back to IDLE'
  );
  assert.equal(byId.get(blocked.taskId).result, 'NEEDS USER');
});

test('live run: PLANNING → EXECUTING → approval BLOCKED → endRun', async () => {
  const dir = await tempWorkspace();
  await appendTaskRecord(dir, task());
  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 2000 });
  await runtime.refresh();

  runtime.beginRun();
  let detail = runtime.taskDetail('task_a');
  assert.equal(detail.summary.state, 'PLANNING');
  assert.equal(detail.currentAction, 'reasoning about the goal');

  runtime.applyEvent({
    type: 'tool_start',
    toolName: 'device_exec',
    toolCallId: 'c1',
    input: { command: 'v4l2-ctl --list-devices' },
  });
  detail = runtime.taskDetail('task_a');
  assert.equal(detail.summary.state, 'EXECUTING');
  assert.match(detail.currentAction, /device ▸ v4l2-ctl/);

  runtime.setApprovalPending(true);
  detail = runtime.taskDetail('task_a');
  assert.equal(detail.summary.state, 'BLOCKED');
  assert.equal(detail.summary.result, 'NEEDS USER');

  runtime.setApprovalPending(false);
  runtime.applyEvent({
    type: 'tool_end',
    toolName: 'device_exec',
    toolCallId: 'c1',
    result: 'camera found',
    isError: false,
  });
  assert.equal(runtime.getLiveState().currentAction, undefined);
  assert.equal(runtime.taskDetail('task_a').device.observations.length, 1);

  await runtime.endRun(false);
  assert.equal(runtime.taskDetail('task_a').summary.state, 'IDLE');
});

test('halted run → BLOCKED / NEEDS USER on the focus task', async () => {
  const dir = await tempWorkspace();
  await appendTaskRecord(dir, task());
  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 3000 });
  await runtime.refresh();
  runtime.beginRun();
  runtime.applyEvent({
    type: 'tool_start',
    toolName: 'task_define',
    toolCallId: 'c1',
    input: { goal: 'stream camera' },
  });
  runtime.applyEvent({ type: 'error', error: 'provider connection lost', retriable: false });
  await runtime.endRun(true);
  const summary = runtime.taskSummaries().find((s) => s.taskId === 'task_a');
  assert.equal(summary.state, 'BLOCKED');
  assert.equal(summary.result, 'NEEDS USER');
});

test('tool_end of task tools triggers an async artifact refresh', async () => {
  const dir = await tempWorkspace();
  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 4000 });
  await runtime.refresh();
  assert.equal(runtime.taskSummaries().length, 0);

  const versionBefore = runtime.version;
  runtime.beginRun();
  runtime.applyEvent({
    type: 'tool_end',
    toolName: 'task_define',
    toolCallId: 'c1',
    result: 'Task contract task_new: …',
    isError: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(runtime.version > versionBefore);
});

test('taskDetail: canvas model — progress, failure, repair, history, device', async () => {
  const dir = await tempWorkspace();
  await appendTaskRecord(
    dir,
    task({
      goal: 'deploy the camera pipeline and verify fps',
      constraints: ['RDK X3', 'TROS humble'],
      verificationPlan: ['deploy fps probe', 'measure camera_fps', 'run task_acceptance'],
      targetDeviceId: 'rdk-x3',
    })
  );
  // fail verdict at t=1500, repair evidence at t=1600, pass verdict at t=1700
  await appendAcceptanceVerdict(dir, {
    taskId: 'task_a',
    verdict: 'fail',
    acceptedAt: 1500,
    criteriaResults: [
      { metric: 'camera_fps', expected: '>=30', required: true, result: 'fail', observed: 12 },
    ],
    unmetRequired: 1,
    evidenceConsidered: 1,
  });
  await appendEvidenceRecord(dir, {
    evidenceId: 'ev_1',
    taskId: 'task_a',
    deviceId: 'rdk-x3',
    source: 'device_exec',
    metric: 'camera_fps',
    expected: '>=30',
    observed: 31.5,
    result: 'pass',
    timestamp: 1600,
  });
  await appendAcceptanceVerdict(dir, {
    taskId: 'task_a',
    verdict: 'pass',
    acceptedAt: 1700,
    criteriaResults: [
      {
        metric: 'camera_fps',
        expected: '>=30',
        required: true,
        result: 'pass',
        observed: 31.5,
      },
    ],
    unmetRequired: 0,
    evidenceConsidered: 1,
  });

  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 5000 });
  await runtime.refresh();
  const detail = runtime.taskDetail('task_a');

  assert.equal(detail.goal, 'deploy the camera pipeline and verify fps');
  assert.deepEqual(detail.plan, ['deploy fps probe', 'measure camera_fps', 'run task_acceptance']);
  assert.equal(detail.progress.length, 2);
  assert.equal(detail.progress[0].result, 'pass');
  assert.ok(detail.failure, 'failure items survive even after later pass (history matters)');
  assert.equal(detail.repair.length, 1);
  assert.equal(detail.repair[0].reMeasurements, 1);
  assert.equal(detail.repair[0].resolvedTo, 'pass');
  assert.equal(detail.acceptance.verdict, 'pass');
  assert.equal(detail.verification[0].evidenceId, 'ev_1');
  assert.ok(detail.history.length >= 4);
  assert.equal(detail.device.deviceId, 'rdk-x3');
});

test('empty workspace: no tasks, detail undefined', async () => {
  const dir = await tempWorkspace();
  const runtime = new TaskRuntime({ workspaceDir: dir });
  await runtime.refresh();
  assert.deepEqual(runtime.taskSummaries(), []);
  assert.equal(runtime.taskDetail(), undefined);
});

// ─── A4: one deployment, one honest line ─────────────────────────────────────

test('formatDeploymentLine names the stage the record proves', () => {
  const base = {
    deploymentId: 'dep_1',
    deviceId: 'rdk-x5',
    artifactPath: 'app.py',
    remotePath: '/userdata/app.py',
    startedAt: 1,
    steps: [],
  };
  assert.match(
    formatDeploymentLine({ ...base, status: 'uploaded' }),
    /UPLOADED.*— upload ok · not started/,
    'uploaded ≠ running: the line says it was not started'
  );
  assert.match(
    formatDeploymentLine({
      ...base,
      status: 'running',
      healthCheck: { command: 'pgrep app', passed: true, checkedAt: 2, exitCode: 0 },
    }),
    /RUNNING.*— health PASS \(exit 0\)/,
    'running carries the health-check verdict'
  );
  assert.match(
    formatDeploymentLine({
      ...base,
      status: 'running',
      healthCheck: { command: 'pgrep app', passed: false, checkedAt: 2, exitCode: 1 },
    }),
    /health FAIL/,
    'a failed health check never reads as healthy'
  );
  assert.match(
    formatDeploymentLine({ ...base, status: 'running' }),
    /no health check recorded/,
    'running without a health check says so'
  );
  assert.match(
    formatDeploymentLine({ ...base, status: 'failed', error: 'scp: permission denied' }),
    /FAILED.*— scp: permission denied/,
    'failed carries the error'
  );
  assert.match(
    formatDeploymentLine({ ...base, status: 'uploaded', taskId: 'task_muprgfsp_yhky1z' }),
    /· task yhky1z$/,
    'a tagged deployment names its task'
  );
});

// ─── A3: a task never inherits another task's deployments ───────────────────

test("taskDetail attaches deployments only from the task's own device evidence", async () => {
  const dir = await tempWorkspace();
  const { appendDeploymentRecord } = await import('../dist/device/deployment.js');
  await appendDeploymentRecord(dir, {
    deploymentId: 'dep_other',
    deviceId: 'rdk-x5',
    artifactPath: 'other.py',
    remotePath: '/userdata/other.py',
    status: 'running',
    startedAt: Date.now(),
    steps: [],
  });
  await appendTaskRecord(dir, task({ taskId: 'task_nodev', updatedAt: 1000 }));
  await appendTaskRecord(
    dir,
    task({ taskId: 'task_own', updatedAt: 1100, targetDeviceId: 'rdk-x5' })
  );

  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 5000 });
  await runtime.refresh();

  const noDev = runtime.taskDetail('task_nodev');
  assert.equal(noDev?.device, undefined, 'a task with no device evidence shows no device section');
  const own = runtime.taskDetail('task_own');
  assert.ok(own?.device, 'the task that names the device gets its deployments');
  assert.equal(own.device.deployments.length, 1);
  assert.equal(own.device.deployments[0].deploymentId, 'dep_other');
});

test('a tagged deployment belongs to exactly its task, same device or not', async () => {
  const dir = await tempWorkspace();
  const { appendDeploymentRecord } = await import('../dist/device/deployment.js');
  await appendTaskRecord(
    dir,
    task({ taskId: 'task_a', updatedAt: 1000, targetDeviceId: 'rdk-x5' })
  );
  await appendTaskRecord(
    dir,
    task({ taskId: 'task_b', updatedAt: 1100, targetDeviceId: 'rdk-x5' })
  );
  // Same device, but tagged to task_b — task_a must not claim it.
  await appendDeploymentRecord(dir, {
    deploymentId: 'dep_tagged_b',
    deviceId: 'rdk-x5',
    artifactPath: 'b.py',
    remotePath: '/userdata/b.py',
    status: 'running',
    startedAt: Date.now(),
    steps: [],
    taskId: 'task_b',
  });
  // Tagged to task_a — attaches even though it is on another device.
  await appendDeploymentRecord(dir, {
    deploymentId: 'dep_tagged_a',
    deviceId: 'rdk-x3',
    artifactPath: 'a.py',
    remotePath: '/userdata/a.py',
    status: 'uploaded',
    startedAt: Date.now(),
    steps: [],
    taskId: 'task_a',
  });

  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 5000 });
  await runtime.refresh();

  const a = runtime.taskDetail('task_a');
  assert.equal(a.device.deployments.length, 1, 'task_a sees only its tagged deployment');
  assert.equal(a.device.deployments[0].deploymentId, 'dep_tagged_a');
  const b = runtime.taskDetail('task_b');
  assert.equal(b.device.deployments.length, 1, 'task_b sees only its tagged deployment');
  assert.equal(b.device.deployments[0].deploymentId, 'dep_tagged_b');
});

// ─── A5: blocked reason reaches the summary ──────────────────────────────────

test('a blocked task carries its blockedReason into taskSummaries', async () => {
  const dir = await tempWorkspace();
  const contract = await createDraftTask(dir, 'stream camera at 30 fps');
  await appendTaskEvent(dir, contract.taskId, 'execution_started');
  await appendTaskEvent(dir, contract.taskId, 'blocked_on_user', {
    reason: 'device credentials missing',
  });

  const runtime = new TaskRuntime({ workspaceDir: dir, now: () => 5000 });
  await runtime.refresh();
  const summary = runtime.taskSummaries().find((s) => s.taskId === contract.taskId);
  assert.equal(summary?.state, 'BLOCKED');
  assert.equal(summary?.blockedReason, 'device credentials missing');
});
