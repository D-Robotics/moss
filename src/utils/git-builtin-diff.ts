/**
 * Built-in diff stand-in for an untrusted repo's `diff.external` and
 * `diff.<name>.command`. Git execs this file. It reproduces
 * `git diff --no-ext-diff` and does not run repo programs.
 *
 * The script needs `sh` (and awk). When `sh` is not on the machine,
 * {@link builtinExternalDiffCommand} returns null and the shell leaves those
 * keys unset. That is the Windows fallback when Git Bash is not installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Verified script. Keep the text byte-for-byte. */
export const GIT_BUILTIN_DIFF_SCRIPT =
  '#!/bin/sh\n# Built-in-diff stand-in for GIT_EXTERNAL_DIFF / diff.external / diff.<name>.command.\n# git calls: <path> <old-file> <old-hex> <old-mode> <new-file> <new-hex> <new-mode> (7 args), or <path> (1 arg, unmerged).\n# Runs git\'s own diff on the two temp files and relabels the headers to <path>. Never runs repo programs.\n[ "$#" -ge 7 ] || { echo "* Unmerged path $1"; exit 0; }\np=$1\ngit --no-pager diff --no-index --no-ext-diff --no-textconv --no-color -- "$2" "$5" |\nawk -v p="$p" \'BEGIN { t = index(p, " ") ? "\\t" : "" }\n  !h && /^diff --git / { print "diff --git a/" p " b/" p; next }\n  !h && /^--- a\\//     { print "--- a/" p t; next }\n  !h && /^\\+\\+\\+ b\\//  { print "+++ b/" p t; next }\n  !h && /^Binary files / {\n    sub(/^Binary files [^ ]+/, "Binary files " ($0 ~ /^Binary files \\/dev\\/null/ ? "/dev/null" : "a/" p))\n    sub(/ and [^ ]+ differ$/, " and " ($0 ~ / and \\/dev\\/null differ$/ ? "/dev/null" : "b/" p) " differ")\n  }\n  /^@@/ { h = 1 }\n  { print }\'\nexit 0\n';

let cached: string | null | undefined;

function shellAvailable(): boolean {
  if (process.platform !== 'win32') {
    return fs.existsSync('/bin/sh') || fs.existsSync('/usr/bin/sh');
  }
  const pathEnv = process.env.PATH || process.env.Path || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ['sh.exe', 'sh.cmd', 'sh.bat', 'sh']) {
      if (fs.existsSync(path.join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * Absolute path of the materialized script, or null when `sh` is missing
 * or the file cannot be written. Null means leave `diff.external` unset.
 */
export function builtinExternalDiffCommand(): string | null {
  if (cached !== undefined) return cached;
  cached = materialize();
  return cached;
}

function materialize(): string | null {
  if (!shellAvailable()) return null;
  const dest = path.join(os.tmpdir(), 'moss-git-builtin-diff.sh');
  try {
    let current = '';
    try {
      current = fs.readFileSync(dest, 'utf8');
    } catch {
      current = '';
    }
    if (current !== GIT_BUILTIN_DIFF_SCRIPT) {
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, GIT_BUILTIN_DIFF_SCRIPT, { mode: 0o755 });
      fs.renameSync(tmp, dest);
    }
    fs.chmodSync(dest, 0o755);
  } catch {
    return null;
  }
  return dest;
}
