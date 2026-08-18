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
  assert.equal(store.load('legacy').status, 'blocked');
  assert.equal(store.load('legacy').verification, undefined);
  assert.match(store.load('legacy').evidence.at(-1).summary, /reported verified/);
});

test('new task entry creates a risk-adaptive Delivery Case before execution', () => {
  const store = new InMemoryExecutionStore();
  const ledger = new TaskRunLedger(undefined, store);
  ledger.create({
    id: 'delivery-default',
    sessionId: 'session',
    title: 'Plugin permissions',
    goal: 'Add plugin permission preview and a security gate across Web and CLI',
    time: 1,
  });
  const graph = store.load('delivery-default');
  assert.equal(graph.deliveryCase.depth, 'comprehensive');
  assert.equal(graph.deliveryCase.riskLevel, 'high');
  assert.equal(graph.deliveryCase.stage, 'elaborating');
  assert.equal(graph.deliveryCase.elaborationRounds.length, 1);
  assert.equal(graph.deliveryCase.elaborationRounds[0].resolved, false);
  assert.equal(graph.nodes['delivery-work'].kind, 'implementation');
  assert.equal(graph.nodes['delivery-work'].acceptanceContract.revision, 1);
  assert.deepEqual(graph.nodes['delivery-work'].writePaths, ['.']);
});

test('a caller cannot lower the deterministic delivery depth floor', () => {
  const store = new InMemoryExecutionStore();
  const ledger = new TaskRunLedger(undefined, store);
  ledger.create({
    id: 'delivery-floor',
    sessionId: 'session',
    goal: 'Migrate the public API permission contract',
    deliveryDepth: 'minimal',
  });
  assert.equal(store.load('delivery-floor').deliveryCase.depth, 'comprehensive');
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
    assert.equal(store.load('old-run').status, 'blocked');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(`${file}.execution-graph-migration-v1.json`), true);
    new TaskRunLedger(file, store);
    assert.equal(store.load('old-run').revision, 4, 'marker prevents duplicate event imports');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
