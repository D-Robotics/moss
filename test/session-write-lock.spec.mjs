#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  acquireSessionWriteLock,
  acquireSessionWriteLockWithOperations,
} from '../dist/core/session/session-write-lock.js';

const execFileAsync = promisify(execFile);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-session-lock-'));
const sessionFile = path.join(dir, 'session.jsonl');
const lockPath = `${sessionFile}.lock`;
const recoveryPath = `${lockPath}.recovery`;

async function writeOwner(ownerPath, pid, token) {
  await fs.writeFile(
    ownerPath,
    `${JSON.stringify({
      version: 1,
      pid,
      token,
      createdAt: new Date(0).toISOString(),
    })}\n`
  );
}

async function writeDeadOwner(token) {
  await writeOwner(lockPath, 2_147_483_647, token);
}

async function syncDirectoryIfSupported(directoryPath) {
  if (process.platform === 'win32') return;
  const directory = await fs.open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isLockFailureFrom(error, causeMessage) {
  return (
    /获取会话写锁超时或失败/u.test(error?.message ?? '') && error?.cause?.message === causeMessage
  );
}

try {
  // A durability error after the recovery owner hard-link is visible must
  // compensate that exact owner, otherwise this still-live process wedges all
  // later acquisitions until it exits.
  {
    let directorySyncs = 0;
    await assert.rejects(
      acquireSessionWriteLockWithOperations({
        sessionFile,
        operations: {
          syncDirectory: async (directoryPath) => {
            directorySyncs += 1;
            if (directorySyncs === 2) {
              throw Object.assign(new Error('injected recovery publish fsync failure'), {
                code: 'EIO',
              });
            }
            await syncDirectoryIfSupported(directoryPath);
          },
        },
      }),
      (error) => isLockFailureFrom(error, 'injected recovery publish fsync failure')
    );
    await assert.rejects(fs.access(recoveryPath), { code: 'ENOENT' });
    const retry = await acquireSessionWriteLock({ sessionFile, timeoutMs: 200 });
    await retry.release();
  }

  // If canonical publication succeeded but recovery-gate release then fails,
  // acquisition did not return a handle. Compensate the canonical owner too so
  // the caller can retry in the same long-lived process.
  {
    let directorySyncs = 0;
    await assert.rejects(
      acquireSessionWriteLockWithOperations({
        sessionFile,
        operations: {
          syncDirectory: async (directoryPath) => {
            directorySyncs += 1;
            if (directorySyncs === 5) {
              throw Object.assign(new Error('injected recovery release fsync failure'), {
                code: 'EIO',
              });
            }
            await syncDirectoryIfSupported(directoryPath);
          },
        },
      }),
      (error) => isLockFailureFrom(error, 'injected recovery release fsync failure')
    );
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
    const retry = await acquireSessionWriteLock({ sessionFile, timeoutMs: 200 });
    await retry.release();
  }

  // Compensation is token-conditional. A successor/tamper that replaces the
  // published owner before cleanup must remain untouched.
  {
    let directorySyncs = 0;
    const replacementToken = 'replacement-recovery-owner-token-0001';
    await assert.rejects(
      acquireSessionWriteLockWithOperations({
        sessionFile,
        operations: {
          syncDirectory: async (directoryPath) => {
            directorySyncs += 1;
            if (directorySyncs === 2) {
              const owner = JSON.parse(await fs.readFile(recoveryPath, 'utf8'));
              await fs.writeFile(
                recoveryPath,
                `${JSON.stringify({ ...owner, token: replacementToken })}\n`
              );
              throw Object.assign(new Error('injected post-publication ownership race'), {
                code: 'EIO',
              });
            }
            await syncDirectoryIfSupported(directoryPath);
          },
        },
      }),
      (error) => isLockFailureFrom(error, 'injected post-publication ownership race')
    );
    const replacement = JSON.parse(await fs.readFile(recoveryPath, 'utf8'));
    assert.equal(replacement.token, replacementToken);
    await fs.rm(recoveryPath);
  }

  // A process that dies while preparing an unpublished owner only strands its
  // unique candidate; the canonical lock remains available.
  const crashedCandidate = `${lockPath}.candidate-crashed-owner-token`;
  await fs.writeFile(crashedCandidate, 'interrupted candidate');
  const afterCandidateCrash = await acquireSessionWriteLock({ sessionFile });
  await afterCandidateCrash.release();
  assert.equal((await fs.stat(crashedCandidate)).isFile(), true);
  await fs.rm(crashedCandidate);

  // Crashes before publishing the recovery owner only strand a unique
  // candidate, so a successor can still publish the single canonical gate.
  const crashedRecoveryCandidate = `${recoveryPath}.candidate-crashed-recovery-token`;
  await fs.writeFile(crashedRecoveryCandidate, 'interrupted recovery candidate');
  const afterRecoveryCandidateCrash = await acquireSessionWriteLock({ sessionFile });
  await afterRecoveryCandidateCrash.release();
  await fs.rm(crashedRecoveryCandidate);

  // A crash after publishing the recovery owner is reclaimed only when its
  // exact token still matches and its PID is provably dead.
  await writeOwner(recoveryPath, 2_147_483_647, 'dead-recovery-owner-token-0001');
  const afterRecoveryOwnerCrash = await acquireSessionWriteLock({ sessionFile });
  await afterRecoveryOwnerCrash.release();
  await assert.rejects(fs.access(recoveryPath), { code: 'ENOENT' });

  // Crash after canonical publication but before recovery-gate release: both
  // records are dead and one successor atomically replaces them.
  await writeDeadOwner('dead-published-canonical-token');
  await writeOwner(recoveryPath, 2_147_483_647, 'dead-published-recovery-token');
  const afterCanonicalPublishCrash = await acquireSessionWriteLock({ sessionFile });
  await afterCanonicalPublishCrash.release();
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(recoveryPath), { code: 'ENOENT' });

  const missingParentFile = path.join(dir, 'fresh', 'nested', 'session.jsonl');
  const freshLock = await acquireSessionWriteLock({ sessionFile: missingParentFile });
  assert.equal((await fs.stat(path.dirname(missingParentFile))).isDirectory(), true);
  await freshLock.release();

  const holder = await acquireSessionWriteLock({ sessionFile });
  await assert.rejects(
    acquireSessionWriteLock({ sessionFile, timeoutMs: 150, staleMs: 1 }),
    /获取会话写锁超时或失败/,
    'age never permits stealing a live owner'
  );
  await holder.release();

  const markerPath = path.join(dir, 'critical-section.marker');
  const moduleUrl = new URL('../dist/core/session/session-write-lock.js', import.meta.url).href;
  // Hosted Windows runners can spend several seconds starting 24 Node
  // contenders. Keep the mutual-exclusion assertion strict without turning
  // process-startup latency into a lock timeout.
  const childTimeoutMs = process.platform === 'win32' ? 30_000 : 10_000;
  const childScript = [
    `import fs from 'node:fs/promises';`,
    `import { acquireSessionWriteLock } from ${JSON.stringify(moduleUrl)};`,
    `const [sessionFile, markerPath] = process.argv.slice(1);`,
    `const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: ${childTimeoutMs} });`,
    `let marker;`,
    `try {`,
    `  marker = await fs.open(markerPath, 'wx');`,
    `  await new Promise((resolve) => setTimeout(resolve, 20));`,
    `} finally {`,
    `  await marker?.close();`,
    `  if (marker) await fs.rm(markerPath, { force: true });`,
    `  await lock.release();`,
    `}`,
  ].join('\n');

  for (let round = 0; round < 5; round++) {
    await writeDeadOwner(`dead-owner-token-${round}`);
    const contenders = await Promise.allSettled(
      Array.from({ length: 24 }, () =>
        execFileAsync(process.execPath, [
          '--input-type=module',
          '--eval',
          childScript,
          sessionFile,
          markerPath,
        ])
      )
    );
    assert.deepEqual(
      contenders.filter((result) => result.status === 'rejected'),
      [],
      `dead-owner recovery remains mutually exclusive in round ${round + 1}`
    );
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(recoveryPath), { code: 'ENOENT' });
  }
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });

  // A successor/tampered token cannot be removed by an older release handle.
  const tokenGuard = await acquireSessionWriteLock({ sessionFile });
  const ownerFile = lockPath;
  const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  await fs.writeFile(
    ownerFile,
    `${JSON.stringify({ ...owner, token: 'replacement-token-0001' })}\n`
  );
  await assert.rejects(tokenGuard.release(), /owner 已改变/);
  assert.equal((await fs.stat(lockPath)).isFile(), true, 'mismatched release keeps owner intact');
  await fs.rm(lockPath);

  // Unknown/damaged recovery state remains fail-closed.
  await fs.writeFile(recoveryPath, 'unknown recovery owner');
  await assert.rejects(
    acquireSessionWriteLock({ sessionFile, timeoutMs: 100 }),
    /获取会话写锁超时或失败/
  );
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  await fs.rm(recoveryPath);

  // A live recovery owner (including a reused PID) is never stolen.
  await writeOwner(recoveryPath, process.pid, 'live-recovery-owner-token-0001');
  await assert.rejects(
    acquireSessionWriteLock({ sessionFile, timeoutMs: 100 }),
    /获取会话写锁超时或失败/
  );
  await fs.rm(recoveryPath);

  // Malformed legacy/externally damaged canonical state remains fail-closed.
  await fs.writeFile(lockPath, 'not a valid owner record');
  await assert.rejects(
    acquireSessionWriteLock({ sessionFile, timeoutMs: 100 }),
    /获取会话写锁超时或失败/
  );
  assert.equal((await fs.stat(lockPath)).isFile(), true);
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('  [PASS] session-write-lock: dead-PID recovery is strict and ABA-safe');
