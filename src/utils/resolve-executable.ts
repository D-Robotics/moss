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

/** POSIX default search path when the env has no PATH (execvp's _CS_PATH). */
export const POSIX_DEFAULT_PATH = '/usr/bin:/bin';

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
  // O158 F3: `..dotbin` is a child, not the parent (`..` or `../…`).
  if (rel === '' || api.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + api.sep);
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
  // O158 F1: with no PATH at all, POSIX execvp/libuv search `/usr/bin:/bin`
  // (confstr _CS_PATH). Search the same so git still resolves, never cwd.
  const raw = key ? (env[key] ?? '') : win ? '' : POSIX_DEFAULT_PATH;
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
 * O158 F1: PATH for a child whose bare name did not resolve and that has no
 * trusted PATH entry left. An empty PATH makes libuv/execvp search the cwd
 * (the workspace), so use an absolute directory that does not exist: the
 * spawn fails with ENOENT.
 */
export const NO_TRUSTED_PATH_POSIX = '/nonexistent/moss-no-trusted-path';

/** True for a UNC / device path (`\\host\share`, `//host/share`, `\\?\`). */
function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

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
  const realpath = options.realpath ?? defaultRealpath;
  const home = options.home ?? os.homedir();
  const allRoots = roots.flatMap((root) => [root, realpath(root)]);
  for (const file of options.fallbacks ?? []) {
    // O158 F2: drive-absolute only; never a UNC share (`\\localhost\C$\…`
    // aliases the workspace, `\\host\s` is someone else's program).
    if (!api.isAbsolute(file) || (win && (isUncPath(file) || !/^[A-Za-z]:[\\/]/.test(file))))
      continue;
    if (!isFile(file)) continue;
    const dir = api.dirname(file);
    const realDir = realpath(dir);
    if (win && isUncPath(realDir)) continue;
    // realpath too: 8.3 short names and symlinks must not alias the workspace.
    const inside = allRoots.some(
      (root) =>
        !isBroadRoot(api, root, home, win) &&
        [dir, realDir].some((candidate) => sameOrInside(api, candidate, root, win))
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

const SH_BUILTINS = new Set(
  (
    '! { } [ [[ . : alias bg break case cd command continue declare echo eval exec exit export ' +
    'false fc fg for function getopts hash if jobs kill let local printf pwd read readonly ' +
    'return select set shift source test time times trap true type typeset ulimit umask ' +
    'unalias unset until wait while'
  ).split(' ')
);
const CMD_BUILTINS = new Set(
  (
    'assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype ' +
    'goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set ' +
    'setlocal shift start time title type ver verify vol'
  ).split(' ')
);
const CMD_HEAD_EXTS = ['.com', '.exe', '.bat', '.cmd'];

/**
 * O158 (PM ruling on O1): the program a hook command starts with (`node x.js`,
 * `git …`, `pwsh -File …`) is resolved by Moss's own rules, so a PATH entry
 * inside the workspace (e.g. `$WS/node_modules/.bin` when moss was started via
 * npx / npm run) cannot supply it. The head word is replaced with its quoted
 * absolute path. Shell builtins/keywords, names that do not resolve, and heads
 * with a directory part are left alone; what the hook runs after that is the
 * hook's own business.
 */
export function resolveCommandHead(
  command: string,
  shell: 'sh' | 'cmd',
  options: ResolveExecutableOptions = {}
): string {
  const m = /^(\s*)([A-Za-z0-9_][A-Za-z0-9._+-]*)(?=\s|$)/.exec(command);
  if (!m) return command;
  const [, lead, name] = m;
  const builtins = shell === 'cmd' ? CMD_BUILTINS : SH_BUILTINS;
  if (builtins.has(shell === 'cmd' ? name.toLowerCase() : name)) return command;
  const found = resolveExecutable(name, {
    ...options,
    platform: options.platform ?? (shell === 'cmd' ? 'win32' : process.platform),
    ...(shell === 'cmd' ? { extensions: CMD_HEAD_EXTS } : {}),
  });
  if (!found || found === name) return command;
  let quoted: string;
  if (shell === 'cmd') {
    if (/["%^&|<>]/.test(found)) return command;
    quoted = `"${found}"`;
  } else {
    const q = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;
    // `npx …` → '/usr/bin/node' '/usr/bin/npx' …, so `env node` is not looked up.
    quoted = (envShebangCommand(found, options) ?? [found]).map(q).join(' ');
  }
  return lead + quoted + command.slice(lead.length + name.length);
}

/**
 * O158 (PM ruling on O1): a resolved POSIX script that starts with
 * `#!/usr/bin/env <prog>` (npx, npm, most node CLIs) would have `env` look
 * `<prog>` up on the child's PATH, which may hold `$WS/node_modules/.bin`.
 * Returns `[absolute interpreter, ...its args, script]` resolved by Moss's
 * rules, or null when the file has no `env` shebang or the interpreter does
 * not resolve (then the kernel's own handling applies as before).
 */
export function envShebangCommand(
  file: string,
  options: ResolveExecutableOptions = {}
): string[] | null {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' || !path.posix.isAbsolute(file)) return null;
  let head: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const line = /^#!\s*(\S+)([^\r\n]*)/.exec(head);
  if (!line || path.posix.basename(line[1]) !== 'env') return null;
  const words = line[2].trim().split(/\s+/).filter(Boolean);
  if (words[0] === '-S') words.shift();
  const prog = words.shift();
  if (!prog || prog.startsWith('-') || prog.includes('=')) return null;
  const interpreter = resolveExecutable(prog, { ...options, platform });
  if (!interpreter || interpreter === prog) return null;
  return [interpreter, ...words, file];
}
