/**
 * Spill oversized tool output to `.moss/runtime/tool-output/` so a truncated
 * result keeps a recovery path (Cursor `file_output_threshold_bytes`).
 *
 * The exec and device_exec tools drop the middle of large output to protect
 * the context window. Without a copy on disk the omitted region is gone: the
 * command cannot be re-read, and the failure the model needs may be in it.
 * The spill file is a runtime artifact (`.moss/runtime/` is in the runtime
 * gitignore), and stale ones are pruned on each write so the directory cannot
 * grow without bound. Callers pass text already run through
 * `presentToolOutput`, so the copy cannot preserve a secret that the visible
 * result masks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureMossRuntimeGitignore } from '../utils/workspace-paths.js';
import { presentToolOutput } from '../safety/tool-output-redact.js';
import { truncateToolOutput } from './tool-output-truncate.js';

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

/** Notice that already points at a spilled copy (exec / device_exec write their own). */
export const SPILL_MARKER = '.moss/runtime/tool-output/';

export interface RecoveryPathOptions {
  toolName: string;
  input: Record<string, unknown>;
  /** Full result as the tool returned it (before context truncation). */
  text: string;
  workspaceDir: string | undefined;
}

/**
 * B09: give every truncated tool result a recovery path, not just exec.
 *
 * `truncateToolOutput` keeps head+tail to protect the context window, but the
 * elided middle used to be unrecoverable: a 40k-line log read with `read_file`
 * kept its start and end and silently lost the failure in between. When a result
 * is actually truncated, spill the presented full text and point at it. Tools
 * that wrote their own spill (the marker is in the text) are left untouched, and
 * the spill goes through the same egress filter as the visible result.
 */
export function truncateWithRecoveryPath(options: RecoveryPathOptions): string {
  const { toolName, input, text, workspaceDir } = options;
  const truncated = truncateToolOutput(toolName, text);
  if (truncated === text || !workspaceDir || text.includes(SPILL_MARKER)) return truncated;
  const spilled = spillToolOutput({
    workspaceDir,
    toolName,
    text: presentToolOutput({ toolName, input, text, workspaceDir }),
  });
  if (!spilled) return truncated;
  return (
    `${truncated}\n\n[full output saved to ${spilled} — the middle of this result was elided ` +
    'to protect the context window; read the file with read_file (offset/limit) or grep when the ' +
    'missing region matters.]'
  );
}
