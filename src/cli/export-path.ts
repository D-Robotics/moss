import path from 'node:path';

/**
 * `--out` writes inside the workspace, like every other user-visible artifact.
 * Shared by `moss runs export` and `moss sessions export` so the two cannot
 * drift on confinement.
 */
export function resolveExportOutPath(
  workspace: string,
  out: string
): { absolute: string } | { error: string } {
  const root = path.resolve(workspace);
  const absolute = path.resolve(root, out);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { error: `path must stay inside the workspace: ${out}` };
  }
  return { absolute };
}
