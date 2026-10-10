/**
 * Every git child Moss starts.
 *
 * A copied checkout, tarball, or board project can ship `.git/config` with
 * `core.fsmonitor` or `core.hooksPath` set to a program. Git runs that program
 * on `status` and `diff`, including the startup snapshot that runs before
 * workspace trust. These `-c` overrides are argv, so they beat the repo file.
 * System git config is still read.
 *
 * Read-only commands also clear other keys that execute a program or supply
 * credentials. Startup status runs before workspace trust, so every read-only
 * git child does this, not only after a trust decision. An empty
 * `diff.external` still tries to exec, so a read-only `diff` also passes
 * `--no-ext-diff` and `--no-textconv` and keeps git's own diff. Repo
 * `filter.*` and `diff.*` drivers are blanked the same way, including ones
 * pulled in by `include.path`, `includeIf`, or `extensions.worktreeConfig`.
 * Only `local` and `worktree` scopes are overridden. System and global config
 * stay in effect, and `command` scope is ignored. Mutating commands
 * (worktree add, apply) keep ssh and credential helpers.
 *
 * `GIT_*` on the child comes from the environment captured before a project
 * `.env`. A project file cannot point git at another repo or config.
 * `git config --get-regexp` exit 1 means nothing matched. Any other discovery
 * failure refuses the read-only git command instead of running it with those
 * programs still armed. The model shell reuses this listing
 * (`shellGitConfigPairs`) and injects it with `GIT_CONFIG_*` instead of argv.
 * That shell overrides credential, ssh, pager, and fsmonitor only when the
 * repo itself sets them, then restores the user's global and system values.
 * A local `diff.external` is left unset: an empty value still execs, and the
 * shell must not rewrite the command.
 */
import { ProcessError, runProcess, type RunProcessResult } from './run-process.js';
import { safeChildEnv } from './safe-child-env.js';
import { envBeforeDotenv, isStartupEnvCaptured } from './startup-env.js';

/** `core.hooksPath` value that disables hooks. `NUL` on Windows. */
export const GIT_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

const HOOKS_PATH = GIT_HOOKS_PATH;

const ALWAYS_CONFIG = ['-c', 'core.fsmonitor=', '-c', `core.hooksPath=${HOOKS_PATH}`] as const;

const READONLY_CONFIG = [
  '-c',
  'core.sshCommand=',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  '-c',
  'credential.helper=',
] as const;

function withoutExternalDiff(args: readonly string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const token = out[i] ?? '';
    if (token === '--') break;
    if (token.startsWith('-')) continue;
    if (token === 'diff') {
      const insert: string[] = [];
      if (!out.includes('--no-ext-diff')) insert.push('--no-ext-diff');
      if (!out.includes('--no-textconv')) insert.push('--no-textconv');
      if (insert.length > 0) out.splice(i + 1, 0, ...insert);
    }
    break;
  }
  return out;
}

/** Repo config keys whose values are programs. */
const EXEC_CONFIG_KEY =
  /^(?:filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:textconv|command)|core\.(?:fsmonitor|hooksPath|sshCommand|pager)|credential\.helper)$/;

/**
 * Git matches `--get-regexp` against the canonical lowercase key, so
 * `sshCommand` and `hooksPath` are lowercase here. `diff.external` is
 * included so the shell can see a local value; it is not turned into an
 * override. `executableConfigKeys` stays case-sensitive so a real
 * `core.hookspath` line is not blanked to an empty path on Moss's own git
 * children (those already force `core.hooksPath` to `/dev/null`).
 */
const EXEC_CONFIG_REGEXP =
  '^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(textconv|command)|diff\\.external|core\\.(fsmonitor|hookspath|sshcommand|pager)|credential\\.helper)$';

const FILTER_DRIVER = /^filter\.(.+)\.(?:clean|smudge|process)$/i;

/** Scopes a copied checkout can set. System, global, and command stay put. */
const OVERRIDE_SCOPES = new Set(['local', 'worktree']);

export interface GitConfigPair {
  key: string;
  value: string;
}

/**
 * Executable keys from `git config --includes --show-scope --get-regexp`
 * (`scope<TAB>key value`). Only `local` and `worktree` are returned.
 * `command`, `system`, and `global` stay put.
 */
