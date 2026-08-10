import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MossError, ErrorCode } from '../../errors.js';

type LockOwner = {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
};

export interface SessionWriteLock {
  release: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

interface SessionWriteLockOperations {
  syncDirectory(directoryPath: string): Promise<void>;
}

const RETRY_DELAY_MS = 25;

async function readOwner(ownerPath: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Partial<LockOwner>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== 'string' ||
      value.token.length < 16 ||
      typeof value.createdAt !== 'string'
    ) {
      return undefined;
    }
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM, PID reuse, and unknown probe failures cannot prove death.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await fs.open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const defaultOperations: SessionWriteLockOperations = { syncDirectory };

async function writeOwnerCandidate(
  filePath: string,
  owner: LockOwner,
  operations: SessionWriteLockOperations
): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await operations.syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close();
  }
}

/** Publish a complete owner without ever replacing an existing owner. */
async function tryCreateOwner(
  ownerPath: string,
  owner: LockOwner,
  operations: SessionWriteLockOperations
): Promise<boolean> {
  const candidatePath = `${ownerPath}.candidate-${owner.token}`;
  let published = false;
  try {
    await writeOwnerCandidate(candidatePath, owner, operations);
    try {
      await fs.link(candidatePath, ownerPath);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    await operations.syncDirectory(path.dirname(ownerPath));
    return true;
  } catch (error) {
    if (published) await compensatePublishedOwner(ownerPath, owner.token, operations);
    throw error;
  } finally {
    await fs.rm(candidatePath, { force: true }).catch(() => {});
  }
}

async function releaseOwnedPath(
  ownerPath: string,
  token: string,
  operations: SessionWriteLockOperations
): Promise<void> {
  const current = await readOwner(ownerPath);
  if (!current || current.token !== token) {
    throw new MossError({
      code: ErrorCode.SESSION_PERSIST_FAILED,
      message: `互斥锁 owner 已改变，拒绝释放: ${ownerPath}`,
      hint: 'Do not remove the lock manually; inspect the owner metadata.',
      recoverable: false,
    });
  }
  const releasedPath = `${ownerPath}.released-${token}`;
  await fs.rename(ownerPath, releasedPath);
  await operations.syncDirectory(path.dirname(ownerPath));
  await fs.rm(releasedPath, { force: true });
}

async function compensatePublishedOwner(
  ownerPath: string,
  token: string,
  operations: SessionWriteLockOperations
): Promise<void> {
  // Preserve the original durability error. releaseOwnedPath revalidates the
  // token, so a successor or externally replaced owner is never removed.
  await releaseOwnedPath(ownerPath, token, operations).catch(() => {});
}

/**
 * Acquire the single recovery gate. A crashed gate owner is replaced only
 * after exact token revalidation plus an ESRCH probe. Every canonical-lock
 * operation goes through this gate, so the rename gap cannot admit a second
 * writer; contenders race to hard-link exactly one complete successor owner.
 */
async function tryAcquireRecoveryGate(
  recoveryPath: string,
  nextOwner: LockOwner,
  operations: SessionWriteLockOperations
): Promise<boolean> {
  if (await tryCreateOwner(recoveryPath, nextOwner, operations)) return true;
  const observed = await readOwner(recoveryPath);
  if (!observed || processIsAlive(observed.pid)) return false;

  const current = await readOwner(recoveryPath);
  if (!current || current.token !== observed.token || processIsAlive(current.pid)) return false;
  const quarantinePath = `${recoveryPath}.recovered-${nextOwner.token}`;
  try {
    await fs.rename(recoveryPath, quarantinePath);
    await operations.syncDirectory(path.dirname(recoveryPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    return await tryCreateOwner(recoveryPath, nextOwner, operations);
  } finally {
    await fs.rm(quarantinePath, { force: true }).catch(() => {});
  }
}

/** Replace one revalidated dead canonical owner while holding the gate. */
async function tryReplaceDeadCanonical(
  lockPath: string,
  observed: LockOwner,
  nextOwner: LockOwner,
  operations: SessionWriteLockOperations
): Promise<boolean> {
  const current = await readOwner(lockPath);
  if (!current || current.token !== observed.token || processIsAlive(current.pid)) return false;
  const quarantinePath = `${lockPath}.recovered-${nextOwner.token}`;
  try {
    await fs.rename(lockPath, quarantinePath);
    await operations.syncDirectory(path.dirname(lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    return await tryCreateOwner(lockPath, nextOwner, operations);
  } finally {
    await fs.rm(quarantinePath, { force: true }).catch(() => {});
  }
}

function createLockResult(
  lockPath: string,
  token: string,
  operations: SessionWriteLockOperations
): SessionWriteLock {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    await releaseOwnedPath(lockPath, token, operations);
    released = true;
  };
  return { release, [Symbol.asyncDispose]: release };
}

/** Cross-process session mutex with one crash-recoverable ownership gate. */
export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  /** Retained for source compatibility; time alone is never proof of death. */
  staleMs?: number;
}): Promise<SessionWriteLock> {
  return acquireSessionWriteLockWithOperations(params);
}

/**
 * Internal module-path test seam for deterministic filesystem fault injection.
 * This symbol is deliberately not re-exported from the public session/core
 * entry points, so the package API remains limited to operational options.
 */
export async function acquireSessionWriteLockWithOperations(params: {
  sessionFile: string;
  timeoutMs?: number;
  /** Retained for source compatibility; time alone is never proof of death. */
  staleMs?: number;
  operations?: Partial<SessionWriteLockOperations>;
}): Promise<SessionWriteLock> {
  const timeoutMs = Math.max(RETRY_DELAY_MS, params.timeoutMs ?? 10_000);
  const sessionFile = path.resolve(params.sessionFile);
  const lockPath = `${sessionFile}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  const deadline = Date.now() + timeoutMs;
  const operations: SessionWriteLockOperations = {
    ...defaultOperations,
    ...params.operations,
  };
  const nextOwner: LockOwner = {
    version: 1,
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  void params.staleMs;

  try {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    while (Date.now() < deadline) {
      if (!(await tryAcquireRecoveryGate(recoveryPath, nextOwner, operations))) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      let acquired = false;
      try {
        const current = await readOwner(lockPath);
        if (!current) {
          // A present but malformed canonical owner is unknown, not absent.
          try {
            await fs.access(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              acquired = await tryCreateOwner(lockPath, nextOwner, operations);
            } else {
              throw error;
            }
          }
        } else if (!processIsAlive(current.pid)) {
          acquired = await tryReplaceDeadCanonical(lockPath, current, nextOwner, operations);
        }
      } finally {
        try {
          await releaseOwnedPath(recoveryPath, nextOwner.token, operations);
        } catch (error) {
          if (acquired) await compensatePublishedOwner(lockPath, nextOwner.token, operations);
          throw error;
        }
      }
      if (acquired) return createLockResult(lockPath, nextOwner.token, operations);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
    throw new Error('lock acquisition timed out');
  } catch (cause) {
    if (cause instanceof MossError) throw cause;
    throw new MossError({
      code: ErrorCode.SESSION_PERSIST_FAILED,
      message: `获取会话写锁超时或失败: ${sessionFile}`,
      hint: 'Wait for live owners to finish; unknown owner metadata fails closed.',
      recoverable: true,
      cause,
    });
  }
}
