














import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LLMMessage } from '../llm/llm-provider.js';
import type { SessionStore, SessionMeta } from './session.js';
import { WriteChain } from '../../utils/write-chain.js';

export interface JsonlSessionStoreConfig {
  dir: string;
  








  maxSessions?: number;
}

type JsonlSessionEntry =
  | { type: 'message'; message: LLMMessage; ts?: number }
  | { type: 'state_replace'; messages: LLMMessage[]; ts?: number };



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
    await fsp.mkdir(this.dir, { recursive: true });
  }

  private enqueueWrite(filePath: string, fn: () => Promise<void>): Promise<void> {
    return sessionWriteChains.enqueue(filePath, fn);
  }

  private async appendLineDurably(filePath: string, line: string): Promise<void> {
    let handle: fsp.FileHandle | undefined;
    try {
      
      
      
      
      
      handle = await fsp.open(filePath, 'a', 0o600);
      await handle.appendFile(line, 'utf-8');
      await handle.sync();
    } finally {
      await handle?.close();
    }
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
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(tmpPath, 'w', 0o600);
      await handle.writeFile(line, 'utf-8');
      await handle.sync();
      // Close before rename — Windows can't rename an open file, and the
      // finally block would double-close if we didn't null here.
      await handle.close();
      handle = undefined;
      // Rename is inside the try so its failure also triggers temp cleanup.
      // (Found by moss self-iteration — previously rename was outside
      // try/catch, leaking a .tmp file on rename failure.)
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    } finally {
      await handle?.close();
    }
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
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async appendMessage(sessionKey: string, message: LLMMessage): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({ type: 'message', message, ts: Date.now() });
    let isNewSession = false;
    await this.enqueueWrite(filePath, async () => {
      await this.ensureDir();
      isNewSession = this.maxSessions > 0 && !(await this.fileExists(filePath));
      await this.appendLineDurably(filePath, entry + '\n');
    });
    if (isNewSession) await this.pruneOldestSessions(sessionKey);
  }

  async replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({
      type: 'state_replace',
      messages,
      ts: Date.now(),
    });
    let isNewSession = false;
    await this.enqueueWrite(filePath, async () => {
      await this.ensureDir();
      isNewSession = this.maxSessions > 0 && !(await this.fileExists(filePath));
      // Rewrite the whole file to just this snapshot instead of appending.
      // Prunes dead lines (prior snapshots + superseded messages) that would
      // otherwise accumulate: replay ignores everything before the latest
      // state_replace, so appended-but-dead bytes grew ~ history × replaces.
      await this.rewriteFileDurably(filePath, entry + '\n');
    });
    if (isNewSession) await this.pruneOldestSessions(sessionKey);
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
    try {
      const sessions = await this.listSessions();
      if (sessions.length <= this.maxSessions) return;
      const removable = sessions
        .filter((s) => s.sessionKey !== keepSessionKey)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      const removeCount = sessions.length - this.maxSessions;
      for (const session of removable.slice(0, removeCount)) {
        await this.deleteSession(session.sessionKey);
      }
    } catch {
      
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
        } catch {
          
        }
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
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
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
