/**
 * O101 layer 3: post-run detection of protected-path changes.
 *
 * Takes a metadata snapshot (mtime, size, content hash) BEFORE a shell
 * command runs and diffs it AFTER. On change we report "已被修改" (modified),
 * never "已拦截" (intercepted) — the command already ran. No auto-restore.
 *
 * Never puts file contents, secret values, or full hashes into notices,
 * run-outcome lines, tool results, or model context. Hash is compare-only.
 *
 * Watched: ~/.ssh/*, workspace .env / .env.* / .envrc, and under .git only
 * config, HEAD, refs/**, hooks/** (including newly added hooks). Normal
 * git commit writes (index, objects, logs, ORIG_HEAD, …) are ignored.
 *
 * Snapshot unavailable (permission) → skip that path; never false-report
 * "modified". `exec_background` runs the same check on full process exit
 * (O108). Delayed writes via `&` / `nohup` inside a foreground command, and
 * writes after the Moss process itself exits, remain known limits.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PathChangeKind = 'added' | 'modified' | 'deleted';

export interface ProtectedPathChange {
  /** Display path (~/.ssh/… or relative to cwd). */
  path: string;
  kind: PathChangeKind;
}

/** Internal meta — never log `hash` in full. */
interface PathMeta {
  mtimeMs: number;
  size: number;
  /** sha256 hex; compare only. */
  hash: string;
}

/** Sentinel: path exists but meta could not be read (permission). */
const UNAVAILABLE = Symbol('unavailable');

type Entry = PathMeta | typeof UNAVAILABLE;

export interface ProtectedPathSnapshot {
  /** Absolute path → meta or UNAVAILABLE. Absent key = did not exist. */
  entries: Map<string, Entry>;
  /** Absolute → display form. */
  display: Map<string, string>;
  takenAt: number;
  cwd: string;
  home: string;
}

/** Machine-readable marker for run-completion tracker (no secrets). */
export const PROTECTED_PATH_MOD_MARKER = '[moss-o101-protected-path-modified]';

