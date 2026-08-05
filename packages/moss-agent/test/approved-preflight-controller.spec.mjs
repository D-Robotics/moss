import assert from 'node:assert/strict';

import { ApprovedPreflightController } from '../dist/core/subagent/approved-preflight-controller.js';

const controller = new ApprovedPreflightController();

assert.equal(controller.requestStop('run-a', 'plan-a:queued').outcome, 'queued');
controller.beginRun('run-a', ['plan-a:queued', 'plan-a:running']);
assert.equal(controller.requestStop('run-a', 'plan-a:not-approved').outcome, 'not_found');
assert.equal(controller.signalFor('run-a', 'plan-a:queued')?.aborted, true);
assert.equal(controller.markRunning('run-a', 'plan-a:queued'), false);
assert.equal(controller.markRunning('run-a', 'plan-a:running'), true);
assert.equal(controller.requestStop('run-a', 'plan-a:running').outcome, 'cancel_requested');
assert.equal(controller.signalFor('run-a', 'plan-a:running')?.aborted, true);
assert.equal(controller.requestStop('run-a', 'plan-a:running').outcome, 'already_cancelled');
controller.markTerminal('run-a', 'plan-a:running', 'completed');
assert.equal(
  controller.requestStop('run-a', 'plan-a:running').outcome,
  'already_cancelled',
  'a late completion cannot overwrite cancellation'
);
controller.finishRun('run-a');
assert.equal(
  controller.requestStop('run-a', 'plan-a:running').outcome,
  'not_found',
  'a finished preflight must not be mistaken for a not-yet-registered run',
);
controller.releaseRun('run-a');
assert.equal(
  controller.requestStop('run-a', 'plan-a:running').outcome,
  'queued',
  'releaseRun must remove the finished tombstone at parent-run teardown',
);
controller.releaseRun('run-a');

controller.beginRun('run-b', ['plan-b:done']);
assert.equal(controller.markRunning('run-b', 'plan-b:done'), true);
controller.markTerminal('run-b', 'plan-b:done', 'completed');
assert.deepEqual(controller.requestStop('run-b', 'plan-b:done'), {
  outcome: 'already_terminal',
  state: 'completed',
});
controller.releaseRun('run-b');

controller.beginRun('run-isolated-a', ['shared-assignment']);
controller.beginRun('run-isolated-b', ['shared-assignment']);
assert.equal(
  controller.requestStop('run-isolated-a', 'shared-assignment').outcome,
  'cancel_requested',
);
assert.equal(controller.markRunning('run-isolated-b', 'shared-assignment'), true);
assert.equal(
  controller.signalFor('run-isolated-b', 'shared-assignment')?.aborted,
  false,
  'the same assignment id in a sibling parent run must remain isolated',
);
controller.finishRun('run-isolated-a');
controller.finishRun('run-isolated-b');
controller.releaseRun('run-isolated-a');
controller.releaseRun('run-isolated-b');

console.log('[PASS] approved preflight controller isolates queued/running assignment cancellation');
