import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a tool installed under some ancestor `node_modules`.
 *
 * The verify stages assume a standalone checkout where `node_modules/` lives at
 * the repo root. When Moss is consumed as an npm workspace (for example RDK
 * Studio installs it as `file:external/moss`), package managers hoist the
 * toolchain to the consuming repo root, so `<moss>/node_modules/typescript`
 * does not exist even though `typescript` is installed and resolvable.
 *
 * Walk up from `startDir` until a match is found; return `null` when the tool
 * is genuinely missing so callers keep their own error/skip behavior.
 */
export function resolveNodeModulesTool(startDir, ...segments) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...segments);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
