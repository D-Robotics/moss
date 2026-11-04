/**
 * Persisted sub-agent conversations (backlog B11).
 *
 * `create_subagent` used to return only a final summary: the child's turns were
 * dropped, so a follow-up meant re-running the task from scratch with no memory
 * of what it already read. Claude Code and Cursor keep the sub-agent's
 * conversation addressable by id and let the parent continue it.
 *
 * The transcript is a runtime artifact (`.moss/runtime/` is gitignored): one
 * JSONL file per sub-agent, a meta line first, then the conversation messages.
 * It is written once when the child finishes and read by `subagent_resume`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import type { Message } from '../session/session-jsonl.js';

export interface SubagentTranscriptMeta {
  /** Task id (background) or runId (foreground) that owns this transcript. */
  id: string;
  task: string;
  scope: string;
  model?: string;
  maxTurns?: number;
  savedAt: number;
}

export interface StoredSubagentTranscript {
  meta: SubagentTranscriptMeta;
  messages: Message[];
}

/** A transcript larger than this is not stored; resume then reports it missing. */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function transcriptDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.moss', 'runtime', 'subagents');
}

/** File names are derived from ids, never trusted as paths. */
function safeId(id: string): string {
  const cleaned = id
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 160);
  return cleaned || 'subagent';
}

function transcriptPath(workspaceDir: string, id: string): string {
  return path.join(transcriptDir(workspaceDir), `${safeId(id)}.jsonl`);
}

/**
 * Write `messages` and the metadata needed to continue the child. Returns the
 * workspace-relative path, or null when the transcript is too large or the
 * write failed — resume then says out loud that the conversation is unavailable
 * instead of pretending the child remembers.
 */
export function saveSubagentTranscript(options: {
  workspaceDir: string;
  id: string;
  meta: Omit<SubagentTranscriptMeta, 'id' | 'savedAt'>;
  messages: readonly Message[];
}): string | null {
  const { workspaceDir, id, meta, messages } = options;
  if (!workspaceDir || !id || messages.length === 0) return null;
  const lines = [
    JSON.stringify({ type: 'meta', ...meta, id, savedAt: Date.now() }),
    ...messages.map((message) => JSON.stringify({ type: 'message', message })),
  ];
  const body = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(body, 'utf8') > MAX_TRANSCRIPT_BYTES) return null;
  try {
    ensureMossRuntimeGitignore(workspaceDir);
    fs.mkdirSync(transcriptDir(workspaceDir), { recursive: true, mode: 0o700 });
    const file = transcriptPath(workspaceDir, id);
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    return path.relative(workspaceDir, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}

/** Load a stored conversation by task id or runId; null when absent/unreadable. */
export function loadSubagentTranscript(
  workspaceDir: string,
  id: string
): StoredSubagentTranscript | null {
  if (!workspaceDir || !id) return null;
  let text: string;
  try {
    text = fs.readFileSync(transcriptPath(workspaceDir, id), 'utf8');
  } catch {
    return null;
  }
  let meta: SubagentTranscriptMeta | undefined;
  const messages: Message[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type === 'meta') {
      meta = record as unknown as SubagentTranscriptMeta;
    } else if (record.type === 'message' && record.message) {
      messages.push(record.message as Message);
    }
  }
  if (!meta || messages.length === 0) return null;
  return { meta, messages };
}

/** All stored transcripts, newest first (diagnostics and tests). */
export function listSubagentTranscripts(workspaceDir: string): SubagentTranscriptMeta[] {
  const dir = transcriptDir(workspaceDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const metas: SubagentTranscriptMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    const stored = loadSubagentTranscript(workspaceDir, id);
    if (stored) metas.push(stored.meta);
  }
  return metas.sort((a, b) => b.savedAt - a.savedAt);
}
