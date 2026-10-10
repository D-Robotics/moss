/**
 * Built-in diff stand-in for an untrusted repo's `diff.external` and
 * `diff.<name>.command`. Git execs the materialized file. It reproduces
 * `git diff --no-ext-diff` and does not run repo programs.
 *
 * Git does not pass `-R`, `-U`, `--word-diff`, `--color-words`, `--binary`,
 * prefix options (`--src-prefix`, `--dst-prefix`), or `--color` through to an
 * external diff. The script therefore always emits a no-color, no-ext-diff
 * hunk. That is git's own limit.
 *
 * The script is written under the per-user Moss config directory
 * (`MOSS_CONFIG_DIR`, else the XDG/home config dir), in a `0700` directory.
 * That parent must be owned by the current user and not group/other writable,
 * and the script directory's owner and mode are checked before use. A shared
 * temp path is not used: another local user can pre-create
 * `os.tmpdir()/moss-git-builtin-diff.sh`. When the file cannot be installed
 * safely, or `sh` is missing, callers point `diff.external` and
 * `diff.<name>.command` at `false` instead of leaving the repo command in place.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envBeforeDotenv, isStartupEnvCaptured } from './startup-env.js';

/** Verified v3 script. Keep the text byte-for-byte. */
export const GIT_BUILTIN_DIFF_SCRIPT = [
  '#!/bin/sh',
  '# Built-in-diff stand-in for diff.external / diff.<name>.command (v3).',
  '# git calls: <path> <old-file> <old-hex> <old-mode> <new-file> <new-hex> <new-mode> [<new-path> <xfrm-msg>]',
  "# (9 args for renames/copies), or <path> (unmerged). Headers are rebuilt from git's own arguments",
  '# (rename metadata, mode changes, new/deleted file modes, C-style path quoting); only the hunks or the',
  '# "Binary files" line come from `git diff --no-index` on the two temp files. Never runs repo programs.',
  '# The rename/copy message is a multi-line argument. BSD awk rejects raw newlines and \\n in -v, so it',
  '# is written to a temp file and read with getline.',
  '[ "$#" -ge 7 ] || { echo "* Unmerged path $1"; exit 0; }',
  'qp=$(git config --bool core.quotepath 2>/dev/null) || qp=true',
  'tmp=${TMPDIR:-/tmp}',
  'tmp=${tmp%/}',
  'meta=$(mktemp "$tmp/moss-git-xf.XXXXXX" 2>/dev/null) || meta=',
  'trap \'if [ -n "$meta" ]; then rm -f "$meta"; fi\' EXIT',
  'if [ -n "$meta" ]; then',
  '  printf \'%s\' "${9-}" > "$meta" || { rm -f "$meta"; meta=; }',
  'fi',
  'git --no-pager diff --no-index --no-ext-diff --no-textconv --no-color -- "$2" "$5" |',
  'LC_ALL=C awk -v op="$1" -v np="${8:-$1}" -v om="$4" -v nm="$7" -v qp="$qp" -v meta="$meta" \'',
  'function q(s,   i, c, o, r, need) {',
  '  r = ""; need = 0',
  '  for (i = 1; i <= length(s); i++) {',
  '    c = substr(s, i, 1); o = ord[c]',
  '    if (c == "\\"" || c == "\\\\") { r = r "\\\\" c; need = 1 }',
  '    else if (c == "\\t") { r = r "\\\\t"; need = 1 } else if (c == "\\n") { r = r "\\\\n"; need = 1 }',
  '    else if (c == "\\r") { r = r "\\\\r"; need = 1 } else if (c == "\\a") { r = r "\\\\a"; need = 1 }',
  '    else if (c == "\\b") { r = r "\\\\b"; need = 1 } else if (c == "\\f") { r = r "\\\\f"; need = 1 }',
  '    else if (c == "\\v") { r = r "\\\\v"; need = 1 }',
  '    else if (o < 32 || o == 127 || (o >= 128 && qp != "false")) { r = r sprintf("\\\\%03o", o); need = 1 }',
  '    else r = r c',
  '  }',
  '  return need ? "\\"" r "\\"" : s',
  '}',
  'function label(s,   l) { l = q(s); return (l == s && index(s, " ")) ? s "\\t" : l }',
  'BEGIN {',
  '  for (i = 1; i < 256; i++) ord[sprintf("%c", i)] = i',
  '  isnew = (om == "." || om == "0000000"); isdel = (nm == "." || nm == "0000000")',
  '  A = "a/" op; B = "b/" np',
  '  xf = ""',
  '  if (meta != "") {',
  '    n = 0',
  '    while ((getline line < meta) > 0) {',
  '      if (n > 0) xf = xf "\\n" line',
  '      else xf = line',
  '      n++',
  '    }',
  '    close(meta)',
  '  }',
  '}',
  '/^index / && !h { idx = $2; next }',
  '/^@@/ || /^Binary files / { h = 1 }',
  'h { body = body $0 "\\n" }',
  'END {',
  '  if (body == "" && xf == "" && (om == nm || isnew || isdel)) exit',
  '  print "diff --git " q(A) " " q(B)',
  '  if (xf != "") print xf',
  '  else {',
  '    if (isnew) print "new file mode " nm',
  '    else if (isdel) print "deleted file mode " om',
  '    else if (om != nm) { print "old mode " om; print "new mode " nm }',
  '    if (idx != "") print "index " idx ((om == nm && !isnew && !isdel) ? " " om : "")',
  '  }',
  '  if (body ~ /^Binary files /) {',
  '    print "Binary files " (isnew ? "/dev/null" : q(A)) " and " (isdel ? "/dev/null" : q(B)) " differ"',
  '  } else if (body != "") {',
  '    print "--- " (isnew ? "/dev/null" : label(A)); print "+++ " (isdel ? "/dev/null" : label(B))',
  '    printf "%s", body',
  '  }',
  '}',
  "'",
  'exit 0',
]
  .join('\n')
  .concat('\n');

