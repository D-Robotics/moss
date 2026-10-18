/**
 * O158 — where Moss finds the programs it starts.
 *
 * Windows looks in the current directory before PATH when it is handed a bare
 * program name: `where.exe`, Node/libuv `spawn` (unless the parent env has
 * `NoDefaultCurrentDirectoryInExePath`), and cmd.exe all do it. A cloned repo
 * that ships `pwsh.exe`, `git.exe`, or `node.exe` at its root therefore had
 * those run as soon as Moss started in it (startup pwsh probe, git snapshot),
 * before the model did anything. POSIX has the same hole when PATH holds an
 * empty entry or `.`.
 *
 * Every child Moss starts goes through `run-process.ts`, which calls
 * {@link resolveExecutable} for a bare name and spawns the absolute result.
 * The search only uses PATH entries that are absolute directories. It drops
 * empty entries, `.`, relative entries, and entries whose realpath is the
 * current directory, the child's cwd, or inside either of them. No search
 * looks at the current directory. When the workspace is the home directory or
 * a filesystem root, only that exact directory is dropped, so `~/bin`, `~/.nvm`
 * and `%LOCALAPPDATA%\Microsoft\WindowsApps` keep working there.
 *
 * Children also get a PATH without empty or relative entries
 * ({@link sanitizeChildPathEnv}) and, on Windows,
 * `NoDefaultCurrentDirectoryInExePath=1`, so their own lookups (cmd.exe,
 * libuv, pwsh) do not pick a program out of the workspace either. A name with
 * a directory in it (`.\x.exe`, `./x`, `C:\x\y.exe`) is the caller's choice
 * and is spawned as given.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NO_CWD_EXE_SEARCH_ENV = 'NoDefaultCurrentDirectoryInExePath';

type Env = Record<string, string | undefined>;

export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  /** Source of PATH (and nothing else). Defaults to `process.env`. */
  env?: Env;
  /** The child's cwd. Entries inside it are dropped too. */
  cwd?: string;
  /** Moss's own cwd (the workspace). Defaults to `process.cwd()`. */
  processCwd?: string;
  home?: string;
  /** Absolute files tried after PATH (known install locations). */
  fallbacks?: readonly string[];
  /** Windows only: extensions to try; defaults to libuv's (`.com`, `.exe`). */
  extensions?: readonly string[];
  isFile?: (candidate: string) => boolean;
  realpath?: (p: string) => string;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** True for a program name with no directory part (`git`, `pwsh.exe`). */
export function isBareCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!command || command === '.' || command === '..') return false;
  return platform === 'win32' ? !/[\\/:]/.test(command) : !command.includes('/');
}

/** The PATH value of `env`, matching the key case-insensitively on Windows. */
export function envPathKey(
  env: Env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'win32') return 'PATH' in env ? 'PATH' : undefined;
  if ('PATH' in env) return 'PATH';
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
}

function defaultIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    // App Execution Aliases (WindowsApps\pwsh.exe) are reparse points that
    // stat() cannot follow; lstat still sees them.
    try {
      const st = fs.lstatSync(candidate);
      return !st.isDirectory();
    } catch {
      return false;
    }
  }
}

function defaultRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function samePath(api: path.PlatformPath, a: string, b: string, win: boolean): boolean {
  const ra = api.resolve(a);
  const rb = api.resolve(b);
  return win ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function sameOrInside(api: path.PlatformPath, dir: string, root: string, win: boolean): boolean {
  const norm = (p: string) => {
    const r = api.resolve(p);
    return win ? r.toLowerCase() : r;
  };
  const d = norm(dir);
  const r = norm(root);
  if (d === r) return true;
  const rel = api.relative(r, d);
  return rel !== '' && !rel.startsWith('..') && !api.isAbsolute(rel);
}

function isBroadRoot(api: path.PlatformPath, dir: string, home: string, win: boolean): boolean {
  const r = api.resolve(dir);
  if (api.parse(r).root === r || api.dirname(r) === r) return true;
  if (!home) return false;
  const h = api.resolve(home);
  return win ? r.toLowerCase() === h.toLowerCase() : r === h;
}

/**
 * PATH entries Moss may resolve a program from: absolute, not the current
 * directory or the child's cwd, and not inside either.
 */
export function trustedSearchDirs(options: ResolveExecutableOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const win = platform === 'win32';
  const api = pathApi(platform);
  const env = options.env ?? process.env;
  const realpath = options.realpath ?? defaultRealpath;
  const home = options.home ?? os.homedir();
  const key = envPathKey(env, platform);
  const raw = key ? (env[key] ?? '') : '';
  const roots = [options.processCwd ?? process.cwd(), options.cwd]
    .filter((p): p is string => typeof p === 'string' && p.length > 0 && api.isAbsolute(p))
    .flatMap((p) => [p, realpath(p)]);
  const out: string[] = [];
  for (const piece of raw.split(win ? ';' : ':')) {
    const dir = (win ? piece.trim().replace(/^"(.*)"$/, '$1') : piece).trim();
    if (!dir || dir === '.' || !api.isAbsolute(dir)) continue;
    // `\foo` and `C:foo` are drive-relative on Windows.
    if (win && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(dir)) continue;
    const real = realpath(dir);
    const excluded = roots.some((root) =>
      [dir, real].some((candidate) =>
        isBroadRoot(api, root, home, win)
          ? samePath(api, candidate, root, win)
          : sameOrInside(api, candidate, root, win)
      )
    );
    if (!excluded) out.push(dir);
  }
  return out;
}

const WIN_SPAWN_EXTS = ['.com', '.exe'];

/**
 * Absolute path of `name` from {@link trustedSearchDirs}, then `fallbacks`.
 * Null when it is not there. A name with a directory part is returned as is.
 */
export function resolveExecutable(
  name: string,
  options: ResolveExecutableOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  if (!isBareCommand(name, platform)) return name;
  const win = platform === 'win32';
  const api = pathApi(platform);
  const isFile = options.isFile ?? defaultIsFile;
  const exts = options.extensions ?? WIN_SPAWN_EXTS;
  const base = api.basename(name);
  const dot = base.lastIndexOf('.');
  const hasExt = win && dot > 0 && dot < base.length - 1;
  const names = win
    ? [
        ...(hasExt ? [name] : []),
        ...exts
          .filter((ext) => !(hasExt && name.toLowerCase().endsWith(ext.toLowerCase())))
          .map((ext) => name + ext.toLowerCase()),
      ]
    : [name];
  for (const dir of trustedSearchDirs(options)) {
    for (const candidate of names) {
      const full = api.join(dir, candidate);
      if (isFile(full) && (win || isExecutable(full))) return full;
    }
  }
  const roots = [options.processCwd ?? process.cwd(), options.cwd].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  );
  for (const file of options.fallbacks ?? []) {
    if (!api.isAbsolute(file) || !isFile(file)) continue;
    const dir = api.dirname(file);
    const home = options.home ?? os.homedir();
    const inside = roots.some(
      (root) => !isBroadRoot(api, root, home, win) && sameOrInside(api, dir, root, win)
    );
    if (!inside) return file;
  }
  return null;
}

function isExecutable(file: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Child env with PATH stripped of empty, `.` and relative entries (a child
 * resolves those against its cwd, the workspace) and, on Windows,
 * `NoDefaultCurrentDirectoryInExePath=1`. Returns `env` itself when nothing
 * changes.
 */
export function sanitizeChildPathEnv<T extends Env>(
  env: T,
  platform: NodeJS.Platform = process.platform
): T {
  const win = platform === 'win32';
  const api = pathApi(platform);
  let next: Env | undefined;
  const key = envPathKey(env, platform);
  if (key !== undefined) {
    const value = env[key] ?? '';
    const sep = win ? ';' : ':';
    const kept = value.split(sep).filter((piece) => {
      const dir = (win ? piece.trim().replace(/^"(.*)"$/, '$1') : piece).trim();
      if (!dir || dir === '.' || !api.isAbsolute(dir)) return false;
      return !win || /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(dir);
    });
    const cleaned = kept.join(sep);
    if (cleaned !== value) {
      next = { ...env };
      next[key] = cleaned;
    }
  }
  if (win) {
    const has = Object.keys(env).some(
      (k) => k.toUpperCase() === NO_CWD_EXE_SEARCH_ENV.toUpperCase()
    );
    if (!has) {
      next = next ?? { ...env };
      next[NO_CWD_EXE_SEARCH_ENV] = '1';
    }
  }
  return (next ?? env) as T;
}
