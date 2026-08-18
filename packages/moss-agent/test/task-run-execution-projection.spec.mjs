#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('existing TaskRun JSONL is imported once without deleting or rewriting the source', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-run-import-'));
  const file = path.join(temp, 'task-runs.jsonl');
  try {
    const legacy = new TaskRunLedger(file);
    legacy.create({ id: 'old-run', sessionId: 'old-session', title: 'Old run', time: 1 });
    legacy.append('old-run', { type: 'run.started', time: 2 });
    legacy.append('old-run', { type: 'run.completed', time: 3 });
    legacy.append('old-run', { type: 'run.verified', time: 4 });
    const original = fs.readFileSync(file, 'utf8');

    const store = new InMemoryExecutionStore();
    new TaskRunLedger(file, store);
    assert.equal(store.load('old-run').status, 'completed');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(`${file}.execution-graph-migration-v1.json`), true);
    new TaskRunLedger(file, store);
    assert.equal(store.load('old-run').revision, 4, 'marker prevents duplicate event imports');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
