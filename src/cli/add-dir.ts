import fs from 'node:fs';
import path from 'node:path';

/**
 * Claude Code `--add-dir` parity: extra working directories for one run.
 *
 * Semantics kept deliberately narrow and honest:
 * - each entry resolves against the start workspace (absolute paths win);
 * - it must exist and be a directory — a typo should fail at startup, not
 *   silently shrink the write boundary;
 * - the stored form is the realpath, so a symlinked argument becomes the
 *   directory it points at (the sandbox itself refuses symlinked roots) and
 *   duplicates collapse;
 * - the workspace itself is dropped (it is always allowed).
 *
 * Moss does **not** load AGENTS.md / skills / commands from these directories
 * (Claude only does for `.claude/` paths, and Moss's project files are
 * workspace-scoped); the prompt layer says so instead of implying discovery.
 */
export function resolveAdditionalDirectories(
  workspaceDir: string,
  entries: readonly string[] | undefined
): string[] {
  if (!entries || entries.length === 0) return [];
  const root = fs.realpathSync(workspaceDir);
  const out: string[] = [];
  for (const entry of entries) {
    const raw = String(entry ?? '').trim();
    if (!raw) continue;
    const absolute = path.resolve(root, raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? `--add-dir directory does not exist: ${absolute}`
          : `--add-dir cannot access ${absolute}: ${(err as Error).message}`
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`--add-dir is not a directory: ${absolute}`);
    }
    const real = fs.realpathSync(absolute);
    if (real === root || out.includes(real)) continue;
    out.push(real);
  }
  return out;
}
