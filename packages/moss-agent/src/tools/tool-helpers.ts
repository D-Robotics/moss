import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { errorMessage, isMossError, MossError } from '../errors.js';

export const IS_WIN = process.platform === 'win32';

export const EXEC_DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MOSS_EXEC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

/**
 * ToolStateManager — encapsulates mutable state shared across tools.
 *
 * Tracks file read timestamps to detect stale writes (when a file is modified
 * between read and write operations). Previously this was module-level state;
 * now it's an instance, enabling per-agent or per-session state isolation.
 */
/** Claude Code FileRead "unchanged since last read" stub — saves context. */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.';

export class ToolStateManager {
  private readonly fileReadState = new Map<string, number>();
  /** Last read window per path (`full` or `offset:limit`) for unchanged stubs. */
  private readonly fileReadRange = new Map<string, string>();

  async recordFileState(resolvedPath: string, rangeKey = 'full'): Promise<void> {
    try {
      const st = await fs.stat(resolvedPath);
      this.fileReadState.set(resolvedPath, st.mtimeMs);
      this.fileReadRange.set(resolvedPath, rangeKey);
    } catch {
      // File may not exist yet; ignore
    }
  }

  /** True when read_file (or a successful write/edit) recorded this path. */
  hasRecorded(resolvedPath: string): boolean {
    return this.fileReadState.has(resolvedPath);
  }

  /**
   * Claude Code FileRead parity: when the file mtime and the requested window
   * match the last successful read, the full body is still in context — return
   * a short stub instead of re-dumping the file (token + latency win).
   */
  async unchangedSinceLastRead(resolvedPath: string, rangeKey = 'full'): Promise<boolean> {
    const seen = this.fileReadState.get(resolvedPath);
    if (seen === undefined) return false;
    if ((this.fileReadRange.get(resolvedPath) ?? 'full') !== rangeKey) return false;
    try {
      const current = (await fs.stat(resolvedPath)).mtimeMs;
      return Math.abs(current - seen) < 1;
    } catch {
      return false;
    }
  }

  /**
   * Claude Code FileEdit parity: require a prior *full-file* read (or a
   * successful write/edit that re-stamps `full`) before surgical edit.
   * A partial offset/limit page does not unlock full-file old_string matching
   * — that was a thrash hole (edit outside the paged window → miss → retry).
   */
  requirePriorReadError(resolvedPath: string, displayPath: string): string | null {
    if (!this.hasRecorded(resolvedPath)) {
      return (
        `You must call read_file on ${displayPath} at least once before editing it. ` +
        `Read the current contents (full file, or omit offset/limit), then retry the edit with an exact old_string match.`
      );
    }
    const range = this.fileReadRange.get(resolvedPath) ?? 'full';
    if (range !== 'full') {
      return (
        `You only read a partial window of ${displayPath} (${range}). ` +
        `Call read_file again without offset/limit (full file) before edit_file/multi_edit/apply_patch, ` +
        `so old_string can match anywhere in the file.`
      );
    }
    return null;
  }

  async staleWriteError(resolvedPath: string, displayPath: string): Promise<string | null> {
    const seen = this.fileReadState.get(resolvedPath);
    if (seen === undefined) return null;
    let current: number;
    try {
      current = (await fs.stat(resolvedPath)).mtimeMs;
    } catch {
      return null; // File deleted or inaccessible
    }
    if (current > seen + 1) {
      return (
        `File has been modified since you last read it: ${displayPath}. ` +
        `Another process (editor, linter, or a concurrent task) changed it on disk. ` +
        `Read it again to get the current contents before writing, so you do not overwrite those changes.`
      );
    }
    return null;
  }

  clearFileState(): void {
    this.fileReadState.clear();
    this.fileReadRange.clear();
  }

  /**
   * Drop prior-read credit for one path so the next surgical edit must
   * re-read. Used after old_string miss / failed multi_edit so the model
   * cannot thrash the same unread snapshot (Claude FileEdit discipline).
   */
  invalidateFileState(resolvedPath: string): void {
    this.fileReadState.delete(resolvedPath);
    this.fileReadRange.delete(resolvedPath);
  }
}

/**
 * Claude Code findSimilarFile parity: when a path is missing, suggest a
 * similarly named sibling in the same directory (case/extension drift).
 */