export function executableConfigKeys(stdout: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf('\t');
    if (tab === -1) continue;
    const scope = trimmed.slice(0, tab).toLowerCase();
    if (!OVERRIDE_SCOPES.has(scope)) continue;
    const rest = trimmed.slice(tab + 1).trim();
    const space = rest.search(/\s/);
    const key = space === -1 ? rest : rest.slice(0, space);
    if (!EXEC_CONFIG_KEY.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Blank each executable `local` or `worktree` key. A required filter aborts
 * `status` and `diff` when its command is empty, so every driver we touch
 * also sets `filter.<name>.required=false`.
 */
export function configOverridesForExecutableKeys(stdout: string): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, value: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    args.push('-c', `${key}=${value}`);
  };
  for (const key of executableConfigKeys(stdout)) {
    add(key, '');
    const driver = FILTER_DRIVER.exec(key);
    if (driver?.[1]) add(`filter.${driver[1]}.required`, 'false');
  }
  return args;
}

const TEXTCONV_KEY = /^diff\..+\.textconv$/i;

/** Scopes that belong to the user, not the repo. */
const USER_SCOPES = new Set(['global', 'system']);

interface ScopedConfigLine {
  scope: string;
  key: string;
  value: string;
}

function parseScopedConfigLines(stdout: string): ScopedConfigLine[] {
  const lines: ScopedConfigLine[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const scope = line.slice(0, tab).trim().toLowerCase();
    const rest = line.slice(tab + 1).trim();
    if (!rest) continue;
    const space = rest.search(/\s/);
    const key = space === -1 ? rest : rest.slice(0, space);
    const value = space === -1 ? '' : rest.slice(space + 1);
    if (!key) continue;
    lines.push({ scope, key, value });
  }
  return lines;
}

function hasLocalKey(lines: readonly ScopedConfigLine[], key: string): boolean {
  const want = key.toLowerCase();
  return lines.some((line) => line.key.toLowerCase() === want && OVERRIDE_SCOPES.has(line.scope));
}

/** Global and system values in the order `git config --show-scope` printed them. */
function userScopeValues(lines: readonly ScopedConfigLine[], key: string): string[] {
  const want = key.toLowerCase();
  const values: string[] = [];
  for (const line of lines) {
    if (line.key.toLowerCase() !== want) continue;
    if (!USER_SCOPES.has(line.scope)) continue;
    values.push(line.value);
  }
  return values;
}

export interface ShellGitConfigOptions {
  /**
   * True when `.git/hooks` (or the common git dir's hooks) contains an
   * executable file whose name does not end in `.sample`.
   */
  executableHooks?: boolean;
}

/**
 * Env-config pairs for a model shell in an untrusted workspace.
 *
 * `credential.helper`, `core.sshCommand`, `core.pager`, `core.fsmonitor`, and
 * `diff.external` are overridden only when that key is set in `local` or
 * `worktree` scope (including config included from those files). An untrusted
 * repo is the common case of a user's own checkout with no explicit trust
 * grant, so a global helper or ssh command must keep working.
 *
 * `credential.helper` is multi-valued: an empty value clears the list,
 * including global helpers, so the empty reset is followed by the user's
 * global and system helpers in listing order. `core.sshCommand`,
 * `core.fsmonitor`, and `core.pager` are single-valued; the override is the
 * last global or system value, or empty / empty / `cat` when the user has
 * none. `core.hooksPath` is forced to `/dev/null` (`NUL` on Windows) only
 * when the repo sets it or has an executable non-sample hook; a global
 * hooks path is left alone.
 *
 * Local `diff.external` is a known gap. An empty value still execs (`cannot
 * run`), and git-spawn only clears it together with `--no-ext-diff`. The
 * shell must not rewrite the command, so a repo-defined external diff still
 * runs. The same is true of `diff.<name>.command`. Filter drivers and
 * `textconv` are `cat` (an empty `textconv` makes `git diff` fail) and
 * `filter.<name>.required=false`.
 */
