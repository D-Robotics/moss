




















import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireSessionWriteLock } from './session-write-lock.js';
import { atomicWriteFile } from '../../utils/atomic-write.js';
import {
  COMPACTION_SUMMARY_PREFIX,
  CURRENT_SESSION_VERSION,
  createCompactionSummaryMessage,
  type CompactionEntry,
  type Message,
  type MessageEntry,
  type SessionEntry,
  type SessionHeaderEntry,
} from './session-jsonl-types.js';
import { formatJsonlLine, loadSessionFile } from './session-jsonl-codec.js';




const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;



export class SessionManager {
  
  private baseDir: string;

  
  private states = new Map<string, SessionState>();

  
  private static readonly MAX_CACHED_SESSIONS = 100;
  
  private static readonly MAX_CACHED_SESSIONS_BYTES = 100 * 1024 * 1024;
  private sessionLastAccess = new Map<string, number>();
  private sessionApproxBytes = new Map<string, number>();
  private loadingPromises = new Map<string, Promise<SessionState>>();

  constructor(baseDir: string = './.moss/sessions') {
    this.baseDir = baseDir;
  }

  private estimateStateBytes(state: SessionState): number {
    
    return state.entries.length * 512; 
  }

  private touchSessionKey(sessionKey: string, state?: SessionState) {
    this.sessionLastAccess.set(sessionKey, Date.now());
    if (state) {
      this.sessionApproxBytes.set(sessionKey, this.estimateStateBytes(state));
    }
  }

  private async evictSessionCacheIfNeeded() {
    const maxCount = SessionManager.MAX_CACHED_SESSIONS;
    const maxBytes = SessionManager.MAX_CACHED_SESSIONS_BYTES;

    let totalBytes = 0;
    for (const bytes of this.sessionApproxBytes.values()) totalBytes += bytes;

    if (this.states.size <= maxCount && totalBytes <= maxBytes) return;

    const byAccess = [...this.sessionLastAccess.entries()].sort((a, b) => a[1] - b[1]);
    let overCount = Math.max(0, this.states.size - maxCount);
    let overBytes = Math.max(0, totalBytes - maxBytes);

    for (const [key] of byAccess) {
      if (overCount <= 0 && overBytes <= 0) break;
      const evictState = this.states.get(key);
      if (evictState && !evictState.flushed) {
        
        try {
          await rewriteSessionFile(evictState, this.baseDir);
        } catch {
          
        }
      }
      const evictBytes = this.sessionApproxBytes.get(key) ?? 0;
      if (this.states.delete(key)) {
        this.sessionLastAccess.delete(key);
        this.sessionApproxBytes.delete(key);
        overCount--;
        overBytes -= evictBytes;
      }
    }
  }

  





  private getPath(sessionKey: string): string {
    const safeId = encodeURIComponent(sessionKey);
    return path.join(this.baseDir, `${safeId}.jsonl`);
  }

