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

console.log('[PASS] cli task verify');
