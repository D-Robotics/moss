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
import { appendTaskRecord } from '../dist/core/task-runtime/artifacts.js';
import {
  createDraftTask,
  getTaskStateSnapshot,
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

const again = await verifyTaskOnce(workspace, { taskId: contract.taskId });
assert.equal(again.exitCode, 0);
assert.match(again.summary, /already accepted/);

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

console.log('[PASS] cli task verify');
