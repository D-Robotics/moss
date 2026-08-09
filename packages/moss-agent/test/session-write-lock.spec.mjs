#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireSessionWriteLock } from '../dist/core/session/session-write-lock.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-session-lock-'));
const sessionFile = path.join(dir, 'session.jsonl');
const lockPath = `${sessionFile}.lock`;

async function writeLiveLock(nonce) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      nonce,
      createdAt: new Date().toISOString(),
    })
  );
}

try {
  await writeLiveLock('holder-a');

  const waiter = acquireSessionWriteLock({
    sessionFile,
    timeoutMs: 240,
    staleMs: 60_000,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeLiveLock('holder-b');

  await assert.rejects(
    waiter,
    /获取会话写锁超时/,
    'a live lock that changes owners must remain exclusive'
  );

  const payload = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(payload.nonce, 'holder-b', 'the waiter must not delete the new live owner lock');

  await fs.rm(lockPath, { force: true });
  await writeLiveLock('long-running-holder');
  await new Promise((resolve) => setTimeout(resolve, 10));

  await assert.rejects(
    acquireSessionWriteLock({
      sessionFile,
      timeoutMs: 120,
      staleMs: 1,
    }),
    /获取会话写锁超时/,
    'lock age alone must not make a live owner stale without a lease heartbeat'
  );

  const longRunningPayload = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(
    longRunningPayload.nonce,
    'long-running-holder',
    'the waiter must not steal an old lock from a live owner'
  );

  await fs.rm(lockPath, { force: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: 2_147_483_647,
      nonce: 'dead-holder',
      createdAt: new Date().toISOString(),
    })
  );

  const recovered = await acquireSessionWriteLock({ sessionFile, timeoutMs: 240 });
  const recoveredPayload = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.notEqual(recoveredPayload.nonce, 'dead-holder', 'a dead owner lock is reclaimed');
  await recovered.release();
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('  [PASS] session-write-lock: live owner handoff remains exclusive');