/**
 * Command git execs when the builtin script cannot be installed safely.
 * `diff.external` cannot be set to `git diff --no-ext-diff` through config, so
 * the value is the `false` builtin: git does not run the repo program.
 */
export const EXTERNAL_DIFF_DISABLED_COMMAND = 'false';

const SCRIPT_DIR = 'git-builtin-diff';
const SCRIPT_NAME = 'moss-git-builtin-diff.sh';

export interface BuiltinExternalDiff {
  /** Absolute script path, or {@link EXTERNAL_DIFF_DISABLED_COMMAND}. */
  command: string;
  /** True when this exec must not leave the repo's external diff active. */
  disabled: boolean;
}

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = err.code;
  return typeof code === 'string' ? code : undefined;
}

function configLocationEnv(): NodeJS.ProcessEnv {
  if (!isStartupEnvCaptured()) return process.env;
  const source: NodeJS.ProcessEnv = { ...envBeforeDotenv };
  const live = process.env.MOSS_CONFIG_DIR;
  if (live === undefined) delete source.MOSS_CONFIG_DIR;
  else source.MOSS_CONFIG_DIR = live;
  return source;
}

function homeFrom(env: NodeJS.ProcessEnv): string {
  const named =
    process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return os.homedir();
}

/** Same directory rules as workspace trust's user config dir. */
function mossConfigDir(): string {
  const env = configLocationEnv();
  const explicit = env.MOSS_CONFIG_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const home = homeFrom(env);
  const base =
    process.platform === 'win32'
      ? (typeof env.APPDATA === 'string' && env.APPDATA.trim()) ||
        path.join(home, 'AppData', 'Roaming')
      : (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()) ||
        path.join(home, '.config');
  return path.join(base, 'moss');
}

function ownedByCurrentUser(st: fs.Stats): boolean {
  if (process.platform === 'win32') return true;
  if (typeof process.getuid !== 'function') return false;
  return st.uid === process.getuid();
}

function directoryModeIsPrivate(st: fs.Stats): boolean {
  if (process.platform === 'win32') return true;
  return (st.mode & 0o777) === 0o700;
}

function fileModeIsPrivate(st: fs.Stats): boolean {
  if (process.platform === 'win32') return true;
  const mode = st.mode & 0o777;
  return (mode & 0o022) === 0 && (mode & 0o100) !== 0;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    return null;
  }
}