export function shellGitConfigPairs(
  stdout: string,
  options?: ShellGitConfigOptions
): GitConfigPair[] {
  const lines = parseScopedConfigLines(stdout);
  const pairs: GitConfigPair[] = [];
  const seen = new Set<string>();
  const add = (key: string, value: string): void => {
    const id = key.toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push({ key, value });
  };
  for (const line of lines) {
    if (!OVERRIDE_SCOPES.has(line.scope)) continue;
    if (/^diff\.external$/i.test(line.key)) continue;
    if (/^diff\..+\.command$/i.test(line.key)) continue;
    const driver = FILTER_DRIVER.exec(line.key);
    if (driver?.[1]) {
      add(line.key, 'cat');
      add(`filter.${driver[1]}.required`, 'false');
      continue;
    }
    if (TEXTCONV_KEY.test(line.key)) add(line.key, 'cat');
  }
  const single: { name: string; fallback: string }[] = [
    { name: 'core.sshCommand', fallback: '' },
    { name: 'core.fsmonitor', fallback: '' },
    { name: 'core.pager', fallback: 'cat' },
  ];
  for (const item of single) {
    if (!hasLocalKey(lines, item.name)) continue;
    const preserved = userScopeValues(lines, item.name);
    const last = preserved.length > 0 ? preserved[preserved.length - 1] : undefined;
    add(item.name, last === undefined ? item.fallback : last);
  }
  if (hasLocalKey(lines, 'credential.helper')) {
    pairs.push({ key: 'credential.helper', value: '' });
    for (const value of userScopeValues(lines, 'credential.helper')) {
      pairs.push({ key: 'credential.helper', value });
    }
  }
  if (options?.executableHooks || hasLocalKey(lines, 'core.hooksPath')) {
    add('core.hooksPath', HOOKS_PATH);
  }
  return pairs;
}

function insertBeforeSubcommand(args: readonly string[], extra: readonly string[]): string[] {
  if (extra.length === 0) return [...args];
  const out = [...args];
  let i = 0;
  while (i < out.length) {
    const token = out[i] ?? '';
    if (token === '-c') {
      i += 2;
      continue;
    }
    if (token === '--') break;
    if (token.startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }
  out.splice(i, 0, ...extra);
  return out;
}

/** Moss may set these after the pre-`.env` `GIT_*` snapshot is applied. */
const TRUSTED_GIT_OVERRIDES = new Set(['GIT_PAGER', 'GIT_OPTIONAL_LOCKS']);

function isGitEnvKey(key: string): boolean {
  return key.toUpperCase().startsWith('GIT_');
}

/**
 * Child env for git. Every `GIT_*` value comes from the pre-`.env` snapshot
 * when one was captured. Other caller overrides are applied after that.
 * `GIT_PAGER` and `GIT_OPTIONAL_LOCKS` are the only `GIT_*` overrides kept.
 */
function gitChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env = safeChildEnv();
  if (isStartupEnvCaptured()) {
    for (const key of Object.keys(env)) {
      if (!isGitEnvKey(key)) continue;
      const startup = envBeforeDotenv[key];
      if (typeof startup === 'string') env[key] = startup;
      else delete env[key];
    }
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (isGitEnvKey(key) && !TRUSTED_GIT_OVERRIDES.has(key.toUpperCase())) continue;
      env[key] = value;
    }
  }
  return env;
}

/** Exit 1 with no timeout is git's "no key matched". Everything else is a failure. */
function isEmptyConfigListing(err: unknown): boolean {
  return err instanceof ProcessError && err.exitCode === 1 && !err.timedOut;
}