  private getLegacyPath(sessionKey: string): string {
    const safeId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${safeId}.jsonl`);
  }

  private createHeader(): SessionHeaderEntry {
    return {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
  }

  





  async load(sessionKey: string): Promise<Message[]> {
    const state = await this.ensureState(sessionKey);
    return buildSessionContext(state);
  }

  










  async append(sessionKey: string, message: Message): Promise<void> {
    const state = await this.ensureState(sessionKey);

    const entry: MessageEntry = {
      type: 'message',
      id: generateId(state.byId),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    const prevLeafId = state.leafId;
    const prevHasAssistant = state.hasAssistant;
    state.entries.push(entry);
    state.byId.set(entry.id, entry);
    state.messageIdByRef.set(message, entry.id);
    state.leafId = entry.id;
    if (message.role === 'assistant') {
      state.hasAssistant = true;
    }
    try {
      await this.persistEntry(state, entry);
    } catch (err) {
      
      state.entries.pop();
      state.byId.delete(entry.id);
      state.leafId = prevLeafId;
      state.hasAssistant = prevHasAssistant;
      
      throw err;
    }
    
    state.cachedContext = null;
    state.entryVersion++;
  }

  



  async truncateTrailingAssistant(sessionKey: string): Promise<boolean> {
    const state = await this.ensureState(sessionKey);
    if (state.leafId === null) return false;
    let changed = false;
    const removedIds = new Set<string>();
    while (true) {
      const at = state.leafId;
      if (at === null) break;
      const leaf = state.byId.get(at);
      if (!leaf || leaf.type !== 'message') break;
      if (leaf.message.role !== 'assistant') break;
      const parentId = leaf.parentId;
      removedIds.add(leaf.id);
      state.byId.delete(leaf.id);
      state.leafId = parentId;
      changed = true;
    }
    if (!changed) return false;
    if (removedIds.size > 0) {
      state.entries = state.entries.filter((e) => !removedIds.has(e.id));
    }
    state.hasAssistant = state.entries.some(
      (e) => e.type === 'message' && e.message.role === 'assistant'
    );
    // Mutation changed the message tree: any cached context is now stale.
    state.cachedContext = null;
    await rewriteSessionFile(state, this.baseDir);
    state.flushed = true;
    return true;
  }

  




  async truncateForRegenerate(
    sessionKey: string,
    anchorProcessedUserContent: string
  ): Promise<boolean> {
    const anchor = anchorProcessedUserContent.trim();
    if (!anchor) {
      return this.truncateTrailingAssistant(sessionKey);
    }
    const msgStr = (m: Message): string => {
      const c = m.content;
      if (typeof c === 'string') return c;
      return JSON.stringify(c);
    };
    const state = await this.ensureState(sessionKey);
    if (state.leafId === null) return false;

    let foundAnchor = false;
    {
      let cur: SessionEntry | undefined = state.byId.get(state.leafId);
      while (cur) {
        if (
          cur.type === 'message' &&
          cur.message.role === 'user' &&
          msgStr(cur.message).trim() === anchor
        ) {
          foundAnchor = true;
          break;
        }
        cur = cur.parentId ? state.byId.get(cur.parentId) : undefined;
      }
    }
    if (!foundAnchor) {
      return this.truncateTrailingAssistant(sessionKey);
    }

    let changed = false;
    let guard = 0;
    const maxGuard = 4096;
    const removedIds = new Set<string>();
    while (state.leafId !== null && guard++ < maxGuard) {
      const at = state.leafId;
      const leaf = state.byId.get(at);
      if (!leaf || leaf.type !== 'message') break;
      if (leaf.message.role === 'user' && msgStr(leaf.message).trim() === anchor) {
        break;
      }
      const parentId = leaf.parentId;
      removedIds.add(leaf.id);
      state.byId.delete(leaf.id);
      state.leafId = parentId;
      changed = true;
    }
    if (!changed) return false;
    if (removedIds.size > 0) {
      state.entries = state.entries.filter((e) => !removedIds.has(e.id));
    }
    state.hasAssistant = state.entries.some(
      (e) => e.type === 'message' && e.message.role === 'assistant'
    );
    // Mutation changed the message tree: any cached context is now stale.
    state.cachedContext = null;
    await rewriteSessionFile(state, this.baseDir);
    state.flushed = true;
    return true;
  }

  


  async appendCompaction(
    sessionKey: string,
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number
  ): Promise<void> {
    const state = await this.ensureState(sessionKey);
    const entry: CompactionEntry = {
      type: 'compaction',
      id: generateId(state.byId),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    const prevLeafId = state.leafId;
    const prevHasAssistant = state.hasAssistant;
    state.entries.push(entry);
    state.byId.set(entry.id, entry);
    state.leafId = entry.id;
    // Invalidate cache BEFORE the await — the tree is already mutated, so any
    // concurrent reader during persistEntry's await would return the stale
    // pre-compaction snapshot. (Found by moss self-iteration — glm-5.2
    // reviewed this file. The truncate methods already do this correctly;
    // appendCompaction was the inconsistency.)
    state.cachedContext = null;
    try {
      await this.persistEntry(state, entry);
    } catch (err) {
      state.entries.pop();
      state.byId.delete(entry.id);
      state.leafId = prevLeafId;
      state.hasAssistant = prevHasAssistant;
      // Cache was already nulled above; on rollback the old cache is invalid
      // (tree was mutated then restored), so keep it null to force recompute.
      state.cachedContext = null;
      throw err;
    }
  }

  




  resolveMessageEntryId(sessionKey: string, message: Message): string | undefined {
    if (typeof message.content === 'string') {
      const trimmed = message.content.trimStart();
      if (trimmed.startsWith(COMPACTION_SUMMARY_PREFIX)) {
        return undefined;
      }
    }
    const state = this.states.get(sessionKey);
    if (!state) {
      return undefined;
    }
    const direct = state.messageIdByRef.get(message);
    if (direct) {
      return direct;
    }
    for (const entry of state.entries) {
      if (entry.type !== 'message') continue;
      if (entry.message.timestamp === message.timestamp && entry.message.role === message.role) {
        return entry.id;
      }
    }
    return undefined;
  }

  



  get(sessionKey: string): Message[] {
    const state = this.states.get(sessionKey);
    if (!state) {
      return [];
    }
    return buildSessionContext(state);
  }

  



  async clear(sessionKey: string): Promise<void> {
    
    const state = this.states.get(sessionKey);
    this.states.delete(sessionKey);
    this.sessionLastAccess.delete(sessionKey);
    this.sessionApproxBytes.delete(sessionKey);

    
    const filePath = this.getPath(sessionKey);
    if (state) {
      const lock = await acquireSessionWriteLock({ sessionFile: filePath });
      try {
        await fs.unlink(filePath).catch(() => {});
        const legacyPath = this.getLegacyPath(sessionKey);
        if (legacyPath !== filePath) await fs.unlink(legacyPath).catch(() => {});
      } finally {
        await lock.release();
      }
    } else {
      try {
        await fs.unlink(filePath);
      } catch {
        
      }
      try {
        const legacyPath = this.getLegacyPath(sessionKey);
        if (legacyPath !== filePath) await fs.unlink(legacyPath);
      } catch {
        
      }
    }
  }

  



  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.baseDir);
      return files
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => {
          try {
            return decodeURIComponent(f.replace('.jsonl', ''));
          } catch {
            return f.replace('.jsonl', '');
          }
        });
    } catch {
      return [];
    }
  }

  private async ensureState(sessionKey: string): Promise<SessionState> {
    const cached = this.states.get(sessionKey);
    if (cached) {
      this.touchSessionKey(sessionKey, cached);
      return cached;
    }

    
    const inflight = this.loadingPromises.get(sessionKey);
    if (inflight) return inflight;

    const loadPromise = this.loadAndCacheState(sessionKey);
    this.loadingPromises.set(sessionKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.loadingPromises.delete(sessionKey);
    }
  }

  private async loadAndCacheState(sessionKey: string): Promise<SessionState> {
    const filePath = this.getPath(sessionKey);
    const legacyPath = this.getLegacyPath(sessionKey);
    let chosenPath = filePath;
    let state: SessionState | undefined;

    try {
      const loaded = await loadSessionFile(filePath);
      if (loaded.header) {
        state = buildStateFromEntries(filePath, loaded.header, loaded.entries);
      } else if (loaded.legacyMessages) {
        state = buildStateFromLegacy(filePath, loaded.legacyMessages);
        if (state.hasAssistant || state.entries.length > 0) {
          await rewriteSessionFile(state, this.baseDir);
          state.flushed = true;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (!state) {
      try {
        const loaded = await loadSessionFile(legacyPath);
        if (loaded.header) {
          chosenPath = legacyPath;
          state = buildStateFromEntries(legacyPath, loaded.header, loaded.entries);
        } else if (loaded.legacyMessages) {
          chosenPath = legacyPath;
          state = buildStateFromLegacy(legacyPath, loaded.legacyMessages);
          if (state.hasAssistant || state.entries.length > 0) {
            await rewriteSessionFile(state, this.baseDir);
            state.flushed = true;
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    if (!state) {
      const header = this.createHeader();
      state = {
        filePath: chosenPath,
        header,
        entries: [],
        byId: new Map<string, SessionEntry>(),
        messageIdByRef: new WeakMap<Message, string>(),
        leafId: null,
        flushed: false,
        hasAssistant: false,
        cachedContext: null,
        entryVersion: 0,
      };
    }

    this.states.set(sessionKey, state);
    this.touchSessionKey(sessionKey, state);
    await this.evictSessionCacheIfNeeded();
    return state;
  }

  private async persistEntry(state: SessionState, entry: SessionEntry): Promise<void> {
    
    const hasUserMessage = state.entries.some(
      (e) => e.type === 'message' && e.message.role === 'user'
    );
    if (!state.hasAssistant && !hasUserMessage) {
      return;
    }
    const lock = await acquireSessionWriteLock({ sessionFile: state.filePath });
    try {
      if (!state.flushed) {
        await rewriteSessionFile(state, this.baseDir, { skipLock: true });
        state.flushed = true;
        return;
      }
      await fs.mkdir(this.baseDir, { recursive: true });
      const fh = await fs.open(state.filePath, 'a');
      try {
        await fh.write(`${formatJsonlLine(entry)}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } finally {
      await lock.release();
    }
  }
}

