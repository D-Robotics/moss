#!/usr/bin/env node
/**
 * Regression (red→green) for repair-loop turn waste: the repair turn of
 * attempt >= 2 must carry the repairs already on record (and the open
 * failures) plus an explicit anti-repeat instruction — a reverify-failed
 * agent that re-applies the same fix burns a repair cycle (repair turn +
 * reverify) for nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTask } from '../dist/core/task/task-engine.js';
import { listTaskEvents, recordFailure, recordRepair } from '../dist/core/task/task-store.js';
import { appendTaskRecord, appendEvidenceRecord } from '../dist/core/task-runtime/artifacts.js';

function mockAgent(script) {
  const calls = [];
  const runTurn = async (prompt, phase) => {
    calls.push({ prompt, phase });
    const action = script[calls.length - 1] ?? (() => {});
    await action();
    return 'turn ' + calls.length + ' (' + phase + ') done';
  };
  return { runTurn, calls };
}

test('repair attempt 2 prompt carries prior repairs + open failures and forbids repeating them', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-repair-hist-'));
  let taskId;
  const { runTurn, calls } = mockAgent([
    // planning: define the contract
    async () => {
      taskId = (await listTaskEvents(ws))[0].taskId;
      await appendTaskRecord(ws, {
        taskId,
        goal: 'service p99 back in SLA',
        acceptanceCriteria: [{ metric: 'p99_ms', expected: '<=200' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    // execute 1: no evidence recorded yet → verification fails
    () => {},
    // repair 1: honest failure record + a repair that does NOT fix it
    // (no fresh evidence) → reverify will fail again
    async () => {
      await recordFailure(ws, {
        taskId,
        stage: 'verifying',
        symptom: 'p99_ms: no evidence recorded',
        diagnosis: 'latency never measured after deploy',
        attempt: 1,
        resolved: false,
      });
      await recordRepair(ws, {
        taskId,
        action: 'increase worker pool to 8',
        changedFiles: ['svc/worker.js'],
      });
    },
    // execute 2: still no evidence → second verification failure
    () => {},
    // repair 2: the fix that finally measures and passes
    async () => {
      await appendEvidenceRecord(ws, {
        evidenceId: 'ev_' + Date.now(),
        taskId,
        source: 'exec',
        metric: 'p99_ms',
        expected: '<=200',
        observed: 120,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
    // execute 3: passing evidence on record → accepted
    () => {},
  ]);

  const result = await runTask({ workspaceDir: ws, runTurn }, 'service p99 back in SLA');

  // The run itself settles the normal way.
  assert.equal(result.outcome, 'pass');
  assert.equal(result.turns, 6);
  const phases = calls.map((c) => c.phase);
  assert.deepEqual(phases, [
    'planning',
    'executing',
    'repairing',
    'executing',
    'repairing',
    'executing',
  ]);

  const repair1 = calls[2].prompt;
  const repair2 = calls[4].prompt;

  // Repair 1 has no history yet: no anti-repeat section, no prior repair.
  assert.doesNotMatch(repair1, /do not repeat/i);
  assert.doesNotMatch(repair1, /increase worker pool to 8/);

  // Repair 2 (reverify failed after repair 1) must see what was already
  // tried and steer away from repeating it.
  assert.match(repair2, /increase worker pool to 8/);
  assert.match(repair2, /do not repeat/i);
  assert.match(repair2, /different root-cause hypothesis/i);
  // The open failure from attempt 1 is surfaced, not just the raw verdict.
  assert.match(repair2, /p99_ms: no evidence recorded/);
});
