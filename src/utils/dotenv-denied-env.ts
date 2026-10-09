/**
 * Environment variables a project `.env` must not set.
 *
 * They choose an interpreter, a dynamic linker, a shell startup file, shell
 * word-splitting (`IFS`), a temp directory (`TMPDIR` / `TMP` / `TEMP`), a git
 * repository or config file (`GIT_*`, including `GIT_DIR`, `GIT_CONFIG`,
 * `GIT_WORK_TREE`, `GIT_COMMON_DIR`, and `GIT_OBJECT_DIRECTORY`), or a
 * package manager that can execute code. The real
 * process environment may still set them; only values introduced by a project
 * `.env` are refused.
 * Matching is case-insensitive so `npm_config_*` and `NPM_CONFIG_*` are one
 * prefix.
 */

const EXACT_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'BASH_ENV',
  'ENV',
  'IFS',
  'ZDOTDIR',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
]);

const PREFIXES = ['DYLD_', 'GIT_', 'NPM_CONFIG_'];

export function isDotenvDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (EXACT_KEYS.has(upper)) return true;
  return PREFIXES.some((prefix) => upper.startsWith(prefix));
}
