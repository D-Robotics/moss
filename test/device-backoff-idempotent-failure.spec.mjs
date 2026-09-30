#!/usr/bin/env node
/**
 * Task OS M12 — iteration-efficiency fixes: device connect backoff (the
 * MaxStartups storm cost ~15 of Task B's 22 turns) and idempotent
 * record_failure per verification attempt (C runs triple-recorded).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { connectWithBackoff, isTransientConnectError } from '../dist/device/device-registry.js';
import { recordFailureTool, taskDefineTool } from '../dist/tools/task-tools.js';
import { getTaskStateSnapshot, appendTaskEvent } from '../dist/core/task/task-store.js';

test('connectWithBackoff retries transient handshake errors with backoff, then succeeds', async () => {
  const sleeps = [];
  const retries = [];
  let attempts = 0;
  const result = await connectWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('Connection closed during handshake (sshd MaxStartups?)');
      }
      return 'connected';
    },
    {
      backoffMs: [10, 20, 40],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (attempt, waitMs) => retries.push([attempt, waitMs]),
    }
  );
  assert.equal(result, 'connected');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.deepEqual(retries, [
    [1, 10],
    [2, 20],
  ]);
});

test('non-transient errors fail fast without backoff', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      connectWithBackoff(
        async () => {
          attempts += 1;
          throw new Error('All configured authentication methods failed');
        },
        { backoffMs: [1], sleep: async () => {} }
      ),
    /authentication methods failed/
  );
  assert.equal(attempts, 1, 'auth errors are not transient — no retry');
});

test('transient detection covers the storm signatures', () => {
  for (const message of [
    'sshd MaxStartups bucket full',
    'Connection reset by peer',
    'ETIMEDOUT',
    'read ECONNRESET',
  ]) {
    assert.ok(isTransientConnectError(message), message);
  }
  assert.equal(isTransientConnectError('authentication failed'), false);
});

test('record_failure is idempotent per verification attempt', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-m12-'));
  const ctx = { workspaceDir: ws, sessionKey: 'm12' };
  await taskDefineTool.execute(
    { goal: 'g', acceptance_criteria: [{ metric: 'x', expected: 'exists' }] },
    ctx
  );
  const events = await (await import('../dist/core/task/task-store.js')).listTaskEvents(ws);
  const taskId = events[0].taskId;
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_fail', { detail: 'no evidence' });

  const first = await recordFailureTool.execute({ task_id: taskId, symptom: 's1' }, ctx);
  const second = await recordFailureTool.execute(
    { task_id: taskId, symptom: 's2', diagnosis: 'root cause found' },
    ctx
  );
  assert.match(first, /Failure fail_\S+ recorded/);
  assert.match(second, /Failure fail_\S+ recorded/);

  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.failures.length, 1, 'repeated record_failure updates, not clones');
  assert.equal(snapshot.failures[0].symptom, 's2');
  assert.equal(snapshot.failures[0].diagnosis, 'root cause found');
});