function homeDir(home?: string): string {
  return home || process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function displayFor(abs: string, cwd: string, home: string): string {
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  const fromHome = path.relative(home, abs);
  if (!fromHome.startsWith('..') && !path.isAbsolute(fromHome)) {
    return fromHome ? `~/${fromHome.replace(/\\/g, '/')}` : '~';
  }
  return abs.replace(/\\/g, '/');
}

/** PathMeta | UNAVAILABLE | null(ENOENT). */
function metaOf(abs: string): PathMeta | typeof UNAVAILABLE | null {
  try {
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) {
      return {
        mtimeMs: st.mtimeMs,
        size: -1,
        hash: crypto.createHash('sha256').update(`dir:${st.mtimeMs}`).digest('hex'),
      };
    }
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      return {
        mtimeMs: st.mtimeMs,
        size: target.length,
        hash: crypto.createHash('sha256').update(`link:${target}`).digest('hex'),
      };
    }
    const buf = fs.readFileSync(abs);
    return {
      mtimeMs: st.mtimeMs,
      size: st.size,
      hash: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    return UNAVAILABLE;
  }
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function walkFiles(dir: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  for (const name of listDirSafe(dir)) {
    if (name === '.' || name === '..') continue;
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(abs, out, depth + 1);
    else out.push(abs);
  }
}

/**
 * Collect absolute paths we watch under cwd + home.
 * `.git` only: config, HEAD, refs/**, hooks/**.
 */
export function listWatchedProtectedPaths(cwd: string, home?: string): string[] {
  const h = homeDir(home);
  const paths: string[] = [];
  const ssh = path.join(h, '.ssh');
  paths.push(ssh);
  for (const name of listDirSafe(ssh)) {
    paths.push(path.join(ssh, name));
  }

  const ws = path.resolve(cwd);
  for (const name of listDirSafe(ws)) {
    if (name === '.env' || name === '.envrc' || name.startsWith('.env.')) {
      paths.push(path.join(ws, name));
    }
  }

  const git = path.join(ws, '.git');
  for (const name of ['config', 'HEAD']) {
    paths.push(path.join(git, name));
  }
  const hooks = path.join(git, 'hooks');
  paths.push(hooks);
  for (const name of listDirSafe(hooks)) {
    paths.push(path.join(hooks, name));
  }
  const refs = path.join(git, 'refs');
  paths.push(refs);
  walkFiles(refs, paths);

  return [...new Set(paths)];
}

function fillSnapshot(
  cwd: string,
  home: string,
  absPaths: Iterable<string>,
  into: ProtectedPathSnapshot
): void {
  for (const abs of absPaths) {
    if (!into.display.has(abs)) into.display.set(abs, displayFor(abs, cwd, home));
    const m = metaOf(abs);
    if (m === null) {
      into.entries.delete(abs);
      continue;
    }
    into.entries.set(abs, m);
  }
}

export function takeProtectedPathSnapshot(
  cwd: string,
  opts?: { home?: string }
): ProtectedPathSnapshot {
  const home = homeDir(opts?.home);
  const resolvedCwd = path.resolve(cwd);
  const snap: ProtectedPathSnapshot = {
    entries: new Map(),
    display: new Map(),
    takenAt: Date.now(),
    cwd: resolvedCwd,
    home,
  };
  fillSnapshot(resolvedCwd, home, listWatchedProtectedPaths(resolvedCwd, home), snap);
  return snap;
}

/**
 * After snapshot: re-list watched paths (picks up new hooks) and also re-check
 * every path that appeared in `before` (so deletions are visible).
 */
export function takeProtectedPathSnapshotAfter(
  before: ProtectedPathSnapshot,
  opts?: { home?: string }
): ProtectedPathSnapshot {
  const home = homeDir(opts?.home ?? before.home);
  const cwd = before.cwd;
  const snap: ProtectedPathSnapshot = {
    entries: new Map(),
    display: new Map(before.display),
    takenAt: Date.now(),
    cwd,
    home,
  };
  const paths = new Set([...listWatchedProtectedPaths(cwd, home), ...before.entries.keys()]);
  fillSnapshot(cwd, home, paths, snap);
  return snap;
}

/**
 * Diff two snapshots. Paths that were unavailable on either side are skipped —
 * never false-report modified.
 */
export function diffProtectedPathSnapshots(
  before: ProtectedPathSnapshot,
  after: ProtectedPathSnapshot
): ProtectedPathChange[] {
  const changes: ProtectedPathChange[] = [];
  const all = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const abs of all) {
    const bHas = before.entries.has(abs);
    const aHas = after.entries.has(abs);
    const b = bHas ? before.entries.get(abs) : undefined;
    const a = aHas ? after.entries.get(abs) : undefined;
    // Unavailable on either side → skip (do not false-report).
    if (b === UNAVAILABLE || a === UNAVAILABLE) continue;
    const display = after.display.get(abs) ?? before.display.get(abs) ?? abs.replace(/\\/g, '/');
    // After the UNAVAILABLE guard, b/a are PathMeta | undefined.
    if (!bHas && aHas && a) {
      changes.push({ path: display, kind: 'added' });
      continue;
    }
    if (bHas && !aHas && b) {
      changes.push({ path: display, kind: 'deleted' });
      continue;
    }
    if (bHas && aHas && b && a) {
      if (b.hash !== a.hash || b.size !== a.size) {
        changes.push({ path: display, kind: 'modified' });
      }
    }
  }
  return changes;
}

const KIND_ZH: Record<PathChangeKind, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
};
const KIND_EN: Record<PathChangeKind, string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
};

function inspectHints(changes: readonly ProtectedPathChange[]): string[] {
  const hints: string[] = [];
  const joined = changes.map((c) => c.path).join(' ');
  if (/\.ssh/.test(joined)) hints.push('ls -la ~/.ssh');
  if (/\.git\/hooks/.test(joined)) hints.push('ls -la .git/hooks');
  if (/\.git\/(config|HEAD|refs)/.test(joined)) hints.push('git status && ls -la .git');
  if (/\.env/.test(joined)) hints.push('ls -la .env*');
  if (hints.length === 0) hints.push('ls -la');
  return [...new Set(hints)];
}

