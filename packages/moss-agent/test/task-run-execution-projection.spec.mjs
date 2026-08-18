#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskRunLedger } from '../dist/core/task-run/index.js';
import { InMemoryExecutionStore } from '../dist/orchestration/index.js';

test('TaskRun v1 shadow-writes evidence but cannot false-complete an execution graph', () => {
  const store = new InMemoryExecutionStore();
  const ledger = new TaskRunLedger(undefined, store);
  ledger.create({ id: 'legacy', sessionId: 'session', title: 'Legacy run', time: 1 });
  ledger.append('legacy', { type: 'run.started', time: 2 });
  ledger.append('legacy', {
    type: 'tool.succeeded',
    time: 3,
    data: { toolName: 'exec', secretOutput: 'must not copy' },
  });
  ledger.append('legacy', { type: 'run.completed', time: 4 });
  assert.equal(store.load('legacy').status, 'running');
  assert.equal(store.load('legacy').evidence[0].summary, 'exec succeeded');
  assert.equal(JSON.stringify(store.load('legacy')).includes('must not copy'), false);

  ledger.append('legacy', { type: 'run.verified', time: 5 });
  assert.equal(store.load('legacy').status, 'completed');
  assert.equal(store.load('legacy').verification.verdict, 'verified');
});
