import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LLMMessage } from '../llm/llm-provider.js';
import type { SessionStore, SessionMeta } from './session.js';
import { WriteChain } from '../../utils/write-chain.js';
import { ErrorCode, MossError } from '../../errors.js';
import { acquireSessionWriteLock } from './session-write-lock.js';

export interface JsonlSessionStoreConfig {
  dir: string;

  maxSessions?: number;
}

type JsonlSessionEntry =
  | { type: 'message'; message: LLMMessage; ts?: number }
  | { type: 'state_replace'; messages: LLMMessage[]; ts?: number };

type DurableFileHandle = {
  writeFile: (data: string, encoding: BufferEncoding) => Promise<void>;
  appendFile?: (data: string, encoding: BufferEncoding) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

type DurableSyncHandle = Pick<DurableFileHandle, 'sync' | 'close'>;

export interface DurableDirectoryOperations {
  exists: (directoryPath: string) => Promise<boolean>;
  mkdir: (directoryPath: string) => Promise<void>;
  open: (directoryPath: string, flags: string) => Promise<DurableSyncHandle>;
}

export interface DurableRemoveOperations {
  unlink: (filePath: string) => Promise<void>;
  open: (directoryPath: string, flags: string) => Promise<DurableSyncHandle>;
}

export interface DurableRewriteOperations {
  open: (filePath: string, flags: string, mode?: number) => Promise<DurableFileHandle>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (filePath: string, options: { force: boolean }) => Promise<void>;
}

export interface DurableAppendOperations {
  exists: (filePath: string) => Promise<boolean>;
  open: (filePath: string, flags: string, mode?: number) => Promise<DurableFileHandle>;
}

const durableRewriteOperations: DurableRewriteOperations = {
  open: (filePath, flags, mode) => fsp.open(filePath, flags, mode),
  rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
  rm: (filePath, options) => fsp.rm(filePath, options),
};

const durableAppendOperations: DurableAppendOperations = {
  exists: async (filePath) => {
    try {
      await fsp.access(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  open: (filePath, flags, mode) => fsp.open(filePath, flags, mode),
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fsp.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const durableDirectoryOperations: DurableDirectoryOperations = {
  exists: pathExists,
  mkdir: (directoryPath) => fsp.mkdir(directoryPath),
  open: (directoryPath, flags) => fsp.open(directoryPath, flags),
};

const durableRemoveOperations: DurableRemoveOperations = {
  unlink: (filePath) => fsp.unlink(filePath),
  open: (directoryPath, flags) => fsp.open(directoryPath, flags),
};

async function syncDirectoryWith(
  directoryPath: string,
  operations: Pick<DurableDirectoryOperations, 'open'>
): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await operations.open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Create every missing directory level and persist each parent entry. */
export async function ensureDirectoryDurably(
  directoryPath: string,
  operations: DurableDirectoryOperations = durableDirectoryOperations
): Promise<void> {
  if (process.platform === 'win32') {
    await fsp.mkdir(directoryPath, { recursive: true });
    return;
  }
  const missing: string[] = [];
  let existing = path.resolve(directoryPath);
  while (!(await operations.exists(existing))) {
    missing.push(existing);
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`No existing parent for ${directoryPath}`);
    existing = parent;
  }
  for (const next of missing.reverse()) {
    try {
      await operations.mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await syncDirectoryWith(next, operations);
    await syncDirectoryWith(path.dirname(next), operations);
  }
}

/** Remove a file and durably persist its absent directory entry. */
export async function removeFileDurably(
  filePath: string,
  operations: DurableRemoveOperations = durableRemoveOperations
): Promise<boolean> {
  try {
    await operations.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await syncDirectoryWith(path.dirname(filePath), operations);
  return true;
}

/** Append and persist a new directory entry as well as its file contents. */
export async function appendJsonlLineDurably(
  filePath: string,
  line: string,
  operations: DurableAppendOperations = durableAppendOperations
): Promise<void> {
  const existed = await operations.exists(filePath);
  let handle: DurableFileHandle | undefined;
  try {
    handle = await operations.open(filePath, 'a', 0o600);
    if (!handle.appendFile) throw new Error('append handle does not support appendFile');
    await handle.appendFile(line, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!existed && process.platform !== 'win32') {
      const directory = await operations.open(path.dirname(filePath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle?.close();
  }
}

/**
 * Persist one complete JSONL image and the directory entry that names it.
 * The injectable operations are intentionally internal-test-facing: a real
 * filesystem cannot deterministically simulate a crash/failure between the
 * file fsync, rename, and parent-directory fsync boundaries.
 */
export async function rewriteJsonlFileDurably(
  filePath: string,
  line: string,
  operations: DurableRewriteOperations = durableRewriteOperations
): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let handle: DurableFileHandle | undefined;
  try {
    handle = await operations.open(tmpPath, 'w', 0o600);
    await handle.writeFile(line, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await operations.rename(tmpPath, filePath);

    // rename durability requires syncing the containing directory on POSIX.
    // Windows does not support opening directories this way; its rename path
    // has already closed the file handle above.
    if (process.platform !== 'win32') {
      const directory = await operations.open(path.dirname(filePath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (err) {
    await operations.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await handle?.close();
  }
}

// PROCESS-LEVEL SINGLETON — intentional. The key is an absolute filesystem
// path (`sessionPath(sessionKey)`), which is globally unique per file. Two
// JsonlSessionStore instances writing to the SAME file MUST share the chain
// so their appends serialize (otherwise `appendFile` + `fsync` races would
// interleave partial lines and corrupt the JSONL). Two stores writing to
// DIFFERENT files see different keys and don't block each other. Moving the
// chain to instance state would break the first invariant (parallel embedded
// hosts writing to the same session file would corrupt it). Only the write
// enqueue lives here; the store itself is instance-scoped.
const sessionWriteChains = new WriteChain();

export class JsonlSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly maxSessions: number;
  /** Last complete file image observed by this store, used for optimistic replace. */
  private readonly observedContentVersions = new Map<string, string>();
  /** An append saw an external write since this instance last loaded the session. */
  private readonly replacementConflicts = new Set<string>();

  constructor(config: JsonlSessionStoreConfig) {
    this.dir = path.resolve(config.dir);
    this.maxSessions =
      typeof config.maxSessions === 'number' &&
      Number.isFinite(config.maxSessions) &&
      config.maxSessions > 0
        ? Math.floor(config.maxSessions)
        : 0;
  }

  private encodedSessionStem(sessionKey: string): string {
    return encodeURIComponent(sessionKey);
  }

  private decodeSessionStem(stem: string): string {
    try {
      return decodeURIComponent(stem);
    } catch {
      return stem;
    }
  }

  private sessionPath(sessionKey: string): string {
    return path.join(this.dir, `${this.encodedSessionStem(sessionKey)}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await ensureDirectoryDurably(this.dir);
  }

  private enqueueWrite(filePath: string, fn: () => Promise<void>): Promise<void> {
    return sessionWriteChains.enqueue(filePath, fn);
  }

  private contentVersion(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  private async readRaw(filePath: string): Promise<string> {
    try {
      return await fsp.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  private async withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lock = await acquireSessionWriteLock({ sessionFile: filePath });
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  private async withDirectoryMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lock = await acquireSessionWriteLock({
      sessionFile: path.join(this.dir, '.session-directory-mutation'),
    });
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  private async appendLineDurably(filePath: string, line: string): Promise<void> {
    await appendJsonlLineDurably(filePath, line);
  }

  /**
   * Atomic full-file rewrite: write a temp file in the same directory, fsync,
   * then rename over the target. `rename` is atomic on POSIX, so a crash leaves
   * either the previous file or the new one — never a partial truncate. Used by
   * `replaceMessages` to prune accumulated dead lines (prior `state_replace`
   * snapshots and superseded `message` lines) instead of appending yet another
   * full snapshot, which made the session file grow without bound over a long
   * session: every `replaceMessages` appended the full history while replay
   * ignored everything before the latest `state_replace`, so dead bytes
   * accumulated ~ (history size) × (number of replaces).
   */
  private async rewriteFileDurably(filePath: string, line: string): Promise<void> {
    await rewriteJsonlFileDurably(filePath, line);
  }

  private deriveTitle(messages: LLMMessage[]): string | undefined {
    for (const message of messages) {
      if (message.role !== 'user') continue;
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ');
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned) return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
    }
    return undefined;
  }

  private replayMessagesFromContent(raw: string): {
    messages: LLMMessage[];
    malformedCount: number;
  } {
    const lines = raw.split('\n').filter((l) => l.trim());
    const messages: LLMMessage[] = [];
    let malformedCount = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlSessionEntry;
        if (entry.type === 'message' && entry.message) {
          messages.push(entry.message);
        } else if (entry.type === 'state_replace' && Array.isArray(entry.messages)) {
          messages.splice(0, messages.length, ...entry.messages);
        }
      } catch {
        malformedCount++;
      }
    }
    return { messages, malformedCount };
  }

  async loadMessages(sessionKey: string): Promise<LLMMessage[]> {
    const filePath = this.sessionPath(sessionKey);
    let result: LLMMessage[] = [];
    await this.enqueueWrite(filePath, async () => {
      result = await this.withFileLock(filePath, async () => {
        const raw = await this.readRaw(filePath);
        this.observedContentVersions.set(filePath, this.contentVersion(raw));
        this.replacementConflicts.delete(filePath);
        if (!raw) return [];
        const { messages, malformedCount } = this.replayMessagesFromContent(raw);
        if (malformedCount > 0) {
          const pct =
            messages.length > 0
              ? ` (${((malformedCount / (messages.length + malformedCount)) * 100).toFixed(1)}% of all lines)`
              : '';
          console.warn(
            `[jsonl] ${filePath}: skipped ${malformedCount} malformed line(s)${pct} during load. ` +
              `The session history may be incomplete — missing turns might cause context gaps. ` +
              `Run \`moss doctor\` to check session integrity. ` +
              `If the damage is severe, start a fresh session with \`moss\`.`
          );
        }
        return messages;
      });
    });
    return result;
  }

  async appendMessage(sessionKey: string, message: LLMMessage): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({ type: 'message', message, ts: Date.now() });
    const mutate = async () => {
      let isNewSession = false;
      await this.enqueueWrite(filePath, async () => {
        await this.withFileLock(filePath, async () => {
          await this.ensureDir();
          isNewSession = this.maxSessions > 0 && !(await this.fileExists(filePath));
          const currentRaw = await this.readRaw(filePath);
          const observedVersion = this.observedContentVersions.get(filePath);
          const currentVersion = this.contentVersion(currentRaw);
          if (observedVersion !== undefined && observedVersion !== currentVersion) {
            this.replacementConflicts.add(filePath);
            throw new MossError({
              code: ErrorCode.SESSION_PERSIST_FAILED,
              message: `Session changed before append: ${sessionKey}`,
              hint: 'Reload the session before retrying so concurrent turns cannot interleave.',
              recoverable: true,
            });
          }
          await this.appendLineDurably(filePath, entry + '\n');
          const raw = await this.readRaw(filePath);
          this.observedContentVersions.set(filePath, this.contentVersion(raw));
        });
      });
      if (isNewSession) await this.pruneOldestSessions(sessionKey);
    };
    if (this.maxSessions > 0) await this.withDirectoryMutationLock(mutate);
    else await mutate();
  }

  async replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({
      type: 'state_replace',
      messages,
      ts: Date.now(),
    });
    const mutate = async () => {
      let isNewSession = false;
      await this.enqueueWrite(filePath, async () => {
        await this.withFileLock(filePath, async () => {
          await this.ensureDir();
          const currentRaw = await this.readRaw(filePath);
          const observedVersion = this.observedContentVersions.get(filePath);
          const currentVersion = this.contentVersion(currentRaw);
          if (
            this.replacementConflicts.has(filePath) ||
            (currentRaw.length > 0 && observedVersion === undefined) ||
            (observedVersion !== undefined && observedVersion !== currentVersion)
          ) {
            throw new MossError({
              code: ErrorCode.SESSION_PERSIST_FAILED,
              message: `Session changed before replacement: ${sessionKey}`,
              hint: 'Reload the session and retry the operation so concurrent messages are preserved.',
              recoverable: true,
            });
          }
          isNewSession = this.maxSessions > 0 && currentRaw.length === 0;
          // Rewrite the whole file to just this snapshot instead of appending.
          // Prunes dead lines (prior snapshots + superseded messages) that would
          // otherwise accumulate: replay ignores everything before the latest
          // state_replace, so appended-but-dead bytes grew ~ history × replaces.
          const nextRaw = entry + '\n';
          await this.rewriteFileDurably(filePath, nextRaw);
          this.observedContentVersions.set(filePath, this.contentVersion(nextRaw));
        });
      });
      if (isNewSession) await this.pruneOldestSessions(sessionKey);
    };
    if (this.maxSessions > 0) await this.withDirectoryMutationLock(mutate);
    else await mutate();
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async pruneOldestSessions(keepSessionKey: string): Promise<void> {
    if (this.maxSessions <= 0) return;
    const sessions = await this.listSessions();
    if (sessions.length <= this.maxSessions) return;
    const removable = sessions
      .filter((s) => s.sessionKey !== keepSessionKey)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.sessionKey.localeCompare(b.sessionKey));
    const removeCount = sessions.length - this.maxSessions;
    for (const session of removable.slice(0, removeCount)) {
      await this.deleteSession(session.sessionKey);
    }
  }

  async listSessions(): Promise<SessionMeta[]> {
    try {
      const files = await fsp.readdir(this.dir);
      const sessions: SessionMeta[] = [];
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionKey = this.decodeSessionStem(file.replace(/\.jsonl$/, ''));
        const filePath = path.join(this.dir, file);
        try {
          const stat = await fsp.stat(filePath);
          const content = await fsp.readFile(filePath, 'utf-8');
          const activeMessages = this.replayMessagesFromContent(content).messages;
          const title = this.deriveTitle(activeMessages);
          sessions.push({
            sessionKey,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs,
            messageCount: activeMessages.length,
            ...(title ? { title } : {}),
          });
        } catch {}
      }
      return sessions;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async deleteSession(sessionKey: string): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    await this.enqueueWrite(filePath, async () => {
      await this.withFileLock(filePath, async () => {
        await removeFileDurably(filePath);
        this.observedContentVersions.delete(filePath);
        this.replacementConflicts.delete(filePath);
      });
    });
  }

  async exists(sessionKey: string): Promise<boolean> {
    const filePath = this.sessionPath(sessionKey);
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
