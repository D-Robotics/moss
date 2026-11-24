/**
 * Workspace → device sync (the "deploy the project" primitive).
 *
 * The plan is pure: given the local tree and a remote listing it decides what to
 * upload and what to delete, so the rules are testable without a device. The
 * tool feeds it real data and performs the transfers.
 *
 * Matching is by relative path + size only: mtimes differ across machines and
 * clocks, and a size change covers every real edit. Build outputs, VCS data and
 * caches are excluded by default because they are regenerated on the device.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Directory names excluded at any depth, and file suffixes / names excluded at any depth. */
export const DEFAULT_SYNC_EXCLUDES: readonly string[] = [
  '.git',
  '.moss',
  '.rdk',
  '.idea',
  '.vscode',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'build',
  'install',
  'log',
  'logs',
  'dist',
  'target',
  '.DS_Store',
  '*.pyc',
  '*.pyo',
  '*.o',
  '*.obj',
  '*.swp',
  '*~',
];

export interface SyncLocalEntry {
  /** POSIX relative path from the synced root. */
  rel: string;
  abs: string;
  sizeBytes: number;
  /** Executable bit, so scripts keep their mode on the device. */
  executable: boolean;
}

export interface SyncRemoteEntry {
  rel: string;
  sizeBytes: number;
}

export interface SyncPlanInput {
  local: readonly SyncLocalEntry[];
  remote: readonly SyncRemoteEntry[];
  /** Replaces {@link DEFAULT_SYNC_EXCLUDES} when given. */
  excludes?: readonly string[];
  /** Delete remote files that no longer exist locally (mirror). Off by default. */
  deleteRemoved?: boolean;
  /** Files above this size are skipped and reported, never silently dropped. */
  maxFileBytes?: number;
}

export interface SyncPlan {
  uploads: SyncLocalEntry[];
  deletes: string[];
  unchanged: number;
  skippedLarge: Array<{ rel: string; sizeBytes: number }>;
  excluded: number;
  totalBytes: number;
}

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/** `name` matches a path segment exactly; `*.ext` matches a segment's suffix. */
export function isExcludedRelPath(rel: string, excludes: readonly string[]): boolean {
  const segments = rel.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    for (const rule of excludes) {
      if (!rule) continue;
      if (rule.startsWith('*.')) {
        if (isLast && segment.endsWith(rule.slice(1))) return true;
        continue;
      }
      if (rule.startsWith('*')) {
        if (isLast && segment.endsWith(rule.slice(1))) return true;
        continue;
      }
      if (segment === rule) return true;
    }
  }
  return false;
}

export function planWorkspaceSync(input: SyncPlanInput): SyncPlan {
  const excludes = input.excludes ?? DEFAULT_SYNC_EXCLUDES;
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const remoteByRel = new Map(input.remote.map((entry) => [entry.rel, entry]));
  const localRels = new Set<string>();
  const uploads: SyncLocalEntry[] = [];
  const skippedLarge: Array<{ rel: string; sizeBytes: number }> = [];
  let unchanged = 0;
  let excluded = 0;
  let totalBytes = 0;
  for (const entry of input.local) {
    localRels.add(entry.rel);
    if (isExcludedRelPath(entry.rel, excludes)) {
      excluded++;
      continue;
    }
    if (entry.sizeBytes > maxFileBytes) {
      skippedLarge.push({ rel: entry.rel, sizeBytes: entry.sizeBytes });
      continue;
    }
    const remote = remoteByRel.get(entry.rel);
    if (remote && remote.sizeBytes === entry.sizeBytes) {
      unchanged++;
      continue;
    }
    uploads.push(entry);
    totalBytes += entry.sizeBytes;
  }
  const deletes: string[] = [];
  if (input.deleteRemoved) {
    for (const entry of input.remote) {
      if (localRels.has(entry.rel)) continue;
      if (isExcludedRelPath(entry.rel, excludes)) continue;
      deletes.push(entry.rel);
    }
  }
  return { uploads, deletes, unchanged, skippedLarge, excluded, totalBytes };
}

/**
 * Parse `find <root> -type f -printf '%s\t%P\n'` (GNU find, Ubuntu boards) or
 * the `stat -c` fallback into remote entries with POSIX relative paths.
 */
export function parseRemoteFileListing(stdout: string): SyncRemoteEntry[] {
  const out: SyncRemoteEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const size = Number(line.slice(0, tab));
    const rel = line
      .slice(tab + 1)
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '');
    if (!Number.isFinite(size) || !rel) continue;
    out.push({ rel, sizeBytes: size });
  }
  return out;
}

/** Shell snippet listing every regular file under `dir` as `size<TAB>relpath`. */
export function remoteFileListingCommand(dir: string): string {
  const q = shellQuote(dir);
  return (
    `cd ${q} 2>/dev/null && ` +
    `(find . -type f -printf '%s\t%P\\n' 2>/dev/null || find . -type f -exec stat -c '%s\t%n' {} + 2>/dev/null | sed 's#\\t\\./#\\t#') || true`
  );
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface LocalWorkspaceListing {
  files: SyncLocalEntry[];
  /** Entries dropped by the exclude list (whole excluded directories count once). */
  excluded: number;
}

/** Walk a local directory (no symlink following) and collect files with size + mode. */
export async function listLocalWorkspaceFiles(
  root: string,
  excludes: readonly string[] = DEFAULT_SYNC_EXCLUDES
): Promise<LocalWorkspaceListing> {
  const out: SyncLocalEntry[] = [];
  let excluded = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isExcludedRelPath(childRel, excludes)) {
        excluded++;
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, childRel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue; // broken symlink / vanished file
      }
      if (!stat.isFile()) continue;
      out.push({
        rel: childRel.split(path.sep).join('/'),
        abs,
        sizeBytes: stat.size,
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  };
  await walk(root, '');
  return { files: out, excluded };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatSyncPlan(
  plan: SyncPlan,
  target: { localDir: string; remoteDir: string }
): string {
  const lines = [
    `sync ${target.localDir} → ${target.remoteDir}`,
    `upload ${plan.uploads.length} file(s), ${formatBytes(plan.totalBytes)}; unchanged ${plan.unchanged}; excluded ${plan.excluded}`,
  ];
  if (plan.deletes.length) lines.push(`delete ${plan.deletes.length} stale remote file(s)`);
  if (plan.skippedLarge.length) {
    lines.push(
      `skipped ${plan.skippedLarge.length} file(s) above the size cap: ` +
        plan.skippedLarge
          .slice(0, 8)
          .map((f) => `${f.rel} (${formatBytes(f.sizeBytes)})`)
          .join(', ') +
        (plan.skippedLarge.length > 8 ? ', …' : '')
    );
  }
  return lines.join('\n');
}