type SessionState = {
  filePath: string;
  header: SessionHeaderEntry;
  entries: SessionEntry[];
  byId: Map<string, SessionEntry>;
  messageIdByRef: WeakMap<Message, string>;
  leafId: string | null;
  flushed: boolean;
  hasAssistant: boolean;
  




  cachedContext: Message[] | null;
  
  entryVersion: number;
};

function generateId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return crypto.randomUUID();
}

function buildSessionContext(state: SessionState): Message[] {
  if (state.cachedContext !== null) {
    return state.cachedContext;
  }

  if (state.entries.length === 0) {
    state.cachedContext = [];
    return [];
  }

  if (state.leafId === null) {
    state.cachedContext = [];
    return [];
  }

  const leaf = state.leafId
    ? state.byId.get(state.leafId)
    : state.entries[state.entries.length - 1];
  if (!leaf) {
    state.cachedContext = [];
    return [];
  }

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? state.byId.get(current.parentId) : undefined;
  }
  path.reverse();

  let compaction: CompactionEntry | null = null;
  for (const entry of path) {
    if (entry.type === 'compaction') {
      compaction = entry;
    }
  }

  const messages: Message[] = [];
  const appendMessage = (entry: SessionEntry) => {
    if (entry.type === 'message') {
      messages.push(entry.message);
    }
  };

  if (compaction) {
    messages.push(createCompactionSummaryMessage(compaction.summary, compaction.timestamp));
    const compactionIdx = path.findIndex(
      (entry) => entry.type === 'compaction' && entry.id === compaction.id
    );
    
    
    
    
    const firstKeptExists = path
      .slice(0, compactionIdx < 0 ? 0 : compactionIdx)
      .some((entry) => entry.id === compaction.firstKeptEntryId);
    let foundFirstKept = !firstKeptExists;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        appendMessage(entry);
      }
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      appendMessage(path[i]);
    }
  } else {
    for (const entry of path) {
      appendMessage(entry);
    }
  }

  state.cachedContext = messages;
  return messages;
}

