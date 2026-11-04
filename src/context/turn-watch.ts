/**
 * Per-turn workspace watch: external file edits + calendar rollover.
 *
 * Mining Qoder Desktop conversation logs (2026-11-04, 476 sessions under
 * ~/.qoder-cn/projects) surfaced two high-frequency runtime injections Moss
 * had no equivalent for: `edited_text_file` (a file the agent had seen
 * changed outside the agent — 213 occurrences) and `date_change` (24).
 * Both are deterministic facts rather than behavioral corrections, so they
 * ride the volatile per-turn `<turn-context>` block instead of the nudge
 * registry, and are never persisted into session history.
 *
 * External edits are detected by comparing each tracked file's mtime against
 * the session's last activity time (newest message timestamp): anything newer
 * than when the agent was last active changed while the user held the turn.
 * Files rewritten by the agent's own exec calls (builds) stay older than the
 * final message of that run and are therefore not reported.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { toolPathKeys } from './stale-read-invalidate.js';

/** Env kill-switch: MOSS_DISABLE_TURN_WATCH=1 turns the whole watch off. */
export function turnWatchEnabled(): boolean {
  return process.env.MOSS_DISABLE_TURN_WATCH !== '1';
}

/** Structural message shape so both contract and internal messages fit. */
interface TurnWatchMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  timestamp?: number;
}

export interface TouchedFile {
  /** Absolute path inside the workspace. */
  absolutePath: string;
  /** Workspace-relative display path. */
  relativePath: string;
  /** Timestamp of the newest tool result that read or wrote this file. */
  lastTouchMs: number;
}

/**
 * Every workspace file the conversation's tool calls have read or written,
 * keyed by absolute path. Device paths (`dev:` keys) are excluded — they are
 * not on this filesystem.
 */
export function collectTouchedWorkspaceFiles(
  messages: readonly TurnWatchMessage[],
  workspaceDir: string
): Map<string, TouchedFile> {
  const toolUseById = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      if (!id || !name) continue;
      const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<
        string,
        unknown
      >;
      toolUseById.set(id, { name, input });
    }
  }

  let carryTs = 0;
  const out = new Map<string, TouchedFile>();
  for (const msg of messages) {
    if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) {
      carryTs = msg.timestamp;
    }
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const meta = id ? toolUseById.get(id) : undefined;
      if (!meta) continue;
      for (const key of toolPathKeys(meta.name, meta.input)) {
        if (!key.startsWith('ws:')) continue;
        const raw = key.slice(3);
        const absolutePath = path.isAbsolute(raw) ? raw : path.resolve(workspaceDir, raw);
        const rel = path.relative(workspaceDir, absolutePath);
        if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') continue;
        const existing = out.get(absolutePath);
        if (!existing || existing.lastTouchMs < carryTs) {
          out.set(absolutePath, { absolutePath, relativePath: rel, lastTouchMs: carryTs });
        }
      }
    }
  }
  return out;
}

/** Newest message timestamp in the session, or null when none carries one. */
export function sessionLastActivityMs(messages: readonly TurnWatchMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i]?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  }
  return null;
}

export interface TurnWatchResult {
  /** Text for the volatile turn-context block, or null when nothing to say. */
  notice: string | null;
  /** Updated mtime snapshot (replaces the caller's map). */
  reportedMtimes: Map<string, number>;
  /** Local calendar date (YYYY-MM-DD) the caller should remember. */
  todayDate: string;
}

export interface TurnWatchParams {
  messages: readonly TurnWatchMessage[];
  workspaceDir: string;
  /** mtimes already reported once — suppresses repeated notices. */
  reportedMtimes: ReadonlyMap<string, number>;
  /** Last remembered local date; a difference emits a rollover line. */
  lastSeenDate?: string;
  now?: number;
}

const MTIME_EPSILON_MS = 2000;
const MAX_STAT_FILES = 128;
const MAX_REPORTED_FILES = 8;
const SNIPPET_MAX_BYTES = 256 * 1024;
const SNIPPET_MAX_CHARS = 200;

