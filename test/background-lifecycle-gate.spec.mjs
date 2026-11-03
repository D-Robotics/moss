import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateBackgroundLifecycleGate } from '../dist/core/loop/background-lifecycle-gate.js';

const running = [{ id: 'bg_1', pid: 123, command: 'node server.mjs', status: 'running' }];

test('a clean background registry completes', () => {
  assert.deepEqual(evaluateBackgroundLifecycleGate([]), { ok: true });
  assert.deepEqual(
    evaluateBackgroundLifecycleGate([{ id: 'bg_2', command: 'node old.mjs', status: 'exited' }]),
    { ok: true }
  );
});

test('a live background process blocks completion once with id, pid, and stop instruction', () => {
  const decision = evaluateBackgroundLifecycleGate(running);
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /bg_1/);
  assert.match(decision.reason, /pid 123/);
  assert.match(decision.correction, /exec_stop/);
  assert.match(decision.correction, /node server\.mjs/);
  assert.match(decision.correction, /confirm it stopped/);
});