/**
 * Human + machine notice for tool results / stderr.
 * Uses「已被修改」not「已拦截」. No file contents, no full hashes.
 */

/** Git porcelain that legitimately updates HEAD / refs (not config/hooks). */
const GIT_REF_UPDATING =
  /(?:^|[\s;&|])git\s+(?:commit|checkout|switch|branch|merge|rebase|pull|fetch|reset|tag|stash|cherry-pick|revert|am|bisect)\b/i;

function isGitHeadsOrRefsPath(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return (
    /(^|\/)\.git\/HEAD$/i.test(n) ||
    /(^|\/)\.git\/refs\//i.test(n) ||
    n === 'HEAD' ||
    n.startsWith('refs/')
  );
}

/**
 * Drop HEAD/refs changes when the command is ordinary git porcelain, so
 * `git commit` / `git checkout -b` are not false positives. config / hooks /
 * .ssh / .env changes are never filtered.
 */
export function filterExpectedGitMetadataChanges(
  command: string,
  changes: readonly ProtectedPathChange[]
): ProtectedPathChange[] {
  if (!GIT_REF_UPDATING.test(command)) return [...changes];
  return changes.filter((c) => !isGitHeadsOrRefsPath(c.path));
}

export function formatProtectedPathModifiedNotice(
  changes: readonly ProtectedPathChange[],
  zh: boolean,
  command?: string
): string {
  if (changes.length === 0) return '';
  const cmd = (command ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const list = changes
    .map((c) => `${c.path} (${zh ? KIND_ZH[c.kind] : KIND_EN[c.kind]})`)
    .join(zh ? '；' : '; ');
  const hints = inspectHints(changes);
  const markerPaths = changes.map((c) => c.path).join(',');
  const lines = zh
    ? [
        `${PROTECTED_PATH_MOD_MARKER} paths=${markerPaths}`,
        `[moss] 受保护路径已被修改（命令已执行，Moss 没有拦截也没有自动还原）：${list}`,
        cmd ? `命令：${cmd}` : '',
        `请自行检查。可复制：`,
        ...hints.map((h) => `  ${h}`),
      ]
    : [
        `${PROTECTED_PATH_MOD_MARKER} paths=${markerPaths}`,
        `[moss] Protected paths were modified (command already ran; Moss did not intercept or restore): ${list}`,
        cmd ? `command: ${cmd}` : '',
        `Inspect yourself. Copyable:`,
        ...hints.map((h) => `  ${h}`),
      ];
  return lines.filter(Boolean).join('\n');
}

/** Parse marker line from a tool result (for run-completion tracker). */
export function parseProtectedPathModMarker(text: string): ProtectedPathChange[] | undefined {
  if (!text.includes(PROTECTED_PATH_MOD_MARKER)) return undefined;
  const m = text.match(/\[moss-o101-protected-path-modified\]\s+paths=([^\n]+)/);
  if (!m) return [{ path: '(unknown)', kind: 'modified' }];
  return m[1]!
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ path: p, kind: 'modified' as const }));
}

/** Outcome reason strings (O98). */
export function protectedPathModReason(
  changes: readonly ProtectedPathChange[],
  command?: string
): { en: string; zh: string; stuckEn: string; stuckZh: string } {
  const paths = changes
    .map((c) => c.path)
    .slice(0, 5)
    .join(', ');
  const more = changes.length > 5 ? ` (+${changes.length - 5})` : '';
  const cmd = (command ?? 'shell').replace(/\s+/g, ' ').trim().slice(0, 60);
  return {
    en: `${cmd} modified protected path(s) ${paths}${more}`,
    zh: `${cmd} 修改了受保护路径 ${paths}${more}`,
    stuckEn: `protected path modified: ${paths}${more}`,
    stuckZh: `受保护路径已被修改：${paths}${more}`,
  };
}