export async function findSimilarFileName(
  missingPath: string,
  workspaceDir: string
): Promise<string | null> {
  try {
    const abs = path.isAbsolute(missingPath)
      ? missingPath
      : path.resolve(workspaceDir, missingPath);
    const dir = path.dirname(abs);
    const base = path.basename(abs).toLowerCase();
    const baseNoExt = base.replace(/\.[^.]+$/, '');
    // Normalize separators so authService ≈ auth-service ≈ auth_service
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseNorm = norm(baseNoExt);
    if (baseNorm.length < 3) return null;
    const entries = await fs.readdir(dir);
    const scored: Array<{ name: string; score: number }> = [];
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (lower === base) continue;
      const otherNoExt = lower.replace(/\.[^.]+$/, '');
      const otherNorm = norm(otherNoExt);
      let score = 0;
      if (otherNorm === baseNorm) score = 95;
      else if (otherNorm.includes(baseNorm) || baseNorm.includes(otherNorm)) score = 70;
      else if (
        otherNorm.startsWith(baseNorm.slice(0, Math.min(5, baseNorm.length))) ||
        baseNorm.startsWith(otherNorm.slice(0, Math.min(5, otherNorm.length)))
      ) {
        score = 40;
      }
      if (score > 0) scored.push({ name, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const hit = scored[0];
    if (!hit || hit.score < 60) return null;
    const rel = path.relative(workspaceDir, path.join(dir, hit.name)).split(path.sep).join('/');
    return rel || hit.name;
  } catch {
    return null;
  }
}

// Global instance for now; enables future injection per agent/session
export const globalToolStateManager = new ToolStateManager();

export function childEnv(_workspaceDir: string): Record<string, string> {
  return safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' });
}

export async function safePath(inputPath: string, workspaceDir: string): Promise<string> {
  const { resolved } = await assertSandboxPath({
    filePath: inputPath,
    cwd: workspaceDir,
    root: workspaceDir,
  });
  return resolved;
}

export function toolError(prefix: string, err: unknown): Error {
  if (isMossError(err)) {
    return new MossError({
      code: err.code,
      message: `${prefix}: ${err.message}`,
      hint: err.hint,
      recoverable: err.recoverable,
      context: err.context,
      cause: err,
    });
  }
  return new Error(`${prefix}: ${errorMessage(err)}`);
}

export const LINE_NUMBER_WIDTH = 6;

export function withLineNumbers(text: string, startLine = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(LINE_NUMBER_WIDTH)}\t${line}`)
    .join('\n');
}

/**
 * Meaningful tail lines from a failed exec/device_exec tool result for TUI rows.
 * Skips bare `exit_code: N` / section headers so users see the real error without Ctrl+O.
 */
export function extractCommandFailurePreview(resultText: string, maxLines = 4): string[] {
  const text = String(resultText ?? '');
  if (!text.trim()) return [];

  // Prefer stderr section when present.
  let body = text;
  const stderrSection = text.match(/--- stderr(?:[^\n]*)---\s*([\s\S]*)$/i);
  if (stderrSection?.[1]?.trim()) {
    body = stderrSection[1];
  }

  const rawLines = body.split('\n').map((l) => l.trimEnd());
  const candidates: string[] = [];
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const line = rawLines[i]!.trim();
    if (!line) continue;
    if (/^exit_code:\s*\d+\b/i.test(line)) continue;
    if (/^---\s*(?:stdout|stderr)/i.test(line)) continue;
    if (/^\(no output\)$/i.test(line)) continue;
    if (/chars omitted|truncated to ~/i.test(line)) continue;
    if (/^Command failed \(exit/i.test(line) && candidates.length === 0) {
      // Keep as fallback but continue looking for more specific lines first.
      candidates.push(line.length > 120 ? `${line.slice(0, 119)}…` : line);
      continue;
    }
    candidates.push(line.length > 120 ? `${line.slice(0, 119)}…` : line);
    if (candidates.length >= maxLines) break;
  }
  return candidates.reverse();
}

/**
 * Compact tail preview for successful exec/device_exec tool rows.
 * Keeps noise low: only when output is multi-line / long enough to hide useful info.
 */
export function extractCommandOutputPreview(
  resultText: string,
  options: { maxLines?: number; minChars?: number; minLines?: number } = {}
): string[] {
  const maxLines = options.maxLines ?? 3;
  const minChars = options.minChars ?? 160;
  const minLines = options.minLines ?? 4;
  const text = String(resultText ?? '').trim();
  if (!text) return [];

  // Prefer stdout body; drop stderr section for success previews (failures use extractCommandFailurePreview).
  let body = text;
  const stderrIdx = body.search(/\n--- stderr/i);
  if (stderrIdx >= 0) body = body.slice(0, stderrIdx).trim();
  body = body.replace(/^exit_code:\s*0\s*\n?/i, '').trim();
  if (!body || body === '(no output)') return [];

  const lines = body
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/^---\s*(?:stdout|stderr)/i.test(t)) return false;
      if (/chars omitted|truncated to ~/i.test(t)) return false;
      return true;
    });

  if (lines.length < minLines && body.length < minChars) return [];

  const tail = lines.slice(-maxLines).map((l) => {
    const t = l.trim();
    return t.length > 100 ? `${t.slice(0, 99)}…` : t;
  });
  // If we elided earlier lines, mark it.
  if (lines.length > maxLines) {
    return [`… ${lines.length - maxLines} earlier lines`, ...tail];
  }
  return tail;
}
