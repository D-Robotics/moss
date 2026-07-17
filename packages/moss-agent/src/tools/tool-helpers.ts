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
  async unchangedSinceLastRead(
    resolvedPath: string,
    rangeKey = 'full'
  ): Promise<boolean> {
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
   * Claude Code FileEdit parity: require at least one prior read_file of the
   * target before surgical edit. Prevents blind edits on unread files.
   */
  requirePriorReadError(resolvedPath: string, displayPath: string): string | null {
    if (this.hasRecorded(resolvedPath)) return null;
    return (
      `You must call read_file on ${displayPath} at least once before editing it. ` +
      `Read the current contents, then retry the edit with an exact old_string match.`
    );
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