function refuseConfigDiscovery(err: unknown): Error {
  if (err instanceof ProcessError) {
    const reason = err.timedOut ? 'timed out' : `exited ${err.exitCode}`;
    const detail = (err.stderr || err.stdout).trim();
    const suffix = detail ? `: ${detail}` : '';
    return new Error(`Refusing read-only git: config discovery ${reason}${suffix}`, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Refusing read-only git: config discovery failed: ${message}`, {
    cause: err instanceof Error ? err : undefined,
  });
}

/**
 * `local` / `worktree` executable keys, including ones pulled in by
 * `include.path`, `includeIf`, or `extensions.worktreeConfig`. Exit 1 (no
 * key matched) is an empty listing. Any other failure is thrown so the
 * caller can refuse the git child. The model shell does not invent
 * credential, ssh, pager, or fsmonitor overrides when this throws: those
 * would hide the user's global config.
 */
export async function listLocalExecutableConfig(
  cwd: string | undefined,
  signal?: AbortSignal
): Promise<string> {
  try {
    const listed = await runProcess('git', {
      args: [
        ...ALWAYS_CONFIG,
        ...READONLY_CONFIG,
        'config',
        '--includes',
        '--show-scope',
        '--get-regexp',
        EXEC_CONFIG_REGEXP,
      ],
      cwd,
      timeout: 3000,
      signal,
      env: gitChildEnv({ GIT_PAGER: 'cat' }),
    });
    return listed.stdout;
  } catch (err) {
    if (isEmptyConfigListing(err)) return '';
    throw err;
  }
}

async function executableConfigOverrides(
  cwd: string | undefined,
  signal: AbortSignal | undefined
): Promise<string[]> {
  try {
    const stdout = await listLocalExecutableConfig(cwd, signal);
    return configOverridesForExecutableKeys(stdout);
  } catch (err) {
    throw refuseConfigDiscovery(err);
  }
}

export function hardenedGitArgs(
  args: readonly string[],
  options?: { readOnly?: boolean }
): string[] {
  const readOnly = options?.readOnly !== false;
  const command = readOnly ? withoutExternalDiff(args) : [...args];
  return [...ALWAYS_CONFIG, ...(readOnly ? READONLY_CONFIG : []), ...command];
}

export interface RunGitOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxBuffer?: number;
  /**
   * Merged over the sanitized parent env. `GIT_*` is taken from the pre-`.env`
   * snapshot; only `GIT_PAGER` and `GIT_OPTIONAL_LOCKS` from this object are
   * kept. Read-only calls force `GIT_PAGER=cat`.
   */
  env?: Record<string, string>;
  /**
   * Default true. Pass false for mutating git (worktree add, apply, add).
   * `core.fsmonitor` and `core.hooksPath` are overridden either way.
   */
  readOnly?: boolean;
}

export async function runGit(
  args: readonly string[],
  opts: RunGitOptions = {}
): Promise<RunProcessResult> {
  const readOnly = opts.readOnly !== false;
  const env: Record<string, string> = { ...(opts.env ?? {}) };
  if (readOnly) env.GIT_PAGER = 'cat';
  let gitArgs = hardenedGitArgs(args, { readOnly });
  if (readOnly) {
    const discovered = await executableConfigOverrides(opts.cwd, opts.signal);
    gitArgs = insertBeforeSubcommand(gitArgs, discovered);
  }
  return runProcess('git', {
    args: gitArgs,
    cwd: opts.cwd,
    timeout: opts.timeout,
    signal: opts.signal,
    stdin: opts.stdin,
    maxBuffer: opts.maxBuffer,
    env: gitChildEnv(env),
  });
}

const DIFF_TIMEOUT_MS = 30_000;

function commandOutput(stdout: string, stderr: string): string {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return stdout.endsWith('\n') ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
}

async function captureGit(
  args: readonly string[],
  cwd: string
): Promise<{ output: string; exitCode: number }> {
  try {
    const result = await runGit(args, { cwd, timeout: DIFF_TIMEOUT_MS, readOnly: true });
    return { output: commandOutput(result.stdout, result.stderr), exitCode: 0 };
  } catch (err) {
    if (err instanceof ProcessError) {
      return { output: commandOutput(err.stdout, err.stderr), exitCode: err.exitCode };
    }
    throw err;
  }
}

/**
 * `/diff` for the readline REPL and the TUI: `git diff --stat` then, when
 * that exits 0, the full `git diff`. Both go through {@link runGit}.
 */
export async function runWorkingTreeDiff(
  cwd: string
): Promise<{ output: string; exitCode: number }> {
  const stat = await captureGit(['--no-pager', 'diff', '--stat'], cwd);
  if (stat.exitCode !== 0) return stat;
  const full = await captureGit(['--no-pager', 'diff'], cwd);
  return { output: stat.output + full.output, exitCode: full.exitCode };
}
