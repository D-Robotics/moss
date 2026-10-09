#!/usr/bin/env node
/**
 * Task store (Task OS M2): event-sourced lifecycle state — draft creation,
 * machine-validated transitions (invalid events throw), snapshot assembly
 * (plan/blocked/attempt/counters), failure+repair records, timeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MossError } from '../dist/errors.js';
import { getRootLogger, setRootLogSink } from '../dist/logger.js';
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

function appendInChild(workspace, taskId, type) {
  const storeUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist/core/task/task-store.js')
  ).href;
  const script = `
    import { appendTaskEvent } from ${JSON.stringify(storeUrl)};
    try {
      await appendTaskEvent(${JSON.stringify(workspace)}, ${JSON.stringify(taskId)}, ${JSON.stringify(type)});
      process.stdout.write('ok\\n');
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      process.stdout.write('err ' + code + '\\n');
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child ${type} exited ${code}: ${err || out}`));
        return;
      }
      resolve(out.trim());
    });
  });
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

  // terminal: nothing further applies, including a bare verification reopen
  await assert.rejects(
    () => appendTaskEvent(ws, taskId, 'execution_started'),
    (err) => err instanceof MossError && err.code === 'EXECUTION_STATE_INVALID'
  );
  await assert.rejects(
    () => appendTaskEvent(ws, taskId, 'verification_started'),
    (err) => err instanceof MossError && err.code === 'EXECUTION_STATE_INVALID'
  );
  await appendTaskEvent(ws, taskId, 'verification_started', { reason: '/task verify' });
  snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'verifying');
});

test('replay skips an illegal event so status still loads', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  const bad = {
    eventId: 'evt_bad',
    taskId,
    type: 'acceptance_pass',
    timestamp: Date.now(),
    phase: 'accepted',
  };
  await fs.appendFile(
    path.join(ws, '.moss', 'task-events.jsonl'),
    `${JSON.stringify(bad)}\n`,
    'utf8'
  );
  const seen = [];
  getRootLogger().setLevel('debug');
  setRootLogSink((entry) => {
    if (entry.msg === 'skipping illegal task event during replay') seen.push(entry);
  });
  try {
    const snapshot = await getTaskStateSnapshot(ws, taskId);
    assert.equal(snapshot.phase, 'executing');
    await getTaskStateSnapshot(ws, taskId);
    const warns = seen.filter((entry) => entry.level === 'warn');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].data.eventId, 'evt_bad');
    assert.ok(seen.some((entry) => entry.level === 'debug'));
    await appendTaskEvent(ws, taskId, 'verification_started');
    const after = await getTaskStateSnapshot(ws, taskId);
    assert.equal(after.phase, 'verifying');
    assert.equal(after.attempt, 1);
    await fs.appendFile(
      path.join(ws, '.moss', 'task-events.jsonl'),
      `${JSON.stringify({
        eventId: 'evt_extra',
        taskId,
        type: 'verification_started',
        timestamp: Date.now(),
        phase: 'verifying',
      })}\n`,
      'utf8'
    );
    const counted = await getTaskStateSnapshot(ws, taskId);
    assert.equal(counted.phase, 'verifying');
    assert.equal(counted.attempt, 1);
    const timeline = formatTaskTimeline(buildTaskTimeline(await listTaskEvents(ws, taskId)));
    assert.equal(
      timeline.split('\n').filter((line) => line.includes('Verification started')).length,
      1
    );
    assert.equal(seen.filter((entry) => entry.level === 'warn').length, 2);
  } finally {
    setRootLogSink(null);
    getRootLogger().setLevel('info');
  }
});

test('concurrent task event writes do not record an illegal transition', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  const warnings = [];
  setRootLogSink((entry) => {
    if (entry.level === 'warn' && entry.msg === 'skipping illegal task event during replay') {
      warnings.push(entry);
    }
  });
  try {
    await Promise.allSettled([
      appendTaskEvent(ws, taskId, 'verification_started'),
      appendTaskEvent(ws, taskId, 'blocked_on_user', { reason: 'wait' }),
    ]);
    const snapshot = await getTaskStateSnapshot(ws, taskId);
    assert.ok(snapshot.phase === 'verifying' || snapshot.phase === 'blocked');
    assert.equal(warnings.length, 0);
  } finally {
    setRootLogSink(null);
  }
});

test('a trailing half line does not hide an accepted task or glue the next write', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_pass');
  const eventsFile = path.join(ws, '.moss', 'task-events.jsonl');
  const tasksFile = path.join(ws, '.moss', 'tasks.jsonl');
  await fs.appendFile(eventsFile, '{"eventId":"torn"', 'utf8');
  await fs.appendFile(tasksFile, '{"taskId":"torn"', 'utf8');
  const seen = [];
  getRootLogger().setLevel('debug');
  setRootLogSink((entry) => {
    if (entry.msg === 'skipping unparseable jsonl line') seen.push(entry);
  });
  try {
    const snapshot = await getTaskStateSnapshot(ws, taskId);
    assert.equal(snapshot.phase, 'accepted');
    await getTaskStateSnapshot(ws, taskId);
    const warns = seen.filter((entry) => entry.level === 'warn');
    assert.equal(warns.length, 2);
    assert.ok(seen.filter((entry) => entry.level === 'debug').length >= 2);
    await assert.rejects(
      () => appendTaskEvent(ws, taskId, 'execution_started'),
      (err) => err instanceof MossError && err.code === 'EXECUTION_STATE_INVALID'
    );
    await appendTaskEvent(ws, taskId, 'verification_started', { reason: '/task verify' });
    const raw = await fs.readFile(eventsFile, 'utf8');
    assert.match(raw, /\{"eventId":"torn"\n/);
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    const parsed = lines.filter((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(parsed.length >= 4);
    const after = await getTaskStateSnapshot(ws, taskId);
    assert.equal(after.phase, 'verifying');
    assert.equal(seen.filter((entry) => entry.level === 'warn').length, 2);
  } finally {
    setRootLogSink(null);
    getRootLogger().setLevel('info');
  }
});

test('a read-only .moss directory throws instead of spinning on the lock', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  const moss = path.join(ws, '.moss');
  await fs.chmod(moss, 0o555);
  const started = Date.now();
  try {
    await assert.rejects(
      () => appendTaskEvent(ws, taskId, 'execution_started'),
      (err) => {
        assert.equal(err.code, 'EACCES');
        return true;
      }
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `read-only .moss took ${elapsed}ms`);
  } finally {
    await fs.chmod(moss, 0o755);
  }
});

test('a symlinked workspace does not delete the live task event lock', async () => {
  const ws = await tmpWorkspace();
  const link = `${ws}-link`;
  await fs.symlink(ws, link);
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  const warnings = [];
  setRootLogSink((entry) => {
    if (entry.level === 'warn' && entry.msg === 'skipping illegal task event during replay') {
      warnings.push(entry);
    }
  });
  try {
    const started = Date.now();
    const [left, right] = await Promise.allSettled([
      appendTaskEvent(ws, taskId, 'task_failed'),
      appendTaskEvent(link, taskId, 'task_abandoned'),
    ]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `symlink lock race took ${elapsed}ms`);
    const outcomes = [left, right].map((result) =>
      result.status === 'fulfilled' ? 'ok' : result.reason?.code
    );
    assert.deepEqual(outcomes.sort(), ['EXECUTION_STATE_INVALID', 'ok']);
    const snapshot = await getTaskStateSnapshot(ws, taskId);
    assert.ok(snapshot.phase === 'failed' || snapshot.phase === 'abandoned');
    assert.equal(warnings.length, 0);
    const raw = await fs.readFile(path.join(ws, '.moss', 'task-events.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trim() !== '') JSON.parse(line);
    }
  } finally {
    setRootLogSink(null);
    await fs.unlink(link).catch(() => undefined);
  }
});

test('a lock file stamped with this process pid is reclaimed without waiting', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await fs.writeFile(path.join(ws, '.moss', 'task-events.jsonl.lock'), String(process.pid), 'utf8');
  const started = Date.now();
  await appendTaskEvent(ws, taskId, 'execution_started');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `own-pid lock took ${elapsed}ms`);
  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'executing');
});

test('two processes serialize task event writes', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  const warnings = [];
  setRootLogSink((entry) => {
    if (entry.level === 'warn' && entry.msg === 'skipping illegal task event during replay') {
      warnings.push(entry);
    }
  });
  try {
    const [left, right] = await Promise.all([
      appendInChild(ws, taskId, 'task_failed'),
      appendInChild(ws, taskId, 'task_abandoned'),
    ]);
    assert.deepEqual([left, right].sort(), ['err EXECUTION_STATE_INVALID', 'ok']);
    const snapshot = await getTaskStateSnapshot(ws, taskId);
    assert.ok(snapshot.phase === 'failed' || snapshot.phase === 'abandoned');
    assert.equal(warnings.length, 0);
    const raw = await fs.readFile(path.join(ws, '.moss', 'task-events.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trim() !== '') JSON.parse(line);
    }
  } finally {
    setRootLogSink(null);
  }
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
