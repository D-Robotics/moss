import fs from 'node:fs/promises';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { errorMessage } from '../errors.js';

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
export class ToolStateManager {
  private readonly fileReadState = new Map<string, number>();

  async recordFileState(resolvedPath: string): Promise<void> {
    try {
      const st = await fs.stat(resolvedPath);
      this.fileReadState.set(resolvedPath, st.mtimeMs);
    } catch {
      // File may not exist yet; ignore
    }
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
  return new Error(`${prefix}: ${errorMessage(err)}`);
}


export const LINE_NUMBER_WIDTH = 6;


export function withLineNumbers(text: string, startLine = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(LINE_NUMBER_WIDTH)}\t${line}`)
    .join('\n');
}

