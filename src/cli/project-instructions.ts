import fs from 'node:fs';
import path from 'node:path';

/**
 * Project instructions — the workspace-level system prompt layer.
 *
 * The CLI has advertised auto-loaded project instructions since v0.14. This
 * module loads `AGENTS.md` / `CLAUDE.md` from the workspace, its ancestor
 * directories up to the repository root (the nearest `.git` marker), and the
 * user-level config directory (`<configDir>/AGENTS.md`). Layering matches how
 * Cursor and Claude Code treat instructions as a memory file: user-wide
 * preferences at the bottom, repo-wide conventions above them, directory
 * specifics closest to the code. Loaded once per process at agent init, after
 * the environment layer and before the runtime capability layers, so every turn
 * (chat, /task, sub-agents inheriting the parent prompt) sees the project's
 * build/test commands, layout and conventions.
 */

/** Per-file cap: a project file beyond this is truncated with an explicit notice. */
export const PROJECT_INSTRUCTION_MAX_FILE_BYTES = 32 * 1024;
/** Total cap across every loaded project instruction file. */
export const PROJECT_INSTRUCTION_MAX_TOTAL_BYTES = 48 * 1024;
/** Back-compat alias for the single-file cap's previous name. */
export const AGENTS_MD_MAX_BYTES = PROJECT_INSTRUCTION_MAX_FILE_BYTES;

/** Candidate file names in priority order; one file per directory is loaded. */
const CANDIDATES = ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md'] as const;

/** Walk at most this many ancestors looking for the repository root. */
const MAX_ANCESTOR_DEPTH = 12;

export interface ProjectInstructionOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /**
   * User-level instruction directory (the CLI config dir, e.g. `~/.moss`). Its
   * `AGENTS.md`/`CLAUDE.md` applies to every workspace and is rendered first so
   * project files override it. Skipped when it equals the workspace.
   */
  userDir?: string;
}

interface LoadedInstruction {
  file: string;
  dir: string;
  label: string;
  text: string;
  truncated: boolean;
  droppedKb: number;
}

/** The first candidate instruction file present in `dir`, if any. */
export function findAgentsMdPath(dir: string): string | undefined {
  for (const name of CANDIDATES) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not present — try the next spelling
    }
  }
  return undefined;
}

/** The nearest directory at or above `start` that contains a `.git` marker. */
export function findRepositoryRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      // unreadable directory — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Directories whose instruction files apply, outermost first: the repository
 * root (when one is found) down to the workspace itself. Without a repository
 * marker only the workspace is used, so a stray `$HOME/AGENTS.md` is never
 * injected into an unrelated project.
 */
export function collectInstructionDirs(workspaceDir: string): string[] {
  const workspace = path.resolve(workspaceDir);
  const repoRoot = findRepositoryRoot(workspace);
  if (!repoRoot) return [workspace];
  const chain: string[] = [];
  let dir = workspace;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    chain.push(dir);
    if (dir === repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.reverse();
}

function labelFor(dir: string, workspace: string): string {
  if (dir === workspace) return 'workspace';
  const rel = path.relative(dir, workspace).split(path.sep).join('/');
  return rel ? `ancestor:${rel}` : 'ancestor';
}

function readInstructionFile(
  file: string,
  maxFileBytes: number
): { text: string; truncated: boolean; droppedKb: number } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes <= maxFileBytes) return { text: trimmed, truncated: false, droppedKb: 0 };
  const kept = Buffer.from(trimmed, 'utf8').subarray(0, maxFileBytes).toString('utf8');
  // A cut can land mid-code-unit: drop the trailing replacement char it would
  // produce rather than shipping a broken glyph into the prompt.
  const safe = kept.endsWith('\ufffd') ? kept.slice(0, -1) : kept;
  return {
    text: safe,
    truncated: true,
    droppedKb: Math.round((bytes - maxFileBytes) / 1024),
  };
}

/**
 * The prompt layer for the workspace's project instructions, or '' when there
 * are none. Oversized files are cut at the byte cap with a visible notice —
 * silent truncation would let the model assume it saw conventions it did not.
 */
export function buildAgentsMdLayer(
  workspaceDir: string,
  options: ProjectInstructionOptions = {}
): string {
  const maxFileBytes = options.maxFileBytes ?? PROJECT_INSTRUCTION_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? PROJECT_INSTRUCTION_MAX_TOTAL_BYTES;
  const workspace = path.resolve(workspaceDir);
  const dirs = collectInstructionDirs(workspace);
  const userDir = options.userDir ? path.resolve(options.userDir) : undefined;
  // User-level instructions sit below every project file: they are loaded last
  // (lowest budget priority) and rendered first (lowest precedence).
  const userLayer =
    userDir && userDir !== workspace && !dirs.includes(userDir) ? userDir : undefined;
  // Budget is spent from the most specific directory outward so workspace
  // instructions are never dropped in favour of a distant ancestor.
  const loaded: LoadedInstruction[] = [];
  let totalBytes = 0;
  let skipped = 0;
  const budgetOrder = [...dirs].reverse();
  if (userLayer) budgetOrder.push(userLayer);
  for (const dir of budgetOrder) {
    const file = findAgentsMdPath(dir);
    if (!file) continue;
    const read = readInstructionFile(file, maxFileBytes);
    if (!read) continue;
    const bytes = Buffer.byteLength(read.text, 'utf8');
    if (totalBytes + bytes > maxTotalBytes) {
      skipped += 1;
      continue;
    }
    totalBytes += bytes;
    loaded.push({
      file,
      dir,
      label: dir === userLayer ? 'user' : labelFor(dir, workspace),
      text: read.text,
      truncated: read.truncated,
      droppedKb: read.droppedKb,
    });
  }
  if (loaded.length === 0) return '';
  // Render from the outermost directory inward: the most specific instructions
  // sit closest to the conversation tail.
  loaded.reverse();
  const capKb = Math.floor(maxFileBytes / 1024);
  const skippedNote =
    skipped > 0
      ? ` — ${skipped} file(s) skipped over the ${Math.floor(maxTotalBytes / 1024)}KB total cap`
      : '';
  if (loaded.length === 1) {
    const only = loaded[0]!;
    const label = only.label === 'workspace' ? '' : ` (${only.label})`;
    if (!only.truncated) {
      return `[Project instructions — ${path.basename(only.file)}${label}${skippedNote}]\n${only.text}`;
    }
    return (
      `[Project instructions — ${path.basename(only.file)}${label} (truncated, ~${only.droppedKb}KB dropped — ` +
      `edit the file under ${capKb}KB to load it fully)${skippedNote}]\n${only.text}`
    );
  }
  const names = loaded.map((entry) => `${path.basename(entry.file)} (${entry.label})`).join(', ');
  const sections = loaded.map((entry) => {
    const suffix = entry.truncated ? ` [truncated, ~${entry.droppedKb}KB dropped]` : '';
    const separator = `--- ${path.basename(entry.file)} (${entry.label})${suffix} ---`;
    return `${separator}\n${entry.text}`;
  });
  return (
    `[Project instructions — ${loaded.length} files: ${names}${skippedNote}]\n\n` +
    sections.join('\n\n')
  );
}
