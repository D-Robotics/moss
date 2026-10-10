#!/usr/bin/env node
/**
 * P2-2: /task verify runs the verdict provider once. The timeline event is
 * `acceptance_fail` (the state machine's name; the plan text said
 * `acceptance_failed`). PASS is that event, not model prose.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyTaskOnce } from '../dist/cli/commands/task-verify.js';
import { formatTaskStatus } from '../dist/cli/task-run.js';
import { appendTaskRecord, listTaskRecords } from '../dist/core/task-runtime/artifacts.js';
import {
  appendTaskEvent,
  createDraftTask,
  getTaskStateSnapshot,
  listAcceptanceVerdicts,
  listTaskEvents,
} from '../dist/core/task/task-store.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-'));
const contract = await createDraftTask(workspace, 'the check passes', {
  acceptanceCommand: 'false',
});

const failed = await verifyTaskOnce(workspace, { taskId: contract.taskId });
assert.equal(failed.exitCode, 1, 'a failing acceptance command exits 1');
assert.match(failed.summary, /FAIL from the command verdict/);
assert.match(failed.summary, /\/goal/);
const afterFail = await listTaskEvents(workspace, contract.taskId);
assert.ok(
  afterFail.some((event) => event.type === 'acceptance_fail'),
  'timeline records acceptance_fail from the verdict'
);
assert.equal((await getTaskStateSnapshot(workspace, contract.taskId)).phase, 'diagnosing');

const passed = await verifyTaskOnce(workspace, { taskId: contract.taskId, command: 'true' });
assert.equal(passed.exitCode, 0, 'a passing command accepts the task');
assert.match(passed.summary, /PASS from the command verdict/);
const afterPass = await listTaskEvents(workspace, contract.taskId);
assert.ok(afterPass.some((event) => event.type === 'acceptance_pass'));
assert.equal((await getTaskStateSnapshot(workspace, contract.taskId)).phase, 'accepted');

const again = await verifyTaskOnce(workspace, { taskId: contract.taskId, command: 'true' });
assert.equal(again.exitCode, 0);
assert.match(again.summary, /re-verified/);
assert.doesNotMatch(again.summary, /already accepted/);
const reEvents = await listTaskEvents(workspace, contract.taskId);
assert.ok(
  reEvents.filter((event) => event.type === 'acceptance_pass').length >= 2,
  'a second verify appends a fresh acceptance_pass'
);
assert.equal((await getTaskStateSnapshot(workspace, contract.taskId)).phase, 'accepted');

const priorPass = reEvents.filter((event) => event.type === 'acceptance_pass').length;
const records = await listTaskRecords(workspace);
const current = records.find((task) => task.taskId === contract.taskId);
assert.ok(current, 'the draft contract is still on disk');
await appendTaskRecord(workspace, { ...current, status: 'accepted', updatedAt: Date.now() });
const regressed = await verifyTaskOnce(workspace, { taskId: contract.taskId, command: 'false' });
assert.equal(regressed.exitCode, 1);
assert.match(regressed.summary, /Regression/);
assert.match(regressed.summary, /previous acceptance stays in the timeline/);
assert.equal((await getTaskStateSnapshot(workspace, contract.taskId)).phase, 'diagnosing');
const afterRegression = await listTaskEvents(workspace, contract.taskId);
assert.equal(
  afterRegression.filter((event) => event.type === 'acceptance_pass').length,
  priorPass,
  'a failing re-verify does not delete the earlier PASS'
);
assert.ok(afterRegression.some((event) => event.type === 'acceptance_fail'));
assert.ok(
  afterRegression.some((event) => event.type === 'note' && event.data?.kind === 'regression'),
  'regression is an appended note'
);
const latest = (await listTaskRecords(workspace)).find((task) => task.taskId === contract.taskId);
assert.equal(latest?.status, 'active', 'an accepted contract is reopened, not rewritten in place');

{
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-bare-'));
  const bare = await createDraftTask(bareDir, 'nothing to check');
  const before = (await listTaskEvents(bareDir, bare.taskId)).map((event) => event.type);
  const denied = await verifyTaskOnce(bareDir, { taskId: bare.taskId });
  assert.equal(denied.exitCode, 2, 'no command and no criteria is a usage error');
  assert.match(denied.summary, /no acceptance command/);
  assert.match(denied.summary, /no acceptance criteria/);
  const after = (await listTaskEvents(bareDir, bare.taskId)).map((event) => event.type);
  assert.deepEqual(after, before, 'a verify that cannot run writes no lifecycle events');
  assert.equal(
    fs.existsSync(path.join(bareDir, '.moss', 'acceptance.jsonl')),
    false,
    'a verify that cannot run writes no acceptance verdict'
  );
}

{
  const criteriaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-criteria-'));
  const drafted = await createDraftTask(criteriaDir, 'the metric is recorded');
  await appendTaskRecord(criteriaDir, {
    ...drafted,
    acceptanceCriteria: [{ metric: 'ready', expected: '==true', required: true }],
    updatedAt: Date.now(),
  });
  const judged = await verifyTaskOnce(criteriaDir, { taskId: drafted.taskId });
  assert.equal(judged.exitCode, 1, 'criteria without evidence fail the contract verdict');
  assert.match(judged.summary, /contract verdict/);
  const types = (await listTaskEvents(criteriaDir, drafted.taskId)).map((event) => event.type);
  assert.ok(types.includes('execution_started'), 'a real verdict opens execution first');
  assert.ok(types.includes('acceptance_fail'));
}

{
  const failedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-failed-'));
  const failedTask = await createDraftTask(failedDir, 'bring it back', {
    acceptanceCommand: 'true',
  });
  await appendTaskEvent(failedDir, failedTask.taskId, 'execution_started');
  await appendTaskEvent(failedDir, failedTask.taskId, 'task_failed', { reason: 'budget' });
  assert.equal((await getTaskStateSnapshot(failedDir, failedTask.taskId)).phase, 'failed');
  const recovered = await verifyTaskOnce(failedDir, { taskId: failedTask.taskId });
  assert.equal(recovered.exitCode, 0, recovered.summary);
  const recoveredTypes = (await listTaskEvents(failedDir, failedTask.taskId)).map(
    (event) => event.type
  );
  assert.ok(recoveredTypes.includes('task_resumed'), 'failed tasks reopen through task_resumed');
  assert.equal(
    recoveredTypes.filter((type) => type === 'execution_started').length,
    1,
    'resume does not emit a second execution_started'
  );
  assert.ok(recoveredTypes.indexOf('task_resumed') < recoveredTypes.indexOf('acceptance_pass'));
  assert.equal((await getTaskStateSnapshot(failedDir, failedTask.taskId)).phase, 'accepted');

  const abandonedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-abandoned-'));
  const abandoned = await createDraftTask(abandonedDir, 'left behind', {
    acceptanceCommand: 'true',
  });
  await appendTaskEvent(abandonedDir, abandoned.taskId, 'task_abandoned');
  assert.equal((await getTaskStateSnapshot(abandonedDir, abandoned.taskId)).phase, 'abandoned');
  const revived = await verifyTaskOnce(abandonedDir, { taskId: abandoned.taskId });
  assert.equal(revived.exitCode, 0, revived.summary);
  const revivedTypes = (await listTaskEvents(abandonedDir, abandoned.taskId)).map(
    (event) => event.type
  );
  assert.ok(revivedTypes.includes('task_resumed'));
  assert.ok(revivedTypes.includes('acceptance_pass'));
  assert.equal((await getTaskStateSnapshot(abandonedDir, abandoned.taskId)).phase, 'accepted');
}

{
  const throwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-throw-'));
  const accepted = await createDraftTask(throwDir, 'stay accepted', {
    acceptanceCommand: 'true',
  });
  const passed = await verifyTaskOnce(throwDir, { taskId: accepted.taskId, command: 'true' });
  assert.equal(passed.exitCode, 0);
  assert.equal((await getTaskStateSnapshot(throwDir, accepted.taskId)).phase, 'accepted');
  const before = (await listTaskEvents(throwDir, accepted.taskId)).map((event) => event.type);
  await assert.rejects(
    () =>
      verifyTaskOnce(throwDir, {
        taskId: accepted.taskId,
        verdictProvider: {
          async evaluate() {
            throw new Error('acceptance command exploded');
          },
        },
      }),
    /acceptance command exploded/
  );
  assert.equal(
    (await getTaskStateSnapshot(throwDir, accepted.taskId)).phase,
    'accepted',
    'a throwing evaluate must not leave the task in verifying'
  );
  assert.deepEqual(
    (await listTaskEvents(throwDir, accepted.taskId)).map((event) => event.type),
    before,
    'a throwing evaluate writes no lifecycle events'
  );
}

{
  // The acceptance command must run in the task workspace. A marker that
  // exists only there fails the command; the process cwd does not have it,
  // so a cwd-less re-run would stay PASS.
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-cwd-'));
  const marker = 'BROKEN_MARKER';
  const command = `node -e "process.exit(require('node:fs').existsSync('${marker}')?1:0)"`;
  const broken = await createDraftTask(brokenDir, 'npm test stays green', {
    acceptanceCommand: command,
  });
  const first = await verifyTaskOnce(brokenDir, { taskId: broken.taskId });
  assert.equal(first.exitCode, 0, first.summary);
  assert.equal((await getTaskStateSnapshot(brokenDir, broken.taskId)).phase, 'accepted');
  const accepted = (await listTaskRecords(brokenDir)).find((task) => task.taskId === broken.taskId);
  await appendTaskRecord(brokenDir, { ...accepted, status: 'accepted', updatedAt: Date.now() });
  fs.writeFileSync(path.join(brokenDir, marker), 'broken\n');
  const again = await verifyTaskOnce(brokenDir, { taskId: broken.taskId });
  assert.equal(again.exitCode, 1, again.summary);
  assert.match(again.summary, /Regression/);
  assert.match(again.summary, /previously PASS, now FAIL/);
  assert.equal((await getTaskStateSnapshot(brokenDir, broken.taskId)).phase, 'diagnosing');
  const reopened = (await listTaskRecords(brokenDir)).find((task) => task.taskId === broken.taskId);
  assert.equal(reopened?.status, 'active');
  const notes = await listTaskEvents(brokenDir, broken.taskId);
  assert.ok(notes.some((event) => event.type === 'note' && event.data?.kind === 'regression'));
}

{
  // PASS, then a failing re-verify, then PASS again. Status must follow the
  // latest acceptance.jsonl row, not the stale FAIL left behind by #55.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-verify-repass-'));
  const task = await createDraftTask(dir, 'stay green after a regression', {
    acceptanceCommand: 'true',
  });
  const first = await verifyTaskOnce(dir, { taskId: task.taskId });
  assert.equal(first.exitCode, 0, first.summary);
  let snap = await getTaskStateSnapshot(dir, task.taskId);
  assert.equal(snap?.lastVerdict?.verdict, 'pass');

  const failed = await verifyTaskOnce(dir, { taskId: task.taskId, command: 'false' });
  assert.equal(failed.exitCode, 1, failed.summary);
  snap = await getTaskStateSnapshot(dir, task.taskId);
  assert.equal(snap?.lastVerdict?.verdict, 'fail');

  const again = await verifyTaskOnce(dir, { taskId: task.taskId, command: 'true' });
  assert.equal(again.exitCode, 0, again.summary);
  snap = await getTaskStateSnapshot(dir, task.taskId);
  assert.equal(snap?.phase, 'accepted');
  assert.equal(snap?.lastVerdict?.verdict, 'pass');
  const rows = await listAcceptanceVerdicts(dir, task.taskId);
  assert.deepEqual(
    rows.map((row) => row.verdict),
    ['pass', 'fail', 'pass'],
    'acceptance.jsonl keeps the pass, the fail, and the repaired pass'
  );
  const status = formatTaskStatus(snap, '');
  assert.match(status, /VERDICT\s+PASS/);
  assert.doesNotMatch(status, /VERDICT\s+FAIL/);
}

console.log('[PASS] cli task verify');
