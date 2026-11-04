/**
 * Spill oversized tool output to `.moss/runtime/tool-output/` so a truncated
 * result keeps a recovery path (Cursor `file_output_threshold_bytes`).
 *
 * The exec and device_exec tools drop the middle of large output to protect
 * the context window. Without a copy on disk the omitted region is gone: the
 * command cannot be re-read, and the failure the model needs may be in it.
 * The spill file is a runtime artifact (`.moss/runtime/` is in the runtime
 * gitignore), and stale ones are pruned on each write so the directory cannot
 * grow without bound.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureMossRuntimeGitignore } from '../utils/workspace-paths.js';

/** Refuse to write a spill larger than this; the note then has no recovery path. */
export const SPILL_MAX_BYTES = 4 * 1024 * 1024;
/** Spills older than this are removed when a new one is written. */
export const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function oneLineSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'output';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').replace('Z', '');
}

function pruneOldSpills(dir: string, now: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > SPILL_RETENTION_MS) fs.rmSync(file, { force: true });
    } catch {}
  }
}

export interface SpillToolOutputOptions {
  workspaceDir: string;
  /** Tool that produced the text; becomes the file-name prefix. */
  toolName: string;
  text: string;
}

/**
 * Write the full text and return its workspace-relative path, or null when the
 * text is too large or the write failed. Never throws: a spill is a recovery
 * aid, and the truncated result must still reach the model.
 */
export function spillToolOutput(options: SpillToolOutputOptions): string | null {
  const { workspaceDir, toolName, text } = options;
  if (!workspaceDir || !text || Buffer.byteLength(text, 'utf8') > SPILL_MAX_BYTES) return null;
  const dir = path.join(workspaceDir, '.moss', 'runtime', 'tool-output');
  try {
    ensureMossRuntimeGitignore(workspaceDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${oneLineSlug(toolName)}-${timestamp()}.txt`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    pruneOldSpills(dir, Date.now());
    return path.relative(workspaceDir, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}