function buildStateFromEntries(
  filePath: string,
  header: SessionHeaderEntry,
  entries: SessionEntry[]
): SessionState {
  const byId = new Map<string, SessionEntry>();
  const messageIdByRef = new WeakMap<Message, string>();
  let leafId: string | null = null;
  let hasAssistant = false;

  for (const entry of entries) {
    byId.set(entry.id, entry);
    leafId = entry.id;
    if (entry.type === 'message') {
      messageIdByRef.set(entry.message, entry.id);
      if (entry.message.role === 'assistant') {
        hasAssistant = true;
      }
    }
  }

  return {
    filePath,
    header,
    entries,
    byId,
    messageIdByRef,
    leafId,
    flushed: true,
    hasAssistant,
    cachedContext: null,
    entryVersion: entries.length,
  };
}

function buildStateFromLegacy(filePath: string, messages: Message[]): SessionState {
  const header = {
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  } satisfies SessionHeaderEntry;
  const entries: SessionEntry[] = [];
  const byId = new Map<string, SessionEntry>();
  const messageIdByRef = new WeakMap<Message, string>();
  let leafId: string | null = null;
  let hasAssistant = false;

  for (const message of messages) {
    const entry: MessageEntry = {
      type: 'message',
      id: generateId(byId),
      parentId: leafId,
      timestamp: new Date().toISOString(),
      message: {
        role: message.role,
        content: message.content,
        timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
        ...(message.thinking && message.thinking.length > 0
          ? { thinking: [...message.thinking] }
          : {}),
      },
    };
    entries.push(entry);
    byId.set(entry.id, entry);
    messageIdByRef.set(entry.message, entry.id);
    leafId = entry.id;
    if (entry.message.role === 'assistant') {
      hasAssistant = true;
    }
  }

  return {
    filePath,
    header,
    entries,
    byId,
    messageIdByRef,
    leafId,
    flushed: false,
    hasAssistant,
    cachedContext: null,
    entryVersion: entries.length,
  };
}

async function rewriteSessionFile(
  state: SessionState,
  baseDir: string,
  opts?: { skipLock?: boolean }
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });

  const allEntries = [state.header, ...state.entries];
  let lines = allEntries.map((entry) => formatJsonlLine(entry));
  let content = `${lines.join('\n')}\n`;

  
  
  if (Buffer.byteLength(content, 'utf-8') > MAX_SESSION_FILE_BYTES && allEntries.length > 1) {
    const headerLine = lines[0];
    const headerSize = Buffer.byteLength(headerLine, 'utf-8') + 1; 
    let used = headerSize;
    const kept: string[] = [];
    
    for (let i = lines.length - 1; i >= 1; i--) {
      const lineSize = Buffer.byteLength(lines[i], 'utf-8') + 1; 
      if (used + lineSize > MAX_SESSION_FILE_BYTES) break;
      kept.unshift(lines[i]);
      used += lineSize;
    }
    lines = [headerLine, ...kept];
    content = `${lines.join('\n')}\n`;

    
    while (Buffer.byteLength(content, 'utf-8') > MAX_SESSION_FILE_BYTES && kept.length > 0) {
      kept.shift();
      lines = [headerLine, ...kept];
      content = `${lines.join('\n')}\n`;
    }

    
    try {
      await fs.rename(state.filePath, `${state.filePath}.1`);
    } catch {
      
    }
  }

  if (opts?.skipLock) {
    await atomicWriteFile(state.filePath, content);
    return;
  }
  const lock = await acquireSessionWriteLock({ sessionFile: state.filePath });
  try {
    await atomicWriteFile(state.filePath, content);
  } finally {
    await lock.release();
  }
}
