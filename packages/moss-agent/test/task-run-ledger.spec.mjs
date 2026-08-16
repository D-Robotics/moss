#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TaskRunLedger } from '../dist/core/task-run/task-run-ledger.js';

test('task ledger projects evidence without claiming verification', () => {
  const ledger = new TaskRunLedger();
  ledger.create({ id: 'run-1', sessionId: 'session-1', title: 'Ship safely', time: 1 });
  ledger.append('run-1', { type: 'run.started', time: 2 });
  ledger.append('run-1', { type: 'tool.started', data: { name: 'test' }, time: 3 });
  ledger.append('run-1', { type: 'tool.succeeded', data: { result: 'pass' }, time: 4 });
  const completed = ledger.append('run-1', { type: 'run.completed', time: 5 });
  assert.deepEqual(
    {
      status: completed.status,
      verification: completed.verification,
      evidenceCount: completed.evidenceCount,
      latestSeq: completed.latestSeq,
    },
    { status: 'completed', verification: 'unverified', evidenceCount: 1, latestSeq: 5 }
  );
  assert.equal(ledger.append('run-1', { type: 'run.verified', time: 6 }).verification, 'verified');
  assert.throws(() => ledger.append('run-1', { type: 'run.rejected' }), /already has/);
  assert.throws(() => ledger.append('run-1', { type: 'run.started' }), /already completed/);
});

test('task ledger recovers persisted active work as interrupted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-task-run-'));
  const file = path.join(dir, 'runs.jsonl');
  try {
    const first = new TaskRunLedger(file);
    first.create({ id: 'run-active', sessionId: 'session-1', time: 1 });
    first.append('run-active', { type: 'run.started', time: 2 });
    first.create({ id: 'run-done', sessionId: 'session-2', time: 3 });
    first.append('run-done', { type: 'run.started', time: 4 });
    first.append('run-done', { type: 'run.completed', time: 5 });
    fs.appendFileSync(file, '{truncated');

    const recovered = new TaskRunLedger(file);
    assert.equal(recovered.recoverInterrupted(6), 1);
    assert.equal(recovered.get('run-active').status, 'interrupted');
    assert.equal(recovered.get('run-done').status, 'completed');
    assert.deepEqual(
      recovered.events('run-active').map((event) => event.seq),
      [1, 2, 3]
    );
    assert.equal(new TaskRunLedger(file).get('run-active').status, 'interrupted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task ledger deduplicates event IDs', () => {
  const ledger = new TaskRunLedger();
  ledger.create({ id: 'run-1', sessionId: 'session-1' });
  ledger.append('run-1', { id: 'stable-event', type: 'run.started' });
  ledger.append('run-1', { id: 'stable-event', type: 'run.started' });
  assert.equal(ledger.get('run-1').latestSeq, 2);
  ledger.create({ id: 'run-2', sessionId: 'session-2' });
  assert.throws(
    () => ledger.append('run-2', { id: 'stable-event', type: 'run.started' }),
    /belongs to another run/
  );
});
