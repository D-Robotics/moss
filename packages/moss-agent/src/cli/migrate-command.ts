/**
 * `moss migrate` — one-time upgrade helper for the dmoss → moss rename.
 *
 * Safe, idempotent migrations so an existing install never loses data after the
 * clean-break rename:
 *   1. Move legacy workspace runtime dirs (`.dmoss-runtime/`, `.dmoss/`) into `.moss/`.
 *   2. Rewrite legacy `<dmoss_*>` checkpoint tags inside saved session JSONL files
 *      to `<moss_*>` so paused goals and working-context checkpoints resume correctly.
 *   3. Relocate the global config dir `~/.config/dmoss` → `~/.config/moss` when the new
 *      one does not exist yet.
 *
 * Everything is best-effort: a single unreadable file is skipped, never fatal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMossWorkspacePaths, migrateLegacyWorkspacePaths } from '../utils/workspace-paths.js';
import { resolveConfigDir } from './config.js';

/** Rewrite legacy `<dmoss_*>`/`</dmoss_*>` checkpoint tags to `<moss_*>` in every JSONL file. */
function rewriteLegacySessionTags(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry);
    let before: string;
    try {
      before = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!before.includes('<dmoss_') && !before.includes('</dmoss_')) continue;
    const after = before.split('<dmoss_').join('<moss_').split('</dmoss_').join('</moss_');
    if (after !== before) {
      fs.writeFileSync(file, after);
      count++;
    }
  }
  return count;
}

/** Move `~/.config/dmoss` → `~/.config/moss` (XDG/APPDATA) when the new dir is absent. */
function migrateLegacyGlobalConfigDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const base =
    process.platform === 'win32'
      ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const legacy = path.join(base, 'dmoss');
  const modern = path.join(base, 'moss');
  if (fs.existsSync(legacy) && !fs.existsSync(modern)) {
    fs.renameSync(legacy, modern);
    return `${legacy} -> ${modern}`;
  }
  return null;
}

export function runMigrateCommand(startDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const workspace = path.resolve(startDir);
  const pathMigration = migrateLegacyWorkspacePaths(workspace);
  const globalConfigMove = migrateLegacyGlobalConfigDir(env);

  const sessionDirs = new Set<string>([
    getMossWorkspacePaths(workspace).sessionsDir,
    path.join(resolveConfigDir(env), 'sessions'),
  ]);
  let rewritten = 0;
  for (const dir of sessionDirs) rewritten += rewriteLegacySessionTags(dir);

  const lines: string[] = ['Moss migration (dmoss -> moss):'];
  if (pathMigration.migratedPaths.length === 0 && !globalConfigMove && rewritten === 0) {
    lines.push('  Nothing to migrate — already up to date.');
  } else {
    for (const moved of pathMigration.migratedPaths) lines.push(`  moved  ${moved}`);
    if (globalConfigMove) lines.push(`  moved  ${globalConfigMove}`);
    if (rewritten > 0) lines.push(`  rewrote legacy checkpoint tags in ${rewritten} session file(s)`);
    for (const skipped of pathMigration.skippedPaths) lines.push(`  skipped (destination exists)  ${skipped}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