function localDateString(ms: number): string {
  const d = new Date(ms);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function sanitizeSnippet(text: string): string {
  const flat = text.replaceAll('\r', '').replaceAll('\n', ' ').replaceAll('\t', ' ');
  const printable = flat.replace(/[^\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '');
  return printable.slice(0, SNIPPET_MAX_CHARS).trim();
}

async function headSnippet(absolutePath: string): Promise<string | null> {
  try {
    const buffer = await readFile(absolutePath);
    if (buffer.length > SNIPPET_MAX_BYTES || buffer.includes(0)) return null;
    const snippet = sanitizeSnippet(buffer.toString('utf8'));
    return snippet ? `\`${snippet}\`` : null;
  } catch {
    return null;
  }
}

/**
 * Build the per-turn workspace-watch notice. Pure read of the filesystem plus
 * the caller's remembered state; never throws (best-effort, like the git
 * snapshot). Returns `notice: null` when there is nothing worth saying.
 */
export async function buildTurnWatchNotice(params: TurnWatchParams): Promise<TurnWatchResult> {
  const now = params.now ?? Date.now();
  const todayDate = localDateString(now);
  const result: TurnWatchResult = {
    notice: null,
    reportedMtimes: new Map(params.reportedMtimes),
    todayDate,
  };
  if (!turnWatchEnabled()) return result;

  const lines: string[] = [];
  if (params.lastSeenDate !== undefined && params.lastSeenDate !== todayDate) {
    lines.push(
      `- Calendar date changed since the last turn: today is ${todayDate} (previous turn was on ${params.lastSeenDate}). Use the current date for commits, reports, and time-sensitive decisions.`
    );
  }

  const lastActivity = sessionLastActivityMs(params.messages);
  if (lastActivity !== null && params.messages.length > 1) {
    const touched = [...collectTouchedWorkspaceFiles(params.messages, params.workspaceDir).values()]
      .sort((a, b) => b.lastTouchMs - a.lastTouchMs)
      .slice(0, MAX_STAT_FILES);

    const changed: Array<{ file: TouchedFile; mtimeMs: number; size: number }> = [];
    const deleted: TouchedFile[] = [];
    for (const file of touched) {
      let info;
      try {
        info = await stat(file.absolutePath);
      } catch {
        if (params.reportedMtimes.has(file.absolutePath)) deleted.push(file);
        continue;
      }
      const reported = result.reportedMtimes.get(file.absolutePath);
      result.reportedMtimes.set(file.absolutePath, info.mtimeMs);
      const isNewerThanLastActivity = info.mtimeMs > lastActivity + MTIME_EPSILON_MS;
      const alreadyReportedThisMtime = reported === info.mtimeMs;
      if (isNewerThanLastActivity && !alreadyReportedThisMtime) {
        changed.push({ file, mtimeMs: info.mtimeMs, size: info.size });
      }
    }

    const fileLines: string[] = [];
    for (const entry of changed.slice(0, MAX_REPORTED_FILES)) {
      const mtime = new Date(entry.mtimeMs).toISOString();
      const snippet = await headSnippet(entry.file.absolutePath);
      fileLines.push(
        `  - ${entry.file.relativePath} (modified ${mtime}, ${formatBytes(entry.size)})${
          snippet ? ` starts with: ${snippet}` : ''
        }`
      );
    }
    for (const file of deleted.slice(0, MAX_REPORTED_FILES - fileLines.length)) {
      fileLines.push(`  - ${file.relativePath} (deleted since it was last seen)`);
    }
    if (changed.length > MAX_REPORTED_FILES || deleted.length > 0) {
      const overflow = changed.length - Math.min(changed.length, MAX_REPORTED_FILES);
      const extra = overflow > 0 ? ` … and ${overflow} more changed file(s)` : '';
      fileLines.push(`  (list capped${extra})`);
    }
    if (fileLines.length > 0) {
      lines.push(
        '- Files changed outside this session since the agent was last active — re-read before relying on remembered content:'
      );
      lines.push(...fileLines);
    }
  }

  if (lines.length > 0) {
    result.notice = `## Workspace watch (this turn)\n${lines.join('\n')}`;
  }
  return result;
}
