/**
 * O101 layer 3: post-run detection of protected-path changes.
 *
 * Takes a metadata snapshot (mtime, size, content hash) BEFORE a shell
 * command runs and diffs it AFTER. On change we report "已被修改" (modified),
 * never "已拦截" (intercepted) — the command already ran.
 *
 * O152: for a fixed restore-eligible set (`.git/config`, `.git/HEAD`,
 * `.git/hooks/**`, workspace `.env*`) we also keep the bytes (≤
 * {@link RESTORE_MAX_BYTES}) and the file mode in memory / a 0600 temp
 * file, and {@link restoreProtectedPathChanges} writes them back after the
 * diff. Notices then say "已还原". Paths over the size cap, or a `.git`
 * that was swapped for a symlink / gitfile we refuse to write through, are
 * reported as "未能还原" with the reason. Delayed writes via `&` / `nohup`
 * and writes after the Moss process exits remain known limits.
 *
 * Never puts file contents, secret values, or full hashes into notices,
 * run-outcome lines, tool results, or model context. Hash is compare-only.
 *
 * Watched: ~/.ssh/*, workspace .env / .env.* / .envrc, and under .git only
 * config, HEAD, refs/**, hooks/** (including newly added hooks). For
 * `.git/config` content edits, changes confined to allow-listed benign keys
 * are not reported (O117, GIT_CONFIG_BENIGN_KEYS); any other key counts; add/delete/symlink swap or unparsable
 * content still reports the whole file (fail-closed). Normal
 * git commit writes (index, objects, logs, ORIG_HEAD, …) are ignored, and
 * HEAD / refs/** changes are reported only when anomalous (O123: points
 * outside refs/, not a commit id, symlink/dir swap).
 *
 * Snapshot unavailable (permission) → skip that path; never false-report
 * "modified". `exec_background` runs the same check (and O152 restore) on
 * full process exit (O108). Delayed writes via `&` / `nohup` inside a
 * foreground command, and writes after the Moss process itself exits,
 * remain known limits — restore cannot cover them.
 */
import { runProcessSync } from '../utils/run-process.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProtectedPathApproved } from './protected-path-approvals.js';

export type PathChangeKind = 'added' | 'modified' | 'deleted';

/** O152: per-file content snapshot cap (bytes). Over → no restore. */
export const RESTORE_MAX_BYTES = 1 * 1024 * 1024;

export type RestoreOutcome =
  | 'restored'
  | 'skipped-oversize'
  | 'skipped-symlink-git'
  | 'skipped-no-snapshot'
  | 'skipped-approved'
  | 'failed';

export interface ProtectedPathRestore {
  path: string;
  kind: PathChangeKind;
  outcome: RestoreOutcome;
}

export interface ProtectedPathChange {
  /** Display path (~/.ssh/… or relative to cwd). */
  path: string;
  kind: PathChangeKind;
  /**
   * O117: for `.git/config` content changes, the non-allow-listed keys whose
   * values changed (names only, never values). Absent = whole-file report.
   */
  keys?: string[];
  /**
   * O117: why a git config file is reported without keys (fail-closed):
   * replaced by a symlink / directory, or content git cannot parse.
   */
  reason?: GitConfigChangeReason;
  /** O152: set when the notice's detail marker recorded a restore attempt. */
  restoreOutcome?: RestoreOutcome;
}

export type GitConfigChangeReason =
  | 'symlink'
  | 'dir'
  | 'unparsable'
  /** O123: `.git/HEAD` / a ref points outside `refs/` (e.g. `ref: ../x`). */
  | 'ref-outside'
  /** O123: ref / HEAD content is not a commit id or `ref: refs/…`. */
  | 'ref-invalid'
  /** O127: the worktree's `.git` file was rewritten (gitdir pointer changed). */
  | 'gitlink-rewritten'
  /** O127: `.git` file's gitdir / commondir does not exist or cannot be read. */
  | 'gitlink-missing'
  /**
   * O152 r6 (P1-W): readable before the command, unreadable after (EPERM /
   * EBUSY — e.g. a Windows delete-pending entry after a partial
   * `rmSync(cwd)`). Fail-closed: reported, never skipped.
   */
  | 'unreadable';

const ALL_REASONS: readonly GitConfigChangeReason[] = [
  'symlink',
  'dir',
  'unparsable',
  'ref-outside',
  'ref-invalid',
  'gitlink-rewritten',
  'gitlink-missing',
];

/** Internal meta — never log `hash` in full. */
interface PathMeta {
  mtimeMs: number;
  size: number;
  /** sha256 hex; compare only. */
  hash: string;
  /** O117: raw bytes of git config files only (in memory, never logged). */
  raw?: Buffer;
  /**
   * O152: full file bytes for restore-eligible paths (≤ RESTORE_MAX_BYTES).
   * Never logged, never put in notices / model context. Absent when oversize
   * or not restore-eligible.
   */
  content?: Buffer;
  /** O152: `st.mode & 0o777` captured for restore (hooks executable bit). */
  mode?: number;
  /** O152: true when size > RESTORE_MAX_BYTES (so we can say why we skipped). */
  oversize?: boolean;
  /** O123: classification of `.git/HEAD` / `.git/refs/**` content (no content kept). */
  refState?: RefState;
  /** O117: entry type, so symlink/dir swaps of a config file can be named. */
  type?: 'file' | 'symlink' | 'dir';
  /** O127: for a worktree `.git` *file*, whether its gitdir/commondir resolve. */
  gitLink?: 'ok' | 'missing';
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
  /**
   * O152: 0600 temp dir holding content for restore-eligible files that were
   * too large for the in-memory Buffer path, or that we spilled for safety.
   * Removed by {@link disposeProtectedPathSnapshot}. Never logged.
   */
  restoreDir?: string;
}

/** Machine-readable marker for run-completion tracker (no secrets). */
export const PROTECTED_PATH_MOD_MARKER = '[moss-o101-protected-path-modified]';
/** O117: per-path detail (path, kind, reason, key names) for git config files. */
export const PROTECTED_PATH_DETAIL_MARKER = '[moss-o117-protected-path-detail]';

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

