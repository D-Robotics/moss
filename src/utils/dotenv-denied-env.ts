/**
 * Environment variables a project `.env` must not set.
 *
 * They choose an interpreter, an editor command (`VISUAL` / `EDITOR`, run by
 * the TUI's external-editor key), an exported bash function (`BASH_FUNC_*`),
 * a dynamic linker, a shell startup file, shell word-splitting (`IFS`), a temp directory (`TMPDIR` / `TMP` / `TEMP`), a git
 * repository or config file (`GIT_*`, including `GIT_DIR`, `GIT_CONFIG`,
 * `GIT_WORK_TREE`, `GIT_COMMON_DIR`, and `GIT_OBJECT_DIRECTORY`), or a
 * package manager that can execute code. Provider `*_BASE_URL` and `*_API_BASE`
 * names are refused too: a project file must not point the user's key at a
 * host it picked. Proxy, TLS, extra-CA, compaction, and fallback variables
 * are not in this list: an untrusted folder ignores them and a trusted folder
 * may apply them (`project-routing-env.ts`). The real process environment may
 * still set them; only values introduced by a project `.env` are refused.
 * Matching is case-insensitive so `npm_config_*` and `NPM_CONFIG_*` are one
 * prefix.
 */

const EXACT_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
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
  'VISUAL',
  'EDITOR',
]);

const PREFIXES = ['DYLD_', 'GIT_', 'NPM_CONFIG_', 'BASH_FUNC_'];

/** A project `.env` must not choose where an existing provider key is sent. */
const PROVIDER_BASE_URL_KEYS = new Set([
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_API_BASE',
  'DASHSCOPE_BASE_URL',
  'DASHSCOPE_API_BASE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_BASE',
]);

export function isDotenvDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (EXACT_KEYS.has(upper) || PROVIDER_BASE_URL_KEYS.has(upper)) return true;
  return PREFIXES.some((prefix) => upper.startsWith(prefix));
}
