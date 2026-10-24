import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SessionInbox, type SessionInboxEntry } from './session-inbox.js';

type InboxLockOwner = { pid: number; token: string };

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensureDirectory(directory: string): void {
  if (fs.existsSync(directory)) return;
  const parent = path.dirname(directory);
  ensureDirectory(parent);
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  syncDirectory(directory);
  syncDirectory(parent);
}

function readOwner(file: string): InboxLockOwner | undefined {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InboxLockOwner>;
    return Number.isSafeInteger(owner.pid) &&
      (owner.pid ?? 0) > 0 &&
      typeof owner.token === 'string' &&
      owner.token.length >= 16
      ? (owner as InboxLockOwner)
      : undefined;
  } catch {
    return undefined;
  }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** The synchronous admission API cannot wait on an async lock in this process. */
function withInboxLock<T>(file: string, operation: () => T): T {
  ensureDirectory(path.dirname(file));
  const lock = `${file}.lock`;
  const owner: InboxLockOwner = { pid: process.pid, token: crypto.randomUUID() };
  const candidate = `${lock}.candidate-${owner.token}`;
  const publish = (target: string): boolean => {
    let published = false;
    try {
      fs.linkSync(candidate, target);
      published = true;
      syncDirectory(path.dirname(file));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      if (published && readOwner(target)?.token === owner.token) {
        // A failed directory fsync must not strand a live owner that prevents
        // the same process from retrying an admission it was told had failed.
        try {
          fs.unlinkSync(target);
          syncDirectory(path.dirname(file));
        } catch {
          /* preserve the original durability error */
        }
      }
      throw error;
    }
  };
  const release = (target: string): void => {
    if (readOwner(target)?.token !== owner.token)
      throw new Error(`Session inbox lock owner changed: ${target}`);
    fs.unlinkSync(target);
    syncDirectory(path.dirname(file));
  };
  let acquired = false;
  try {
    const fd = fs.openSync(candidate, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    acquired = publish(lock);
    if (!acquired) {
      // One recovery gate serializes dead-owner replacement. A stranded or
      // malformed recovery owner fails closed; elapsed time never proves death.
      const observed = readOwner(lock);
      const recovery = `${lock}.recovery`;
      if (!observed || !isDead(observed.pid) || !publish(recovery)) {
        throw new Error(`Session inbox is locked or has an unknown owner: ${file}`);
      }
      try {
        const current = readOwner(lock);
        if (!current || current.token !== observed.token || !isDead(current.pid)) {
          throw new Error(`Session inbox lock owner changed during recovery: ${file}`);
        }
        fs.unlinkSync(lock);
        syncDirectory(path.dirname(file));
        acquired = publish(lock);
        if (!acquired) throw new Error(`Session inbox lock recovery conflicted: ${file}`);
      } finally {
        release(recovery);
      }
    }
    return operation();
  } finally {
    try {
      if (acquired) release(lock);
    } finally {
      fs.rmSync(candidate, { force: true });
    }
  }
}

export function loadSessionInbox(filePath: string): SessionInbox {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new SessionInbox();
    throw error;
  }
  const entries = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (entry: Partial<SessionInboxEntry>) =>
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.prompt === 'string' &&
        (entry.delivery === 'steer' || entry.delivery === 'queue') &&
        Number.isSafeInteger(entry.admittedSeq) &&
        (entry.admittedSeq ?? 0) > 0 &&
        (entry.promotedSeq === undefined ||
          (Number.isSafeInteger(entry.promotedSeq) && entry.promotedSeq > 0)) &&
        (entry.deferred === undefined || typeof entry.deferred === 'boolean')
    )
  )
    throw new Error(`Invalid session inbox: ${filePath}`);
  if (new Set(entries.map((entry: SessionInboxEntry) => entry.id)).size !== entries.length) {
    throw new Error(`Duplicate entries in session inbox: ${filePath}`);
  }
  return SessionInbox.fromEntries(entries as SessionInboxEntry[]);
}

function writeSessionInbox(filePath: string, inbox: SessionInbox): void {
  const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(inbox.toEntries(), null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

export function saveSessionInbox(filePath: string, inbox: SessionInbox): void {
  withInboxLock(filePath, () => writeSessionInbox(filePath, inbox));
}

/** Reload and mutate under one lock so separate Agent instances cannot lose entries. */
export function updateSessionInbox<T>(
  filePath: string,
  mutate: (inbox: SessionInbox) => T
): { inbox: SessionInbox; result: T } {
  return withInboxLock(filePath, () => {
    const inbox = loadSessionInbox(filePath);
    const result = mutate(inbox);
    writeSessionInbox(filePath, inbox);
    return { inbox, result };
  });
}