/**
 * O117: git config files whose content is diffed per key: `.git/config`,
 * `.git/config.worktree`, `.git/worktrees/<name>/config.worktree`.
 */
export function isGitConfigPath(abs: string): boolean {
  return /(^|[\\/])\.git[\\/](?:config|config\.worktree|worktrees[\\/][^\\/]+[\\/]config\.worktree)$/.test(
    abs
  );
}

/**
 * O152: paths whose bytes we keep for auto-restore after a post-run change.
 * Fixed set: `.git/config`, `.git/HEAD`, `.git/hooks/**`, workspace `.env` /
 * `.env.*` / `.envrc`. Everything else stays detect-only (refs, info, ssh…).
 */
export function isRestoreEligiblePath(abs: string): boolean {
  const n = abs.replace(/\\/g, '/');
  if (/(^|\/)\.git\/(?:config|HEAD)$/.test(n)) return true;
  if (/(^|\/)\.git\/hooks\//.test(n)) return true;
  if (/(^|\/)\.env(?:rc|\.[^/]+)?$/.test(n)) return true;
  // Separate git-dir / linked-worktree commondir (path has no ".git" segment).
  const base = n.split('/').pop() ?? '';
  const parent = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
  if ((base === 'config' || base === 'HEAD') && looksLikeGitDir(parent)) return true;
  if (/\/hooks\//.test(n)) {
    const hooksRoot = n.replace(/\/hooks\/.*$/, '');
    if (looksLikeGitDir(hooksRoot)) return true;
  }
  return false;
}

function looksLikeGitDir(dir: string): boolean {
  if (!dir) return false;
  const d = dir.replace(/\//g, path.sep);
  try {
    return fs.existsSync(path.join(d, 'HEAD')) || fs.existsSync(path.join(d, 'objects'));
  } catch {
    return false;
  }
}

/**
 * O117 (PM, allow-list): the only `.git/config` keys whose changes are NOT
 * reported. Every other key change — including ones never seen before — is
 * reported as "已被修改" (fail-closed). Kept deliberately small: nothing that
 * can run a program, pull in other config, or change where code is fetched
 * from. Remote/branch leaves are handled separately (PM 口径, see
 * GIT_CONFIG_BENIGN_SUBSECTION_LEAVES / isSafeGitRemoteUrl).
 *
 * Matching is on the normalised key: section and variable name are
 * case-insensitive, the subsection keeps git's case-sensitive spelling.
 */
export const GIT_CONFIG_BENIGN_KEYS: readonly string[] = [
  'user.name',
  'user.email',
  'color.ui',
  'init.defaultBranch',
  'pull.rebase',
  'core.autocrlf',
];

/** Lower-case section + variable name; keep subsection as git does. */
export function normalizeGitConfigKey(key: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

export function isBenignGitConfigKey(key: string): boolean {
  // Exact two-part keys only (no wildcards, no subsections): QA gate.
  const k = normalizeGitConfigKey(key);
  if (k.indexOf('.') !== k.lastIndexOf('.')) return false;
  return GIT_CONFIG_BENIGN_KEYS.some((e) => e.toLowerCase() === k);
}

/**
 * O117 (PM, remote 口径): three-part leaf keys allowed regardless of value,
 * for any subsection name. Every other `remote.<n>.*` / `branch.<n>.*` leaf
 * (uploadpack, receivepack, proxy, pushurl, vcs, ...) stays reported.
 */
export const GIT_CONFIG_BENIGN_SUBSECTION_LEAVES: readonly string[] = [
  'branch.*.merge',
  'remote.*.fetch',
];

/** O117: allowed by value only (see isSafeGitRemoteUrl). */
export const GIT_CONFIG_VALUE_CHECKED_LEAVES: readonly string[] = ['remote.*.url'];

/**
 * O117: `branch.<n>.remote` may hold a URL instead of a remote name (git then
 * fetches/pushes that URL directly), so it is allowed by value: `.`, a plain
 * remote name (no `/`, `:`, leading `-`), or a URL isSafeGitRemoteUrl accepts.
 */
export function isSafeGitBranchRemote(v: string): boolean {
  if (v === '.') return true;
  if (/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(v)) return true;
  return isSafeGitRemoteUrl(v);
}

function splitSubsectionKey(k: string): { section: string; sub: string; name: string } | null {
  const first = k.indexOf('.');
  const last = k.lastIndexOf('.');
  if (first === -1 || first === last) return null;
  return { section: k.slice(0, first), sub: k.slice(first + 1, last), name: k.slice(last + 1) };
}

function leafPattern(k: string): string | null {
  const p = splitSubsectionKey(k);
  if (!p || p.sub.length === 0) return null;
  return `${p.section}.*.${p.name}`;
}

function safeDecode(x: string): string | null {
  try {
    let cur = x;
    // Decode repeatedly so %252D style double-encoding is also caught.
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(cur);
      if (next === cur) break;
      cur = next;
    }
    return cur;
  } catch {
    return null;
  }
}

function hostUserOk(raw: string): boolean {
  const v = safeDecode(raw);
  if (v === null) return false;
  if (v.length === 0) return false;
  if (v.startsWith('-')) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return false;
  return true;
}

/**
 * O117 (PM): `remote.<n>.url` is allowed only for `https://`, `ssh://` and
 * scp-style `user@host:path`. Everything else (ext::, fd::, file://, local
 * paths, leading `-`, newline/control chars, host or user beginning with `-`
 * after URL-decoding — CVE-2017-1000117 —, non-numeric port) is reported.
 */
export function isSafeGitRemoteUrl(url: string): boolean {
  if (url.length === 0 || url.startsWith('-')) return false;
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return false;
  const dec = safeDecode(url);
  if (dec === null) return false;
  if (dec.startsWith('-') || /[\u0000-\u001f\u007f]/.test(dec)) return false;
  if (/^[A-Za-z0-9+.-]*::/.test(url)) return false; // ext::, fd::, <transport>::
  const m = /^(https|ssh):\/\/([^/?#]*)(.*)$/i.exec(url);
  if (m) {
    let auth = m[2];
    if (!auth) return false;
    let user: string | undefined;
    const at = auth.lastIndexOf('@');
    if (at !== -1) {
      user = auth.slice(0, at);
      auth = auth.slice(at + 1);
      if (m[1].toLowerCase() === 'ssh' && user.includes(':')) return false;
      const uname = user.split(':')[0];
      if (!hostUserOk(uname)) return false;
    }
    let host = auth;
    let port: string | undefined;
    if (host.startsWith('[')) {
      const close = host.indexOf(']');
      if (close === -1) return false;
      const rest = host.slice(close + 1);
      host = host.slice(1, close);
      if (rest) {
        if (!rest.startsWith(':')) return false;
        port = rest.slice(1);
      }
    } else {
      const c = host.indexOf(':');
      if (c !== -1) {
        port = host.slice(c + 1);
        host = host.slice(0, c);
      }
    }
    if (!hostUserOk(host)) return false;
    if (port !== undefined && port !== '' && !/^[0-9]+$/.test(port)) return false;
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false; // file://, git://, http:// ...
  // scp style: [user@]host:path — host must contain no '/', and a ':' must
  // come before any '/', otherwise git treats it as a local path.
  const scp = /^(?:([^@/:]+)@)?([^@/:[\]]+|\[[^\]]+\]):(.*)$/.exec(url);
  if (!scp) return false;
  if (scp[1] !== undefined && !hostUserOk(scp[1])) return false;
  const host = scp[2].replace(/^\[|\]$/g, '');
  if (!hostUserOk(host)) return false;
  // A single-letter "host" is a Windows drive path (C:\x), i.e. local.
  if (/^[a-z]$/i.test(host)) return false;
  if (scp[3].startsWith('-')) return false;
  return true;
}

/**
 * O117: whether a key change is allowed given its new values. `afterValues`
 * is the full list after the command (empty = key removed).
 */
export function isBenignGitConfigEntry(key: string, afterValues: readonly string[]): boolean {
  if (isBenignGitConfigKey(key)) return true;
  const k = normalizeGitConfigKey(key);
  const pat = leafPattern(k);
  if (!pat) return false;
  if (GIT_CONFIG_BENIGN_SUBSECTION_LEAVES.includes(pat)) return true;
  if (pat === 'branch.*.remote') {
    return afterValues.every((v) => v !== '\u0000(implicit-true)' && isSafeGitBranchRemote(v));
  }
  if (GIT_CONFIG_VALUE_CHECKED_LEAVES.includes(pat)) {
    return afterValues.every((v) => v !== '\u0000(implicit-true)' && isSafeGitRemoteUrl(v));
  }
  return false;
}

/**
 * Parse git config bytes with git itself (`git config --file - --list -z`,
 * no includes followed, no system/global config). Returns key→values, or
 * null on any failure (fail-closed: caller reports the whole file).
 */
export function parseGitConfigEntries(raw: Buffer): Map<string, string[]> | null {
  let tmpDir: string | undefined;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o117-'));
    const file = path.join(tmpDir, 'config');
    fs.writeFileSync(file, raw, { mode: 0o600 });
    const res = runProcessSync('git', ['config', '--file', file, '--no-includes', '--list', '-z'], {
      cwd: tmpDir,
      encoding: 'buffer',
      timeout: 5000,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        HOME: tmpDir,
        GIT_CONFIG_NOSYSTEM: '1',
        // Git for Windows rejects Node's \\.\nul device namespace.
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
        LC_ALL: 'C',
      },
    });
    if (res.error || res.status !== 0 || !res.stdout) return null;
    const out = new Map<string, string[]>();
    for (const rec of res.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      const nl = rec.indexOf('\n');
      const key = normalizeGitConfigKey(nl === -1 ? rec : rec.slice(0, nl));
      const value = nl === -1 ? '\u0000(implicit-true)' : rec.slice(nl + 1);
      const list = out.get(key) ?? [];
      list.push(value);
      out.set(key, list);
    }
    return out;
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * O117: which non-allow-listed keys differ between two `.git/config`
 * contents. Returns [] when only allow-listed keys changed, or null when either side cannot
 * be parsed (fail-closed → report whole file).
 */
export function changedUnlistedGitConfigKeys(before: Buffer, after: Buffer): string[] | null {
  const b = parseGitConfigEntries(before);
  const a = parseGitConfigEntries(after);
  if (!b || !a) return null;
  const changed: string[] = [];
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    if (JSON.stringify(b.get(key) ?? []) === JSON.stringify(a.get(key) ?? [])) continue;
    if (isBenignGitConfigEntry(key, a.get(key) ?? [])) continue;
    changed.push(key);
  }
  changed.sort();
  const text = `${after.toString('utf8')}\n${before.toString('utf8')}`;
  return changed.map((k) => displayGitConfigKey(k, text));
}

function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * O117 (UX): show a key with the spelling the file used (e.g.
 * `core.hooksPath`), since git itself lower-cases section + name. Falls back
 * to the normalised form. Names only, never values.
 */
export function displayGitConfigKey(key: string, text: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1) return key;
  const section = key.slice(0, first);
  const middle = key.slice(first, last + 1);
  const name = key.slice(last + 1);
  const secM = text.match(new RegExp(`^\\s*\\[\\s*(${escapeRe(section)})(?=[\\s\\]".])`, 'im'));
  const nameM = text.match(new RegExp(`^\\s*(${escapeRe(name)})\\s*(?:=|$|[#;])`, 'im'));
  return `${secM ? secM[1] : section}${middle}${nameM ? nameM[1] : name}`;
}

/**
 * O117: classify a git config file change. Only keys outside
 * GIT_CONFIG_BENIGN_KEYS count; symlink/dir swap or unparsable content is
 * reported with a reason (fail-closed). Returns undefined = not reported.
 */
function gitConfigChange(
  display: string,
  kind: PathChangeKind,
  b: PathMeta | undefined,
  a: PathMeta
): ProtectedPathChange | undefined {
  if (a.type === 'symlink') return { path: display, kind, reason: 'symlink' };
  if (a.type === 'dir') return { path: display, kind, reason: 'dir' };
  const before = b ? b.raw : Buffer.alloc(0);
  if (!before || !a.raw) return { path: display, kind, reason: 'unparsable' };
  const keys = changedUnlistedGitConfigKeys(before, a.raw);
  if (keys === null) return { path: display, kind, reason: 'unparsable' };
  if (keys.length === 0) return undefined;
  return { path: display, kind, keys };
}

/**
 * O123 (QA path allow-list): `.git/HEAD` and loose refs are what ordinary
 * `git commit` / `checkout -b` / `merge` rewrite. Their changes are NOT
 * reported when the new content is well-formed — a commit id, or
 * `ref: refs/<name>` with no `..`, absolute or backslash parts. Anything
 * else (`ref: ../x`, garbage, a symlink, a directory swap) is reported.
 * This is command-independent: `git -c k=v commit`, `git -C dir commit` or
 * a script that commits are judged by what they wrote, not by their text.
 */
type RefState = 'ok' | 'outside' | 'invalid';

export function isGitHeadOrLooseRefPath(abs: string): boolean {
  // O127: a linked worktree's own HEAD lives at .git/worktrees/<name>/HEAD.
  return /(^|[\\/])\.git[\\/](?:HEAD|refs[\\/].+|worktrees[\\/][^\\/]+[\\/]HEAD)$/.test(abs);
}

/**
 * O127: where git really keeps metadata for `ws`. A linked worktree (or
 * `--separate-git-dir` checkout) has a `.git` *file* (`gitdir: <dir>`);
 * per-worktree state (HEAD, config.worktree) lives in that gitdir and shared
 * state (config, hooks, refs, info…) in its `commondir`. Read with plain fs —
 * never runs git in the repo under test. `null` dirs = cannot resolve.
 */
export interface GitDirs {
  /** `.git` is a file (linked worktree / separate git dir). */
  linked: boolean;
  gitDir: string | null;
  commonDir: string | null;
}

export function resolveGitDirs(ws: string): GitDirs {
  const dotGit = path.join(ws, '.git');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dotGit);
  } catch {
    return { linked: false, gitDir: dotGit, commonDir: dotGit };
  }
  if (!st.isFile()) return { linked: false, gitDir: dotGit, commonDir: dotGit };
  let text: string;
  try {
    text = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return { linked: true, gitDir: null, commonDir: null };
  }
  const m = text.match(/^gitdir:[ \t]*(.+?)[ \t]*\r?$/m);
  if (!m) return { linked: true, gitDir: null, commonDir: null };
  const gitDir = path.resolve(ws, m[1]!);
  if (!isRealDir(gitDir)) return { linked: true, gitDir: null, commonDir: null };
  let commonDir = gitDir;
  try {
    const c = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (c) commonDir = path.resolve(gitDir, c);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { linked: true, gitDir, commonDir: null };
    }
  }
  if (!isRealDir(commonDir)) return { linked: true, gitDir, commonDir: null };
  return { linked: true, gitDir, commonDir };
}

function isRealDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isDotGitFile(abs: string): boolean {
  return path.basename(abs) === '.git';
}

export function classifyGitRefContent(text: string): RefState {
  const t = text.replace(/\r?\n$/, '');
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(t)) return 'ok';
  const m = t.match(/^ref:\s*(.*)$/);
  if (!m) return 'invalid';
  const target = m[1]!;
  if (
    !target.startsWith('refs/') ||
    target.includes('\\') ||
    target.split('/').some((seg) => seg === '..' || seg === '.' || seg === '') ||
    /[\x00-\x1f]/.test(target)
  ) {
    return 'outside';
  }
  return 'ok';
}

function isGitRefsDir(abs: string): boolean {
  return /(^|[\\/])\.git[\\/]refs$/.test(abs);
}

/** O123: HEAD / loose ref change → reported only when anomalous. */
function gitRefChange(
  display: string,
  abs: string,
  b: PathMeta | undefined,
  a: PathMeta | undefined
): ProtectedPathChange | undefined {
  const isHead = /(^|[\\/])HEAD$/.test(abs) && !/[\\/]refs[\\/]/.test(abs);
  if (!a) {
    if (!b) return undefined;
    // Deleting a branch / tag ref is ordinary (`git branch -d`); HEAD is not.
    return isHead ? { path: display, kind: 'deleted' } : undefined;
  }
  const kind: PathChangeKind = b ? 'modified' : 'added';
  if (b && b.hash === a.hash && b.size === a.size && b.type === a.type) return undefined;
  if (a.type === 'symlink') return { path: display, kind, reason: 'symlink' };
  if (a.type === 'dir') return { path: display, kind, reason: 'dir' };
  if (a.refState === 'ok') return undefined;
  if (a.refState === 'outside') return { path: display, kind, reason: 'ref-outside' };
  return { path: display, kind, reason: 'ref-invalid' };
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
        type: 'dir',
      };
    }
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      return {
        mtimeMs: st.mtimeMs,
        size: target.length,
        hash: crypto.createHash('sha256').update(`link:${target}`).digest('hex'),
        type: 'symlink',
      };
    }
    const buf = fs.readFileSync(abs);
    const restore = isRestoreEligiblePath(abs);
    const oversize = restore && st.size > RESTORE_MAX_BYTES;
    return {
      mtimeMs: st.mtimeMs,
      size: st.size,
      hash: crypto.createHash('sha256').update(buf).digest('hex'),
      type: 'file',
      ...(isGitConfigPath(abs) ? { raw: buf } : {}),
      ...(restore
        ? {
            mode: st.mode & 0o777,
            ...(oversize ? { oversize: true as const } : { content: buf }),
          }
        : {}),
      ...(isDotGitFile(abs) && st.isFile()
        ? {
            gitLink: (() => {
              const d = resolveGitDirs(path.dirname(abs));
              return d.gitDir && d.commonDir ? ('ok' as const) : ('missing' as const);
            })(),
          }
        : {}),
      ...(isGitHeadOrLooseRefPath(abs)
        ? { refState: classifyGitRefContent(buf.toString('utf8')) }
        : {}),
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

function watchGitDir(git: string, paths: string[]): void {
  for (const name of ['config', 'config.worktree', 'HEAD']) {
    paths.push(path.join(git, name));
  }
  // O117: per-worktree config (extensions.worktreeConfig) can set
  // core.hooksPath etc. just like .git/config.
  for (const name of listDirSafe(path.join(git, 'worktrees'))) {
    paths.push(path.join(git, 'worktrees', name, 'config.worktree'));
  }
  const hooks = path.join(git, 'hooks');
  paths.push(hooks);
  for (const name of listDirSafe(hooks)) {
    paths.push(path.join(hooks, name));
  }
  const refs = path.join(git, 'refs');
  paths.push(refs);
  walkFiles(refs, paths);
  // O123: keep reporting the rest of .git that can change behaviour:
  // info/** (exclude, attributes, grafts…), object alternates, submodule
  // and linked-worktree configs.
  walkFiles(path.join(git, 'info'), paths);
  for (const name of ['alternates', 'http-alternates']) {
    paths.push(path.join(git, 'objects', 'info', name));
  }
  for (const name of listDirSafe(path.join(git, 'modules'))) {
    paths.push(path.join(git, 'modules', name, 'config'));
  }
  for (const name of listDirSafe(path.join(git, 'worktrees'))) {
    paths.push(path.join(git, 'worktrees', name, 'config'));
  }
}

/**
 * Collect absolute paths we watch under cwd + home.
 * `.git` only: config, config.worktree, worktrees/<name>/config(.worktree),
 * HEAD, refs/**, hooks/**, info/**, objects/info/(http-)alternates,
 * modules/<name>/config.
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

  const dirs = resolveGitDirs(ws);
  if (dirs.linked) {
    // O127: the `.git` file itself (pointer rewrite / gitdir gone is reported)
    // plus the real per-worktree gitdir and the shared commondir.
    paths.push(path.join(ws, '.git'));
    if (dirs.gitDir) {
      for (const name of ['config.worktree', 'HEAD']) paths.push(path.join(dirs.gitDir, name));
    }
  }
  if (dirs.commonDir) watchGitDir(dirs.commonDir, paths);

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
    const display = after.display.get(abs) ?? before.display.get(abs) ?? abs.replace(/\\/g, '/');
    // O152 r6 (P1-W): known before, unreadable after → changed (fail-closed).
    if (b && b !== UNAVAILABLE && a === UNAVAILABLE) {
      changes.push({ path: display, kind: 'modified', reason: 'unreadable' });
      continue;
    }
    // Unavailable before (state unknown) → skip (do not false-report).
    if (b === UNAVAILABLE || a === UNAVAILABLE) continue;
    if (isDotGitFile(abs)) {
      // O127: worktree `.git` file. Any content/type change, or its gitdir
      // vanishing, is reported (fail-closed).
      if (b && !a) {
        changes.push({ path: display, kind: 'deleted' });
        continue;
      }
      if (!a) continue;
      const kind: PathChangeKind = b ? 'modified' : 'added';
      if (a.type === 'symlink') changes.push({ path: display, kind, reason: 'symlink' });
      else if (a.type === 'dir') changes.push({ path: display, kind, reason: 'dir' });
      else if (b && (b.hash !== a.hash || b.type !== a.type))
        changes.push({ path: display, kind, reason: 'gitlink-rewritten' });
      else if (a.gitLink === 'missing' && (!b || b.gitLink !== 'missing'))
        changes.push({ path: display, kind, reason: 'gitlink-missing' });
      continue;
    }
    if (isGitRefsDir(abs)) {
      // O123: the refs/ directory itself — only a type swap counts; its
      // mtime moves on every branch create/delete.
      if (b && a && b.type === a.type) continue;
      if (b && a) {
        changes.push({
          path: display,
          kind: 'modified',
          ...(a.type === 'symlink' ? { reason: 'symlink' as const } : {}),
        });
        continue;
      }
    } else if (isGitHeadOrLooseRefPath(abs)) {
      const c = gitRefChange(display, abs, b, a);
      if (c) changes.push(c);
      continue;
    }
    // After the UNAVAILABLE guard, b/a are PathMeta | undefined.
    if (!bHas && aHas && a) {
      if (isGitConfigPath(abs)) {
        const c = gitConfigChange(display, 'added', undefined, a);
        if (c) changes.push(c);
        continue;
      }
      changes.push({ path: display, kind: 'added' });
      continue;
    }
    if (bHas && !aHas && b) {
      changes.push({ path: display, kind: 'deleted' });
      continue;
    }
    if (bHas && aHas && b && a) {
      if (b.hash !== a.hash || b.size !== a.size || b.type !== a.type) {
        if (isGitConfigPath(abs)) {
          const c = gitConfigChange(display, 'modified', b, a);
          if (c) changes.push(c);
          continue;
        }
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
    /(^|\/)\.git\/worktrees\/[^/]+\/HEAD$/i.test(n) ||
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
  // O123: never drop an anomalous HEAD/ref change (`ref: ../x`, symlink, …).
  return changes.filter((c) => c.reason !== undefined || !isGitHeadsOrRefsPath(c.path));
}

export function formatProtectedPathModifiedNotice(
  changes: readonly ProtectedPathChange[],
  zh: boolean,
  command?: string,
  restores?: readonly ProtectedPathRestore[]
): string {
  if (changes.length === 0) return '';
  const cmd = (command ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const byPath = new Map((restores ?? []).map((r) => [r.path, r]));
  const list = changes
    .map((c) => {
      const detail = describeGitConfigChange(c, zh);
      const base = detail ?? `${c.path} (${zh ? KIND_ZH[c.kind] : KIND_EN[c.kind]})`;
      const r = byPath.get(c.path);
      if (!r) return base;
      if (r.outcome === 'restored') return zh ? `${base}，已还原` : `${base}, restored`;
      if (r.outcome === 'skipped-oversize')
        return zh
          ? `${base}，未还原（超过快照上限）`
          : `${base}, not restored (over snapshot limit)`;
      if (r.outcome === 'skipped-symlink-git')
        return zh
          ? `${base}，未还原（.git 已换成软链/gitfile，拒绝写入）`
          : `${base}, not restored (.git is a symlink/gitfile; refusing to write through it)`;
      if (r.outcome === 'skipped-approved')
        return zh ? `${base}，已按用户批准保留` : `${base}, kept (user approved)`;
      if (r.outcome === 'failed')
        return zh ? `${base}，未能完全还原` : `${base}, could not fully restore`;
      return zh ? `${base}，未还原` : `${base}, not restored`;
    })
    .join(zh ? '；' : '; ');
  const hints = inspectHints(changes);
  const markerPaths = changes.map((c) => c.path).join(',');
  const anyRestored = (restores ?? []).some((r) => r.outcome === 'restored');
  const anyFailed = (restores ?? []).some(
    (r) =>
      r.outcome === 'failed' ||
      r.outcome === 'skipped-symlink-git' ||
      r.outcome === 'skipped-oversize'
  );
  // O152: emit a detail row for every change (not only git-config phrases)
  // so parseProtectedPathModMarker can carry restoreOutcome into the
  // outcome line (「已被修改，已还原：.env」).
  const detailLines = changes.map(
    (c) =>
      `${PROTECTED_PATH_DETAIL_MARKER} ${[
        c.path,
        c.kind,
        c.reason ?? '',
        (c.keys ?? []).join(','),
        byPath.get(c.path)?.outcome ?? '',
      ]
        .map((x) => x.replace(/[\t\n]/g, ' '))
        .join('\t')}`
  );
  const summaryZh = anyRestored
    ? anyFailed
      ? '受保护路径已被修改，部分已还原'
      : '受保护路径已被修改，已还原'
    : '受保护路径已被修改（命令已执行，Moss 没有拦截）';
  const summaryEn = anyRestored
    ? anyFailed
      ? 'Protected paths were modified; some restored'
      : 'Protected paths were modified and restored'
    : 'Protected paths were modified (command already ran; Moss did not intercept)';
  const lines = zh
    ? [
        `${PROTECTED_PATH_MOD_MARKER} paths=${markerPaths}`,
        ...detailLines,
        `[moss] ${summaryZh}：${list}`,
        cmd ? `命令：${cmd}` : '',
        `请自行检查。可复制：`,
        ...hints.map((h) => `  ${h}`),
      ]
    : [
        `${PROTECTED_PATH_MOD_MARKER} paths=${markerPaths}`,
        ...detailLines,
        `[moss] ${summaryEn}: ${list}`,
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
  const details = new Map<string, ProtectedPathChange>();
  for (const line of text.split('\n')) {
    if (!line.startsWith(PROTECTED_PATH_DETAIL_MARKER)) continue;
    const [p, kind, reason, keys, restore] = line
      .slice(PROTECTED_PATH_DETAIL_MARKER.length + 1)
      .split('\t');
    if (!p) continue;
    const k = (['added', 'modified', 'deleted'] as const).find((x) => x === kind) ?? 'modified';
    const r = ALL_REASONS.find((x) => x === reason);
    const ks = (keys ?? '').split(',').filter(Boolean);
    const ro = (
      [
        'restored',
        'skipped-oversize',
        'skipped-symlink-git',
        'skipped-no-snapshot',
        'skipped-approved',
        'failed',
      ] as const
    ).find((x) => x === restore);
    details.set(p, {
      path: p,
      kind: k,
      ...(r ? { reason: r } : {}),
      ...(ks.length ? { keys: ks } : {}),
      ...(ro ? { restoreOutcome: ro } : {}),
    });
  }
  return m[1]!
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => details.get(p) ?? { path: p, kind: 'modified' as const });
}

const KEYS_SHOWN = 3;

/**
 * O117 (UX): a git config file change in one phrase, e.g.
 * 「.git/config 改了 `core.hooksPath`（不在安全清单内）」. Undefined for other
 * paths / plain changes.
 */
export function describeGitConfigChange(c: ProtectedPathChange, zh: boolean): string | undefined {
  if (c.kind === 'deleted' && isGitConfigPath(c.path)) {
    return zh ? `${c.path} 被删除` : `${c.path} was deleted`;
  }
  if (c.reason === 'ref-outside') {
    return zh
      ? `${c.path} 指向仓库外路径（不在 refs/ 下）`
      : `${c.path} points outside the repository (not under refs/)`;
  }
  if (c.reason === 'ref-invalid') {
    return zh
      ? `${c.path} 内容不是提交号或 refs/ 引用`
      : `${c.path} no longer holds a commit id or refs/ reference`;
  }
  if (c.reason === 'gitlink-rewritten') {
    return zh
      ? `${c.path} 被改写（worktree 的 gitdir 指向变了）`
      : `${c.path} was rewritten (worktree gitdir pointer changed)`;
  }
  if (c.reason === 'gitlink-missing') {
    return zh
      ? `${c.path} 指向的 gitdir 不存在或读不了`
      : `${c.path} points to a gitdir that is missing or unreadable`;
  }
  if (c.reason === 'symlink') {
    return zh ? `${c.path} 被换成软链` : `${c.path} was replaced by a symlink`;
  }
  if (c.reason === 'dir') {
    return zh ? `${c.path} 被换成目录` : `${c.path} was replaced by a directory`;
  }
  if (c.reason === 'unparsable') {
    return zh ? `${c.path} 无法解析` : `${c.path} could not be parsed`;
  }
  if (c.reason === 'unreadable') {
    return zh
      ? `${c.path} 运行后无法读取（可能正在被删除或被占用）`
      : `${c.path} cannot be read after the command (being deleted or locked)`;
  }
  if (/(^|\/)\.git\/hooks\/./.test(c.path.replace(/\\/g, '/'))) {
    const verb = zh
      ? { added: '被新增', modified: '被改', deleted: '被删除' }[c.kind]
      : { added: 'was added', modified: 'was changed', deleted: 'was deleted' }[c.kind];
    return zh
      ? `${c.path} ${verb}（git 钩子，会执行命令）`
      : `${c.path} ${verb} (git hook, runs commands)`;
  }
  if (!c.keys?.length) return undefined;
  const shown = c.keys.slice(0, KEYS_SHOWN).map((k) => `\`${k}\``);
  const extra = c.keys.length > KEYS_SHOWN;
  if (zh) {
    const list = shown.join('、') + (extra ? ` 等 ${c.keys.length} 个` : '');
    return `${c.path} 改了 ${list}（不在安全清单内）`;
  }
  const list = shown.join(', ') + (extra ? ` and ${c.keys.length - KEYS_SHOWN} more` : '');
  return `${c.path} changed ${list} (not on the safe list)`;
}

/** Outcome reason strings (O98). */
export function protectedPathModReason(
  changes: readonly ProtectedPathChange[],
  command?: string
): { en: string; zh: string; stuckEn: string; stuckZh: string } {
  const plain = changes.filter((c) => !describeGitConfigChange(c, true));
  const detailZh = changes.map((c) => describeGitConfigChange(c, true)).filter(Boolean);
  const detailEn = changes.map((c) => describeGitConfigChange(c, false)).filter(Boolean);
  const paths = plain
    .map((c) => c.path)
    .slice(0, 5)
    .join(', ');
  const more = plain.length > 5 ? ` (+${plain.length - 5})` : '';
  const cmd = (command ?? 'shell').replace(/\s+/g, ' ').trim().slice(0, 60);
  const restored = changes.filter((c) => c.restoreOutcome === 'restored').map((c) => c.path);
  const notRestored = changes
    .filter((c) => c.restoreOutcome && c.restoreOutcome !== 'restored')
    .map((c) => c.path);
  const restoreEn = [
    restored.length ? `modified and restored: ${restored.slice(0, 5).join(', ')}` : '',
    notRestored.length ? `could not restore: ${notRestored.slice(0, 5).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const restoreZh = [
    restored.length ? `已被修改，已还原：${restored.slice(0, 5).join('、')}` : '',
    notRestored.length ? `未能还原：${notRestored.slice(0, 5).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  const stuckEn = [paths ? `protected path modified: ${paths}${more}` : '', ...detailEn, restoreEn];
  const stuckZh = [paths ? `受保护路径已被修改：${paths}${more}` : '', ...detailZh, restoreZh];
  const en = [
    paths ? `${cmd} modified protected path(s) ${paths}${more}` : cmd,
    ...detailEn,
    restoreEn,
  ];
  const zh = [paths ? `${cmd} 修改了受保护路径 ${paths}${more}` : cmd, ...detailZh, restoreZh];
  return {
    en: paths
      ? en.filter(Boolean).join('; ')
      : `${cmd}: protected path modified, ${[...detailEn, restoreEn].filter(Boolean).join('; ')}`,
    zh: paths
      ? zh.filter(Boolean).join('；')
      : `${cmd}：受保护路径已被修改，${[...detailZh, restoreZh].filter(Boolean).join('；')}`,
    stuckEn: stuckEn.filter(Boolean).join('; '),
    stuckZh: stuckZh.filter(Boolean).join('；'),
  };
}

// ── O152 auto-restore ───────────────────────────────────────────────────

/**
 * True when `abs` is the worktree `.git` *path* and currently a symlink (or
 * a gitfile we refuse to write through). Restore must not follow it.
 */
function gitDirIsUnsafeToWrite(cwd: string): boolean {
  const dotGit = path.join(cwd, '.git');
  try {
    const st = fs.lstatSync(dotGit);
    if (st.isSymbolicLink()) return true;
    // gitfile (linked worktree / separate-git-dir): do not recreate files
    // under the lexical `.git/` — they would land in the wrong place or
    // create a confusing directory next to the gitfile.
    if (st.isFile()) return true;
    return false;
  } catch {
    // Missing — we may recreate a real directory.
    return false;
  }
}

function ensureParentDir(abs: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o755 });
}

/**
 * O152: write snapshotted bytes back for every restore-eligible change.
 * - modified / deleted with a content snapshot → overwrite / recreate;
 * - added (did not exist before) → unlink;
 * - `.git` replaced by a symlink / gitfile → skip, outcome `skipped-symlink-git`;
 * - oversize / no snapshot → skip with the matching outcome;
 * - on success, also ensure a minimal `.git/{objects,refs,info}` so
 *   `git status` works after a whole-`.git` wipe.
 *
 * Never logs content or full hashes. Temp restoreDir (if any) is removed by
 * {@link disposeProtectedPathSnapshot}.
 */
/** Display path used when the post-run protected-path check itself failed. */
export const PROTECTED_PATHS_UNVERIFIED = '(protected paths)';

const TRANSIENT_WIN_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/**
 * O152 r6 (P1-W): on Windows an entry deleted while another handle is open
 * stays delete-pending until that handle closes; writes over it fail with
 * EPERM / EACCES / EBUSY for a moment. Retry briefly before giving up.
 */
function retryTransientSync(fn: () => void): void {
  const attempts = process.platform === 'win32' ? 20 : 1;
  for (let k = 0; ; k += 1) {
    try {
      fn();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (k + 1 >= attempts || !TRANSIENT_WIN_CODES.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export function restoreProtectedPathChanges(
  before: ProtectedPathSnapshot,
  changes: readonly ProtectedPathChange[],
  opts?: { skipApproved?: boolean }
): ProtectedPathRestore[] {
  const results: ProtectedPathRestore[] = [];
  if (changes.length === 0) return results;
  const skipApproved = opts?.skipApproved !== false;
  const unsafeGit = gitDirIsUnsafeToWrite(before.cwd);
  let restoredAnyGit = false;

  for (const c of changes) {
    let abs: string | undefined;
    for (const [a, d] of before.display) {
      if (d === c.path) {
        abs = a;
        break;
      }
    }
    if (!abs) abs = path.resolve(before.cwd, c.path);

    const eligible =
      isRestoreEligiblePath(abs) ||
      // Display path still names a restore target (gitfile → real gitdir abs).
      isRestoreEligiblePath(path.resolve(before.cwd, c.path)) ||
      /(^|\/)\.git\/(?:config|HEAD)$/.test(c.path.replace(/\\/g, '/')) ||
      /(^|\/)\.git\/hooks\//.test(c.path.replace(/\\/g, '/')) ||
      /(^|\/)\.env(?:rc|\.[^/]+)?$/.test(c.path.replace(/\\/g, '/'));

    if (!eligible) continue;

    if (skipApproved && isProtectedPathApproved(abs)) {
      results.push({ path: c.path, kind: c.kind, outcome: 'skipped-approved' });
      continue;
    }

    // O152 r1 F5: `.git` is a gitfile / symlink — never write through it; say so.
    if (unsafeGit) {
      results.push({ path: c.path, kind: c.kind, outcome: 'skipped-symlink-git' });
      continue;
    }

    const entry = before.entries.get(abs);
    const meta = entry && entry !== UNAVAILABLE ? entry : undefined;

    if (c.kind === 'added') {
      try {
        try {
          const st = fs.lstatSync(abs);
          if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(abs);
          else if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
        }
        results.push({ path: c.path, kind: c.kind, outcome: 'restored' });
      } catch {
        results.push({ path: c.path, kind: c.kind, outcome: 'failed' });
      }
      continue;
    }

    if (!meta) {
      results.push({ path: c.path, kind: c.kind, outcome: 'skipped-no-snapshot' });
      continue;
    }
    if (meta.oversize || (!meta.content && meta.size > RESTORE_MAX_BYTES)) {
      results.push({ path: c.path, kind: c.kind, outcome: 'skipped-oversize' });
      continue;
    }
    if (!meta.content) {
      results.push({ path: c.path, kind: c.kind, outcome: 'skipped-no-snapshot' });
      continue;
    }

    try {
      const mode = meta.mode ?? 0o600;
      const content = meta.content;
      retryTransientSync(() => atomicRestoreFile(abs!, content, mode));
      results.push({ path: c.path, kind: c.kind, outcome: 'restored' });
      if (/(^|[\\/])\.git([\\/]|$)/.test(abs.replace(/\\/g, '/'))) restoredAnyGit = true;
    } catch {
      results.push({ path: c.path, kind: c.kind, outcome: 'failed' });
    }
  }

  if (restoredAnyGit && !unsafeGit) {
    for (const sub of ['objects', 'refs', 'refs/heads', 'refs/tags', 'info']) {
      try {
        fs.mkdirSync(path.join(before.cwd, '.git', sub), { recursive: true, mode: 0o755 });
      } catch {
        /* ignore */
      }
    }
  }
  return results;
}

/**
 * O152 r1 F4: write to a same-dir temp file, then `rename` over the target.
 * `rename` replaces the directory entry and does not follow a symlink at
 * `abs`, closing the lstat→writeFile TOCTOU.
 */
function atomicRestoreFile(abs: string, content: Buffer, mode: number): void {
  ensureParentDir(abs);
  const dir = path.dirname(abs);
  const tmp = path.join(
    dir,
    `.moss-restore-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
  );
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      /* windows */
    }
    try {
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else if (st.isSymbolicLink()) fs.unlinkSync(abs);
      // regular file: rename below replaces it
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    fs.renameSync(tmp, abs);
    try {
      fs.chmodSync(abs, mode);
    } catch {
      /* windows */
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Remove any on-disk restore spill from {@link takeProtectedPathSnapshot}. */
export function disposeProtectedPathSnapshot(snap: ProtectedPathSnapshot | undefined): void {
  if (!snap?.restoreDir) return;
  try {
    fs.rmSync(snap.restoreDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  snap.restoreDir = undefined;
  // Drop in-memory content so a retained snapshot cannot leak into logs later.
  for (const [k, v] of snap.entries) {
    if (v !== UNAVAILABLE && v.content) {
      const { content: _c, raw: _r, ...rest } = v;
      snap.entries.set(k, rest);
    }
  }
}

/** O152: fold restore outcomes into the O98 reason strings. */
export function protectedPathModReasonWithRestore(
  changes: readonly ProtectedPathChange[],
  restores: readonly ProtectedPathRestore[] | undefined,
  command?: string
): { en: string; zh: string; stuckEn: string; stuckZh: string } {
  const base = protectedPathModReason(changes, command);
  if (!restores || restores.length === 0) return base;
  const restored = restores.filter((r) => r.outcome === 'restored').map((r) => r.path);
  const failed = restores
    .filter((r) => r.outcome !== 'restored')
    .map((r) => {
      if (r.outcome === 'skipped-oversize') return `${r.path} (over snapshot limit)`;
      if (r.outcome === 'skipped-symlink-git') return `${r.path} (.git is symlink/gitfile)`;
      if (r.outcome === 'failed') return `${r.path} (restore failed)`;
      return `${r.path} (not restored)`;
    });
  const zhFailed = restores
    .filter((r) => r.outcome !== 'restored')
    .map((r) => {
      if (r.outcome === 'skipped-oversize') return `${r.path}（超过快照上限）`;
      if (r.outcome === 'skipped-symlink-git') return `${r.path}（.git 已换成软链/gitfile）`;
      if (r.outcome === 'failed') return `${r.path}（未能还原）`;
      return `${r.path}（未还原）`;
    });
  const enExtra = [
    restored.length ? `modified and restored: ${restored.slice(0, 5).join(', ')}` : '',
    failed.length ? `could not restore: ${failed.slice(0, 5).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const zhExtra = [
    restored.length ? `已被修改，已还原：${restored.slice(0, 5).join('、')}` : '',
    zhFailed.length ? `未能还原：${zhFailed.slice(0, 5).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  return {
    en: enExtra ? `${base.en}; ${enExtra}` : base.en,
    zh: zhExtra ? `${base.zh}；${zhExtra}` : base.zh,
    stuckEn: enExtra ? `${base.stuckEn}; ${enExtra}` : base.stuckEn,
    stuckZh: zhExtra ? `${base.stuckZh}；${zhExtra}` : base.stuckZh,
  };
}