/**
 * Moss config directory: owned by this user, not a symlink, and not
 * group/other writable. `0755` is fine. A group-writable or foreign parent
 * is refused rather than repaired, because another user could replace the
 * script directory underneath it.
 */
function configDirIsSafe(dir: string): boolean {
  let st = lstatOrNull(dir);
  if (!st) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
    st = lstatOrNull(dir);
  }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  if (!ownedByCurrentUser(st)) return false;
  if (process.platform !== 'win32' && (st.mode & 0o022) !== 0) return false;
  return true;
}

/**
 * `0700` directory owned by this user, and not a symlink. An existing
 * directory we own is tightened to `0700`. Anything else is refused.
 */
function privateDiffDir(dir: string): boolean {
  let st = lstatOrNull(dir);
  if (!st) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
    st = lstatOrNull(dir);
  }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  if (!ownedByCurrentUser(st)) return false;
  if (!directoryModeIsPrivate(st)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      return false;
    }
    st = lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory() || !ownedByCurrentUser(st)) return false;
    if (!directoryModeIsPrivate(st)) return false;
  }
  return true;
}

function scriptIsSafe(file: string): boolean {
  const st = lstatOrNull(file);
  if (!st || st.isSymbolicLink() || !st.isFile()) return false;
  if (!ownedByCurrentUser(st) || !fileModeIsPrivate(st)) return false;
  try {
    return fs.readFileSync(file, 'utf8') === GIT_BUILTIN_DIFF_SCRIPT;
  } catch {
    return false;
  }
}

function removePath(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    return errnoCode(err) === 'ENOENT';
  }
}

function installScript(dir: string): string | null {
  if (!privateDiffDir(dir)) return null;
  const dest = path.join(dir, SCRIPT_NAME);
  const existing = lstatOrNull(dest);
  if (
    existing &&
    (existing.isSymbolicLink() || !existing.isFile() || !ownedByCurrentUser(existing))
  ) {
    if (!removePath(dest)) return null;
  } else if (existing && !fileModeIsPrivate(existing)) {
    try {
      fs.chmodSync(dest, 0o700);
    } catch {
      if (!removePath(dest)) return null;
    }
  }
  if (scriptIsSafe(dest)) return dest;
  const tmp = path.join(dir, `.${SCRIPT_NAME}.${process.pid}.tmp`);
  if (!removePath(tmp)) return null;
  try {
    fs.writeFileSync(tmp, GIT_BUILTIN_DIFF_SCRIPT, { mode: 0o700, flag: 'wx' });
    fs.renameSync(tmp, dest);
  } catch {
    removePath(tmp);
    return null;
  }
  try {
    fs.chmodSync(dest, 0o700);
  } catch {
    return null;
  }
  return scriptIsSafe(dest) ? dest : null;
}

function shellAvailable(): boolean {
  if (process.platform !== 'win32') {
    return fs.existsSync('/bin/sh') || fs.existsSync('/usr/bin/sh');
  }
  const pathEnv = process.env.PATH || process.env.Path || '';
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    for (const name of ['sh.exe', 'sh.cmd', 'sh.bat', 'sh']) {
      if (fs.existsSync(path.join(entry, name))) return true;
    }
  }
  return false;
}

/**
 * Script git should exec for a repo external diff, re-checked on every call.
 * `disabled` means the command is `false`: the repo program stays inactive.
 */
export function builtinExternalDiffCommand(): BuiltinExternalDiff {
  if (!shellAvailable()) {
    return { command: EXTERNAL_DIFF_DISABLED_COMMAND, disabled: true };
  }
  const configDir = mossConfigDir();
  if (!configDirIsSafe(configDir)) {
    return { command: EXTERNAL_DIFF_DISABLED_COMMAND, disabled: true };
  }
  const installed = installScript(path.join(configDir, SCRIPT_DIR));
  if (!installed) {
    return { command: EXTERNAL_DIFF_DISABLED_COMMAND, disabled: true };
  }
  return { command: installed, disabled: false };
}
