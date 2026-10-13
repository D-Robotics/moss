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
 * config, HEAD, refs/**, hooks/** (including newly added hooks). For
 * `.git/config` content edits, changes confined to allow-listed benign keys
 * are not reported (O117, GIT_CONFIG_BENIGN_KEYS); any other key counts; add/delete/symlink swap or unparsable
 * content still reports the whole file (fail-closed). Normal
 * git commit writes (index, objects, logs, ORIG_HEAD, …) are ignored, and
 * HEAD / refs/** changes are reported only when anomalous (O123: points
 * outside refs/, not a commit id, symlink/dir swap).
 *
 * Snapshot unavailable (permission) → skip that path; never false-report
 * "modified". `exec_background` runs the same check on full process exit
 * (O108). Delayed writes via `&` / `nohup` inside a foreground command, and
 * writes after the Moss process itself exits, remain known limits.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PathChangeKind = 'added' | 'modified' | 'deleted';

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
  | 'gitlink-missing';

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
    const res = spawnSync('git', ['config', '--file', file, '--no-includes', '--list', '-z'], {
      cwd: tmpDir,
      encoding: 'buffer',
      timeout: 5000,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        HOME: tmpDir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
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
    return {
      mtimeMs: st.mtimeMs,
      size: st.size,
      hash: crypto.createHash('sha256').update(buf).digest('hex'),
      type: 'file',
      ...(isGitConfigPath(abs) ? { raw: buf } : {}),
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
    // Unavailable on either side → skip (do not false-report).
    if (b === UNAVAILABLE || a === UNAVAILABLE) continue;
    const display = after.display.get(abs) ?? before.display.get(abs) ?? abs.replace(/\\/g, '/');
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
  command?: string
): string {
  if (changes.length === 0) return '';
  const cmd = (command ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const list = changes
    .map((c) => {
      const detail = describeGitConfigChange(c, zh);
      if (detail) return detail;
      return `${c.path} (${zh ? KIND_ZH[c.kind] : KIND_EN[c.kind]})`;
    })
    .join(zh ? '；' : '; ');
  const hints = inspectHints(changes);
  const markerPaths = changes.map((c) => c.path).join(',');
  const detailLines = changes
    .filter((c) => describeGitConfigChange(c, true))
    .map(
      (c) =>
        `${PROTECTED_PATH_DETAIL_MARKER} ${[
          c.path,
          c.kind,
          c.reason ?? '',
          (c.keys ?? []).join(','),
        ]
          .map((x) => x.replace(/[\t\n]/g, ' '))
          .join('\t')}`
    );
  const lines = zh
    ? [
        `${PROTECTED_PATH_MOD_MARKER} paths=${markerPaths}`,
        ...detailLines,
        `[moss] 受保护路径已被修改（命令已执行，Moss 没有拦截也没有自动还原）：${list}`,
        cmd ? `命令：${cmd}` : '',
        `请自行检查。可复制：`,
        ...hints.map((h) => `  ${h}`),
      ]
    : [
        `${PROTECTED_PATH_MOD_MARKER} paths=${markerPaths}`,
        ...detailLines,
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
  const details = new Map<string, ProtectedPathChange>();
  for (const line of text.split('\n')) {
    if (!line.startsWith(PROTECTED_PATH_DETAIL_MARKER)) continue;
    const [p, kind, reason, keys] = line.slice(PROTECTED_PATH_DETAIL_MARKER.length + 1).split('\t');
    if (!p) continue;
    const k = (['added', 'modified', 'deleted'] as const).find((x) => x === kind) ?? 'modified';
    const r = ALL_REASONS.find((x) => x === reason);
    const ks = (keys ?? '').split(',').filter(Boolean);
    details.set(p, {
      path: p,
      kind: k,
      ...(r ? { reason: r } : {}),
      ...(ks.length ? { keys: ks } : {}),
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
  const stuckEn = [paths ? `protected path modified: ${paths}${more}` : '', ...detailEn];
  const stuckZh = [paths ? `受保护路径已被修改：${paths}${more}` : '', ...detailZh];
  const en = [paths ? `${cmd} modified protected path(s) ${paths}${more}` : cmd, ...detailEn];
  const zh = [paths ? `${cmd} 修改了受保护路径 ${paths}${more}` : cmd, ...detailZh];
  return {
    en: paths ? en.join('; ') : `${cmd}: protected path modified, ${detailEn.join('; ')}`,
    zh: paths ? zh.join('；') : `${cmd}：受保护路径已被修改，${detailZh.join('；')}`,
    stuckEn: stuckEn.filter(Boolean).join('; '),
    stuckZh: stuckZh.filter(Boolean).join('；'),
  };
}
