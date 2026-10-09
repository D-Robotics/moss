/**
 * Environment variables a project `.env` must not set.
 *
 * They choose an interpreter, a dynamic linker, a shell startup file, or a
 * package manager that can execute code. The real process environment may
 * still set them; only values introduced by a project `.env` are refused.
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
  'ZDOTDIR',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_ASKPASS',
  'PATH',
  'SHELL',
]);

const PREFIXES = ['DYLD_', 'GIT_CONFIG_', 'NPM_CONFIG_'];

export function isDotenvDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (EXACT_KEYS.has(upper)) return true;
  return PREFIXES.some((prefix) => upper.startsWith(prefix));
}
