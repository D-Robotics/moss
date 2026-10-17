/**
 * O94: protected paths. Writing, deleting or moving one of these always needs
 * one explicit confirmation, even in `full` mode (interactive), and is denied
 * outright in `-p` / non-interactive runs. Reads are never gated here, and
 * git's own writes to `.git/` (`git commit`, `git checkout`, …) are not gated:
 * only direct edits of files inside `.git/` are.
 *
 * Protected: any `.git` directory, any `.ssh` directory, shell rc/profile
 * files, `.env` / `.env.*` / `.envrc`, and Moss's own config + trust files
 * (user config dir, `~/.moss`, `workspace-trust.json`, project
 * `.moss/config*.json`, `.moss/settings*.json`, `.moss/*trust*`).
 *
 * Matching is case-insensitive on every platform (stricter than needed on a
 * case-sensitive FS; required on macOS/Windows) and checks both the lexical
 * path (after `~`, `$HOME`, `../` normalisation) and the realpath of the
 * nearest existing ancestor (symlink defense).
 *
 * Shell commands: this module is POLICY only. Write targets come from
 * O97's shared `detectShellWriteTargets` (./shell-write-detect.ts) plus O101
 * layers 1–2 (`indirect-write-detect.ts`: inline `-c`/`-e` and workspace
 * script scan). Rule: prompt when a known target is protected, or when the
 * detector is uncertain AND a protected path is mentioned, or when a scanned
 * script/inline block would write a protected path. Best effort, not a sandbox.
 * Layer 3 (post-run snapshot) lives in protected-path-snapshot.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectShellWriteTargets,
  scriptWords,
  tokenize,
  type ShellWriteDetection,
} from './shell-write-detect.js';
import { findIndirectProtectedWrites } from './indirect-write-detect.js';
import { findPwshWriteTargets } from './pwsh-write-targets.js';

export type ProtectedPathCategory =
  | 'git'
  | 'ssh'
  | 'shell-rc'
  | 'env'
  | 'moss-config'
  /** O103: write target built at runtime; cannot tell whether it is protected. */
  | 'unresolved';

export interface ProtectedPathHit {
  raw: string;
  resolved: string;
  category: ProtectedPathCategory;
  operation: 'write' | 'delete' | 'move' | 'shell';
  /** O103: `core.hooksPath` redirection (copy says "would redirect git hooks"). */
  kind?: 'hooks-path' | 'unresolved-var';
  /**
   * O101: when the write comes from inline interpreter code or a workspace
   * script (layers 1–2). Used by the confirm prompt to show script + line.
   */
  source?: {
    kind: 'inline' | 'script';
    script: string;
    line?: number;
    detail?: string;
    /** O129: script realpath outside the workspace; prompt says so. */
    outsideWorkspace?: boolean;
  };
}

export interface ProtectedPathContext {
  cwd: string;
  home?: string;
  /** Moss user config dirs (resolveConfigDir + ~/.moss). */
  configDirs?: readonly string[];
  /** Workspace root (deleting it would delete its `.git`). */
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Injected shell detector (tests). Defaults to detectShellWriteTargets.
   * `mentions` optional for older stubs; when absent, uncertain hits fall back
   * to commandMentionsProtectedPath.
   */
  shellWriteTargets?: (
    command: string,
    cwd: string
  ) => Pick<ShellWriteDetection, 'targets' | 'uncertain'> &
    Partial<Pick<ShellWriteDetection, 'mentions' | 'unresolved'>>;
  /**
   * The exec shell treats `\` as a path separator, never an escape (pwsh /
   * cmd.exe). Defaults to `process.platform === 'win32'`; tests set it to run
   * the Windows parse on any host.
   */
  windowsShell?: boolean;
}

const SHELL_RC_BASENAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.bash_aliases',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.mkshrc',
  '.login',
  '.logout',
  'config.fish',
]);

export const PROTECTED_CATEGORY_LABEL: Record<ProtectedPathCategory, { en: string; zh: string }> = {
  git: { en: 'git repository internals', zh: 'git 仓库内部文件' },
  ssh: { en: 'SSH keys and config', zh: 'SSH 密钥和配置' },
  'shell-rc': { en: 'shell startup file', zh: 'shell 配置文件' },
  env: { en: 'environment / secrets file', zh: '环境变量和密钥文件' },
  'moss-config': { en: "Moss's own config or trust file", zh: 'Moss 自己的配置或信任文件' },
  unresolved: {
    en: 'download target built from a variable or command substitution; cannot tell if it is protected',
    zh: '下载目标由变量/命令替换拼出，无法确定是否受保护',
  },
};

function norm(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

function classifyNormalised(
  abs: string,
  configDirs: readonly string[]
): ProtectedPathCategory | undefined {
  const parts = abs.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  if (parts.includes('.git')) return 'git';
  if (parts.includes('.ssh')) return 'ssh';
  if (SHELL_RC_BASENAMES.has(base) || /_profile\.ps1$/.test(base) || base === 'profile.ps1')
    return 'shell-rc';
  if (base === '.env' || base.startsWith('.env.') || base === '.envrc') return 'env';
  for (const dir of configDirs) if (isUnder(abs, dir)) return 'moss-config';
  if (base === 'workspace-trust.json' || base === 'trusted-folders.json') return 'moss-config';
  const mossIdx = parts.lastIndexOf('.moss');
  if (mossIdx !== -1 && mossIdx === parts.length - 2) {
    if (/^(config|settings|mcp|hooks)[\w.-]*\.json$/.test(base) || base.includes('trust')) {
      return 'moss-config';
    }
  }
  return undefined;
}

function realpathOfNearestAncestor(abs: string): string | undefined {
  let current = abs;
  const rest: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...[...rest].reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return undefined;
}

/**
 * O103: follow a symlink chain on the path itself (lstat + readlink, relative
 * targets resolved against the link's dir) even when the final target does not
 * exist yet, so a dangling `link -> ~/.ssh/new_key` classifies as protected.
 * Returns every hop (excluding `abs`); stops after 40 hops or on a loop.
 */
function symlinkChainTargets(abs: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([abs]);
  let current = abs;
  for (let i = 0; i < 40; i += 1) {
    let next: string;
    try {
      if (!fs.lstatSync(current).isSymbolicLink()) break;
      next = path.resolve(path.dirname(current), fs.readlinkSync(current));
    } catch {
      break;
    }
    if (seen.has(next)) break;
    seen.add(next);
    out.push(next);
    const viaAncestor = realpathOfNearestAncestor(next);
    if (viaAncestor && viaAncestor !== next) out.push(viaAncestor);
    current = next;
  }
  return out;
}

function homeOf(ctx: ProtectedPathContext): string {
  const env = ctx.env ?? process.env;
  return ctx.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
}

function expandHome(raw: string, ctx: ProtectedPathContext): string {
  const env = ctx.env ?? process.env;
  const home = homeOf(ctx);
  let out = raw.trim();
  if (
    (out.startsWith('"') && out.endsWith('"') && out.length >= 2) ||
    (out.startsWith("'") && out.endsWith("'") && out.length >= 2)
  ) {
    out = out.slice(1, -1);
  }
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = home + out.slice(1);
  return out
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/\$\{(\w+)\}/g, (_, key: string) => env[key] ?? '')
    .replace(/\$(\w+)/g, (_, key: string) => env[key] ?? '');
}

function normalisedConfigDirs(ctx: ProtectedPathContext): string[] {
  const dirs = new Set<string>();
  for (const dir of ctx.configDirs ?? []) {
    if (!dir) continue;
    dirs.add(norm(dir));
    const real = realpathOfNearestAncestor(path.resolve(dir));
    if (real) dirs.add(norm(real));
  }
  return [...dirs];
}

/**
 * Classify one path as named by a tool or command: the lexical form first,
 * then the realpath of the nearest existing ancestor.
 */
export function classifyProtectedPath(
  raw: string,
  ctx: ProtectedPathContext
): { category: ProtectedPathCategory; resolved: string } | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const expanded = expandHome(raw, ctx);
  if (!expanded) return undefined;
  const abs = path.resolve(ctx.cwd, expanded);
  const configDirs = normalisedConfigDirs(ctx);
  const lexical = classifyNormalised(norm(abs), configDirs);
  if (lexical) return { category: lexical, resolved: abs };
  const real = realpathOfNearestAncestor(abs);
  if (real) {
    const hit = classifyNormalised(norm(real), configDirs);
    if (hit) return { category: hit, resolved: real };
  }
  for (const target of symlinkChainTargets(abs)) {
    const hit = classifyNormalised(norm(target), configDirs);
    if (hit) return { category: hit, resolved: target };
  }
  return undefined;
}

/** Deleting/moving an ancestor of home / workspace / config dir takes protected paths with it. */
function deletesProtectedAncestor(
  raw: string,
  ctx: ProtectedPathContext
): { category: ProtectedPathCategory; resolved: string } | undefined {
  const expanded = expandHome(raw, ctx);
  if (!expanded) return undefined;
  const abs = path.resolve(ctx.cwd, expanded);
  const candidates = [norm(abs)];
  const real = realpathOfNearestAncestor(abs);
  if (real) candidates.push(norm(real));
  const anchors: Array<[string, ProtectedPathCategory]> = [];
  // O129: anchor both the lexical and the realpath form (macOS /var → /private/var).
  const addAnchor = (dir: string, category: ProtectedPathCategory) => {
    anchors.push([norm(dir), category]);
    const realDir = realpathOfNearestAncestor(path.resolve(dir));
    if (realDir && norm(realDir) !== norm(dir)) anchors.push([norm(realDir), category]);
  };
  addAnchor(homeOf(ctx), 'ssh');
  if (ctx.workspaceRoot) addAnchor(ctx.workspaceRoot, 'git');
  for (const dir of normalisedConfigDirs(ctx)) anchors.push([dir, 'moss-config']);
  for (const candidate of candidates) {
    for (const [anchor, category] of anchors) {
      if (isUnder(anchor, candidate)) return { category, resolved: candidate };
    }
  }
  return undefined;
}

// ── shell (policy only; detection lives behind detectShellWriteTargets) ─

/** Protected names as they may appear in a command we could not fully parse. */
const PROTECTED_TEXT =
  /(?:^|[\s'"`=/\\:(,[{])(\.git(?![\w.-])|\.ssh(?![\w-])|\.env(?![\w-])|\.env\.[\w.-]+|\.envrc(?![\w.-])|\.bashrc|\.bash_profile|\.bash_login|\.bash_aliases|\.profile(?![\w-])|\.zshrc|\.zshenv|\.zprofile|\.zlogin|\.cshrc|\.tcshrc|\.kshrc|config\.fish|\w*_profile\.ps1|workspace-trust\.json|\.moss[\\/](?:config|settings|mcp|hooks|[\w.-]*trust)[\w.-]*)/i;

/** Show a detector's absolute target the way a user would write it. */
function displayPath(abs: string, ctx: ProtectedPathContext): string {
  const rel = path.relative(ctx.cwd, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const home = homeOf(ctx);
  const fromHome = path.relative(home, abs);
  if (!fromHome.startsWith('..') && !path.isAbsolute(fromHome))
    return fromHome ? `~/${fromHome.split(path.sep).join('/')}` : '~';
  return abs;
}

/** Does the command text itself name a protected path (used only when the detector is uncertain)? */
export function commandMentionsProtectedPath(
  command: string,
  ctx: ProtectedPathContext
): string | undefined {
  const m = command.match(PROTECTED_TEXT);
  if (m) return m[1];
  // Absolute mentions of the Moss config dir (e.g. ~/.config/moss/x.json).
  for (const token of command.split(/[\s'"`=;|&()<>]+/)) {
    if (!token || !/[/\\~$]/.test(token)) continue;
    if (classifyProtectedPath(token, ctx)) return token;
  }
  return undefined;
}

/**
 * Shell policy: prompt when a known target is protected, OR the detector is
 * uncertain AND the command text references a protected path. Uncertain but
 * no protected reference (e.g. `python script.py`) → no prompt.
 * `git …` writing its own `.git/` is the detector's business: it must not
 * report git's internal writes as targets.
 */

/** Paths whose mode/owner a chmod/chown/chgrp would change (O94-only supplement). */
function permissionChangeTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/g)) {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
    const head =
      (tokens[i] ?? '')
        .split(/[\\/]/)
        .pop()
        ?.toLowerCase()
        .replace(/\.exe$/, '') ?? '';
    if (head !== 'chmod' && head !== 'chown' && head !== 'chgrp') continue;
    for (const t of tokens.slice(i + 1)) {
      if (!t || t.startsWith('-')) continue;
      // skip mode / owner specs: 755, u+w, user:group
      if (/^[0-7]{3,4}$/.test(t) || /^[ugoa]*[+\-=]/.test(t) || /^[^/\\~.]+:[^/\\]*$/.test(t))
        continue;
      out.push(path.resolve(cwd, t));
    }
  }
  return out;
}

/** O97's detector expands `~` via os.homedir(); honour the context's home. */
function withDetectorHome<T>(ctx: ProtectedPathContext, fn: () => T): T {
  const want = homeOf(ctx);
  if (!want || want === os.homedir()) return fn();
  const prev = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = want;
  if (process.platform === 'win32') process.env.USERPROFILE = want;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (process.platform === 'win32') {
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
  }
}

/** Map a shell command to the O94 prompt verb (rm → delete, mv → move). */
function shellHitOperation(command: string): ProtectedPathHit['operation'] {
  let sawDelete = false;
  let sawMove = false;
  for (const segment of command.split(/(?:&&|\|\||[;\n])/g)) {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
    // skip sudo/doas wrappers
    while (i < tokens.length && /^(sudo|doas)$/i.test(tokens[i]!)) {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith('-')) {
        // sudo -u user → skip flag value when attached form not used
        const flag = tokens[i]!;
        i += 1;
        if (/^-[^-]*[uCg]$/.test(flag) || flag === '--user' || flag === '--group') i += 1;
      }
    }
    const head =
      (tokens[i] ?? '')
        .split(/[\\/]/)
        .pop()
        ?.toLowerCase()
        .replace(/\.exe$/, '') ?? '';
    if (head === 'rm' || head === 'rmdir' || head === 'unlink' || head === 'shred')
      sawDelete = true;
    else if (head === 'mv') sawMove = true;
  }
  if (sawDelete) return 'delete';
  if (sawMove) return 'move';
  return 'write';
}

/** Split a command into simple-command token lists (quotes stripped). */
function simpleCommands(command: string): string[][] {
  const out: string[][] = [];
  for (const segment of command.split(/(?:&&|\|\||[;|\n()])/g)) {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
    while (i < tokens.length && /^(sudo|doas|env|command|nohup|exec|time)$/i.test(tokens[i]!)) {
      i += 1;
      while (i < tokens.length && (tokens[i]!.startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[i]!)))
        i += 1;
    }
    if (i < tokens.length) out.push(tokens.slice(i));
  }
  return out;
}

const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);
const GIT_CONFIG_OPTS_WITH_VALUE = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '--default',
  '--comment',
  '--value',
]);
const GIT_CONFIG_READ_OR_REMOVE =
  /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list|--unset|--unset-all|--remove-section|--rename-section|-e|--edit|--show-origin|--show-scope|--name-only|-z|--null)$/;

/**
 * O103: `git config core.hooksPath <dir>` (any scope) and
 * `git -c core.hooksPath=<dir> …` swap the directory git runs hooks from,
 * which bypasses `.git/hooks` protection without touching it. Treated as a
 * protected `.git` write. Reads (`--get`, no value), `--unset` (restores the
 * default) and every other config key are not gated.
 */
function gitHooksPathHits(command: string, ctx: ProtectedPathContext): ProtectedPathHit[] {
  const hits: ProtectedPathHit[] = [];
  for (const tokens of simpleCommands(command)) {
    const head =
      tokens[0]
        ?.split(/[\\/]/)
        .pop()
        ?.toLowerCase()
        .replace(/\.exe$/, '') ?? '';
    if (head !== 'git') continue;
    let i = 1;
    let viaDashC: string | undefined;
    for (; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if (t === '-c' || t === '--config-env') {
        const kv = tokens[i + 1] ?? '';
        if (/^core\.hookspath(?:=|$)/i.test(kv)) viaDashC = t === '-c' ? kv : `--config-env ${kv}`;
        i += 1;
        continue;
      }
      if (/^--config-env=core\.hookspath=/i.test(t)) {
        viaDashC = t;
        continue;
      }
      if (/^-c./.test(t) && /^-ccore\.hookspath(?:=|$)/i.test(t)) {
        viaDashC = t.slice(2);
        continue;
      }
      if (GIT_GLOBAL_OPTS_WITH_VALUE.has(t)) {
        i += 1;
        continue;
      }
      if (t.startsWith('-')) continue;
      break;
    }
    const gitDirHint = path.join(ctx.workspaceRoot ?? ctx.cwd, '.git', 'config');
    if (viaDashC) {
      hits.push({
        raw: viaDashC.startsWith('--config-env') ? `git ${viaDashC}` : `git -c ${viaDashC}`,
        resolved: gitDirHint,
        category: 'git',
        operation: 'shell',
        kind: 'hooks-path',
      });
      continue;
    }
    if ((tokens[i] ?? '').toLowerCase() !== 'config') continue;
    const rest = tokens.slice(i + 1);
    let global = false;
    let readOrRemove = false;
    const positional: string[] = [];
    for (let k = 0; k < rest.length; k += 1) {
      const t = rest[k]!;
      if (t === '--') {
        positional.push(...rest.slice(k + 1));
        break;
      }
      if (t.startsWith('-') && t.length > 1) {
        if (t === '--global' || t === '--system') global = true;
        if (GIT_CONFIG_READ_OR_REMOVE.test(t)) readOrRemove = true;
        if (GIT_CONFIG_OPTS_WITH_VALUE.has(t)) k += 1;
        continue;
      }
      positional.push(t);
    }
    if (readOrRemove) continue;
    // `git config set <key> <value>` (git ≥ 2.46 subcommand form).
    const sub = positional[0]?.toLowerCase();
    if (sub === 'get' || sub === 'list' || sub === 'unset' || sub === 'remove-section') continue;
    const args = sub === 'set' ? positional.slice(1) : positional;
    if ((args[0] ?? '').toLowerCase() !== 'core.hookspath' || args.length < 2) continue;
    hits.push({
      raw: 'core.hooksPath',
      resolved: global ? path.join(homeOf(ctx), '.gitconfig') : gitDirHint,
      category: 'git',
      operation: 'write',
      kind: 'hooks-path',
    });
  }
  return hits;
}

/**
 * O127: absolute paths that appear in the command ONLY as the operand of a
 * plain `cd <dir>` / `pushd <dir>` (no `$` / backtick). If the same path is
 * also named anywhere else in the command it is not returned.
 */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isWorkspaceRootPath(p: string, ctx: ProtectedPathContext): boolean {
  const root = ctx.workspaceRoot;
  if (!root) return false;
  return realOrResolved(path.resolve(ctx.cwd, p)) === realOrResolved(root);
}

/**
 * O127 QA B1: count cd/pushd/popd/chdir builtins (with or without an operand,
 * whether or not the operand is resolvable). A second directory change cancels
 * the workspace-root cd exemption — otherwise `cd <ws> && cd && node x` (bare
 * cd → $HOME) and `cd <ws> && cd $HOME && node x` silently skipped the
 * ancestor check.
 */
function countDirectoryChanges(command: string): number {
  const re =
    /(?:^|&&|\|\||;|\n|\()\s*(?:builtin\s+|command\s+)?(?:cd|pushd|popd|chdir)(?=\s|$|;|&|\||<|>|\)|\n)/gi;
  let n = 0;
  for (const _ of command.matchAll(re)) n += 1;
  return n;
}

function cdOnlyOperands(command: string, cwd: string): Set<string> {
  const cd = new Set<string>();
  const re =
    /(?:^|&&|\|\||;|\n|\()\s*(?:cd|pushd)\s+(?:--\s+)?(['"]?)([^\s'"`$;&|()<>]+)\1(?=\s*(?:$|&&|\|\||;|\n|\)))/g;
  let rest = command;
  for (const m of command.matchAll(re)) {
    const raw = m[2]!;
    if (raw.startsWith('~') || raw === '-') continue;
    cd.add(path.resolve(cwd, raw));
    rest = rest.replace(m[0], ' ');
  }
  if (cd.size === 0) return cd;
  for (const word of rest.split(/[\s'"`;&|()<>=]+/)) {
    if (!word) continue;
    const abs = path.resolve(cwd, word);
    cd.delete(abs);
    cd.delete(abs.replace(/[\\/]+$/, ''));
  }
  return cd;
}

/**
 * O151: commands that only READ the paths they are given. Naming the
 * workspace root as their operand cannot delete the root's `.git`.
 */
const READ_ONLY_HEADS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'du',
  'tree',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'test',
  '[',
  'grep',
  'egrep',
  'fgrep',
  'find',
]);
// QA r2 F7 on #131: `rg` is not here — `--pre <prog>` / `-z` run a program on
// every file (`rg --pre rm … <root>` deleted .git). Nothing that can run an
// external program belongs in this list.
/** `find` actions that delete, run or write; any of them cancels the exemption. */
const FIND_ACTIONS = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/i;
/** Per-head options that run a program or write a file; any of them cancels the exemption. */
const READ_ONLY_HEAD_UNSAFE: Record<string, RegExp> = {
  find: FIND_ACTIONS,
  file: /^(?:-C|--compile|-[a-zA-Z]*C[a-zA-Z]*)$/,
  tree: /^(?:-o|--output)/,
};
/**
 * QA r2 F7: `git -C <root> <read-sub>` options that run an external program
 * (`--ext-diff`, `--textconv`, `grep -O<cmd>` / `--open-files-in-pager`,
 * `--exec`) or write a file (`--output`). Any of them cancels the exemption.
 */
const GIT_UNSAFE_ARG = /^(?:--ext-diff$|--textconv$|--output|-O|--open-files-in-pager|--exec)/;
/** `git -C <root> <sub>` subcommands that only read the repository. */
const GIT_READ_SUBCOMMANDS = new Set([
  'diff',
  'status',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'blame',
  'grep',
  'describe',
  'shortlog',
  'cat-file',
]);
/** Commands a read-only command's output may be piped into (stdout filters only). */
const PIPE_FILTERS = new Set([
  'tail',
  'head',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'sort',
  'uniq',
  'cut',
  'tr',
  'cat',
  'nl',
]);
/** Filter options that run a program (`sort --compress-program=<prog>`). */
const PIPE_FILTER_UNSAFE = /^--compress-prog/i;
/** A downstream pipe stage that only filters stdout (no program it can launch). */
function isPipeFilter(words: readonly string[]): boolean {
  if (!PIPE_FILTERS.has(headName(words[0]))) return false;
  return !words.slice(1).some((w) => PIPE_FILTER_UNSAFE.test(w));
}
const WRAPPERS = /^(?:sudo|doas|env|command|nohup|exec|time)$/i;
/**
 * QA r3 F10 on #131: the exemption is an allowlist over the WHOLE command.
 * Every simple command (split on `;` `&&` `||` `|` `&` newline and subshell
 * parens) must start with one of these names, otherwise nothing is exempt —
 * an unknown name may redefine or re-point a later "read-only" command
 * (`export GIT_EXTERNAL_DIFF=…; git -C <root> diff`, `ls(){ rm -rf "$1"; }`).
 * `git` additionally has to be a read-only git (see {@link gitReadOnlyCValues}).
 */
const ROOT_EXEMPT_HEADS = new Set([
  ...READ_ONLY_HEADS,
  ...PIPE_FILTERS,
  'cd',
  'pushd',
  'git',
  'node',
  'nodejs',
  'python',
  'python3',
  'which',
  'echo',
  'printf',
  ':',
  'true',
  'false',
  'pwd',
  // pwsh / cmd read-only listing / printing (O151 Windows shapes).
  'dir',
  'type',
]);
/**
 * QA r3 F10: names that change what a later command does (environment,
 * functions, aliases, sourcing, option state, command lookup). Any of them in
 * a command position anywhere cancels the exemption. They are already absent
 * from {@link ROOT_EXEMPT_HEADS}; kept explicit so widening that list cannot
 * re-open F10.
 */
const ROOT_EXEMPT_CANCEL = new Set([
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'set',
  'unset',
  'eval',
  'source',
  '.',
  'alias',
  'unalias',
  'function',
  'trap',
  'exec',
  'command',
  'builtin',
  'enable',
  'hash',
  'shopt',
  'read',
  'mapfile',
  'readarray',
  'let',
  // pwsh / cmd environment, alias and function writes.
  'set-item',
  'si',
  'set-variable',
  'sv',
  'new-item',
  'ni',
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'invoke-expression',
  'iex',
  'doskey',
  'setx',
  'call',
]);

function headName(word: string | undefined): string {
  return (
    (word ?? '')
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  );
}

/**
 * O151 (Windows): exec runs pwsh / cmd.exe there, where `\` separates path
 * segments and is never an escape. The POSIX tokenizer used to eat it
 * (`cd C:\x\proj\.git` → `C:xproj.git`, `sed -i … .git\config` →
 * `.gitconfig`), so the path missed `.git` and the write was not gated. Returns
 * the separator form to analyse in addition to the original (stricter only),
 * or undefined when there is nothing to rewrite.
 */
function windowsSeparatorForm(command: string, ctx: ProtectedPathContext): string | undefined {
  const win = ctx.windowsShell ?? process.platform === 'win32';
  return win && command.includes('\\') ? command.replace(/\\/g, '/') : undefined;
}

/**
 * O151 (QA BLOCK on #131): an uncertain command (`node -e`, `python3 …`) that
 * also names the workspace root as a plain operand — `git -C <root> diff`,
 * `ls -la <root>; python3 -V` — had the root judged "deleting an ancestor of
 * .git" and the run ended in a false Incomplete. #124 only exempted a root
 * that is the sole `cd` target.
 *
 * Returns true only when EVERY reference to the root in the command is one of:
 *   - the operand of the single `cd`/`pushd` in the command;
 *   - a non-option operand of a read-only command (ls, cat, find without
 *     -delete/-exec, …), or the `-C` value of a read-only git subcommand;
 * and that simple command writes no file and its output is piped only into
 * stdout filters (so `ls <root> | xargs rm -rf` is not exempt).
 * A root reference anywhere else — inline code, an interpreter argument, a
 * redirect target, a relative `.` inside a script — cancels it, as do `$(…)`,
 * backticks, heredocs, unbalanced quotes and a second directory change.
 * Only the ancestor-delete rule is skipped; protected-path classification of
 * the same word, write targets, O101 inline/script scans and O103 hooksPath
 * checks are unchanged.
 */
/**
 * `git [-C <dir>]… <read-sub> …` with no option that runs a program or writes
 * a file: returns the word indexes of the `-C` values, else undefined.
 */
function gitReadOnlyCValues(words: readonly string[], i: number): number[] | undefined {
  let j = i + 1;
  const cValues: number[] = [];
  for (; j < words.length; j += 1) {
    if (words[j] === '-C') {
      cValues.push(j + 1);
      j += 1;
      continue;
    }
    // Any other global option: not a shape we vouch for.
    break;
  }
  if (!GIT_READ_SUBCOMMANDS.has((words[j] ?? '').toLowerCase())) return undefined;
  if (words.slice(j + 1).some((a) => GIT_UNSAFE_ARG.test(a))) return undefined;
  return cValues;
}

function workspaceRootOnlyReadOnly(command: string, ctx: ProtectedPathContext): boolean {
  const root = ctx.workspaceRoot;
  if (!root) return false;
  if (/\$\(|`|<</.test(command)) return false;
  // QA r3 F10: `${VAR:=x}` / `${VAR=x}` assign inside an expansion.
  if (/\$\{[^}]*=/.test(command)) return false;
  if (countDirectoryChanges(command) > 1) return false;
  // Windows paths (`D:\a\proj`) are not POSIX escapes; the tokenizer would
  // eat the separators and the root would never be recognised (→ no exemption).
  const { tokens, balanced } = tokenize(windowsSeparatorForm(command, ctx) ?? command);
  if (!balanced) return false;
  const rootReal = norm(realOrResolved(root));
  const bases = new Set([ctx.cwd, root]);
  const isRoot = (w: string, base: string): boolean => {
    if (!w || w.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return false;
    return norm(realOrResolved(path.resolve(base, w))) === rootReal;
  };
  const anyBaseIsRoot = (w: string): boolean => [...bases].some((b) => isRoot(w, b));

  // Group into pipelines of simple commands; record redirects per command.
  type Simple = { words: string[]; writes: boolean };
  const pipelines: Simple[][] = [];
  let pipeline: Simple[] = [];
  let current: Simple = { words: [], writes: false };
  const endSimple = () => {
    if (current.words.length || current.writes) pipeline.push(current);
    current = { words: [], writes: false };
  };
  const endPipeline = () => {
    endSimple();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k]!;
    if (t.kind === 'word') {
      // QA r3 F10: `name()` / `name ()` — a function definition (POSIX form).
      if (tokens[k + 1]?.text === '(' && tokens[k + 2]?.text === ')') return false;
      current.words.push(t.text);
      continue;
    }
    if (t.text === '|' || t.text === '|&') {
      endSimple();
      continue;
    }
    if ([';', '&&', '||', '&', '\n', '(', ')'].includes(t.text)) {
      endPipeline();
      continue;
    }
    // Redirect operator: the next word is its target, never an exempt operand.
    const next = tokens[k + 1];
    if (next?.kind === 'word') {
      if (/>/.test(t.text) && next.text !== '/dev/null') current.writes = true;
      if (anyBaseIsRoot(next.text)) return false;
      for (const piece of scriptWords(next.text)) if (anyBaseIsRoot(piece)) return false;
      k += 1;
    } else if (/>/.test(t.text)) current.writes = true;
  }
  endPipeline();

  let rootSeen = false;
  for (const line of pipelines) {
    const lineWrites = line.some((c) => c.writes);
    for (let idx = 0; idx < line.length; idx += 1) {
      const words = line[idx]!.words;
      let i = 0;
      // QA r3 F10: a redirect-only command (`> f`) has no name to vouch for.
      if (words.length === 0) return false;
      // QA r2 F7: any `VAR=` assignment (GIT_EXTERNAL_DIFF=, GIT_PAGER=, PAGER=,
      // LESSOPEN=, GIT_SSH_COMMAND= …) can make a "read" run a program; a
      // command naming the root with one is never exempt (also after env/sudo).
      if (words.some((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) && words.some(anyBaseIsRoot))
        return false;
      if (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) return false;
      while (i < words.length && WRAPPERS.test(words[i]!)) {
        // QA r3 F10: `command` / `exec` change lookup or replace the shell.
        if (ROOT_EXEMPT_CANCEL.has(words[i]!.toLowerCase())) return false;
        i += 1;
        while (i < words.length && words[i]!.startsWith('-')) i += 1;
        if (i < words.length && /^[A-Za-z_]\w*=/.test(words[i]!)) return false;
      }
      const head = headName(words[i]);
      // QA r3 F10: allowlist over every simple command, not only the ones
      // that name the root. Unknown names (and the cancel keywords) end it.
      const rawHead = (words[i] ?? '').toLowerCase();
      if (ROOT_EXEMPT_CANCEL.has(rawHead) || ROOT_EXEMPT_CANCEL.has(head)) return false;
      if (!ROOT_EXEMPT_HEADS.has(head)) return false;
      // A bare name, or a system bin path. `./ls`, `bin/git` (a workspace
      // script named like an allowed command), `$env:X=…`, `{`, `x=…` are not.
      const headWord = words[i] ?? '';
      if (
        !/^[A-Za-z0-9_.:[\]-]+$/.test(headWord) &&
        !/^\/(?:usr\/(?:local\/)?)?s?bin\/[A-Za-z0-9_.-]+$/.test(headWord)
      )
        return false;
      if (head === 'git' && !gitReadOnlyCValues(words, i)) return false;
      if (head === 'printf' && words.slice(i + 1).some((a) => /^-[a-zA-Z]*v/.test(a))) return false;
      const exempt = new Set<number>();
      const downstreamOnlyFilters = line.slice(idx + 1).every((c) => isPipeFilter(c.words));
      const outputSafe = !lineWrites && downstreamOnlyFilters;
      if ((head === 'cd' || head === 'pushd') && idx === 0 && line.length === 1) {
        let j = i + 1;
        if (words[j] === '--') j += 1;
        if (j === words.length - 1) exempt.add(j);
      } else if (READ_ONLY_HEADS.has(head) && outputSafe) {
        const args = words.slice(i + 1);
        const unsafe = READ_ONLY_HEAD_UNSAFE[head];
        if (!unsafe || !args.some((a) => unsafe.test(a))) {
          for (let j = i + 1; j < words.length; j += 1) exempt.add(j);
        }
      } else if (head === 'git' && outputSafe) {
        for (const c of gitReadOnlyCValues(words, i) ?? []) exempt.add(c);
      }
      for (let j = 0; j < words.length; j += 1) {
        const w = words[j]!;
        const named = anyBaseIsRoot(w);
        if (exempt.has(j)) {
          if (named) rootSeen = true;
          continue;
        }
        if (named) return false;
        for (const piece of scriptWords(w)) if (anyBaseIsRoot(piece)) return false;
      }
    }
  }
  return rootSeen;
}

export function findShellProtectedWrites(
  command: string,
  ctx: ProtectedPathContext
): ProtectedPathHit[] {
  const detect = ctx.shellWriteTargets ?? detectShellWriteTargets;
  const winForm = windowsSeparatorForm(command, ctx);
  // O151 (Windows): analyse the pwsh/cmd separator form first (its paths are
  // the real ones, so hits[0] names them), then the original; union of both.
  const detections = [...(winForm ? [winForm] : []), command].map((c) =>
    withDetectorHome(ctx, () => detect(c, ctx.cwd))
  );
  const uncertain = detections.some((d) => d.uncertain);
  const mentions = [...new Set(detections.flatMap((d) => d.mentions ?? []))];
  const unresolved = [...new Set(detections.flatMap((d) => d.unresolved ?? []))];
  // O97 does not flag chmod/chown/chgrp as writes; O94 still gates permission
  // changes on protected paths.
  const targets = [
    ...new Set([
      ...detections.flatMap((d) => d.targets),
      ...(winForm ? permissionChangeTargets(winForm, ctx.cwd) : []),
      ...permissionChangeTargets(command, ctx.cwd),
    ]),
  ];
  const hits: ProtectedPathHit[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const hit = classifyProtectedPath(target, ctx) ?? deletesProtectedAncestor(target, ctx);
    if (!hit || seen.has(hit.resolved)) continue;
    seen.add(hit.resolved);
    hits.push({
      raw: displayPath(target, ctx),
      resolved: hit.resolved,
      category: hit.category,
      operation: shellHitOperation(command),
    });
  }
  if (hits.length === 0 && uncertain) {
    // O127 (S2): `cd <workspace root> && node x.mjs` is uncertain (a script
    // could write anything), and the `cd` operand — the workspace root — was
    // then judged as "deleting an ancestor of .git" and blocked. A `cd`
    // operand is never written; it still gets the normal protected-path
    // classification; only the ancestor-delete rule is skipped, and only when
    // the path is named nowhere else in the command.
    // Same pwsh/cmd form as the detector, so its cd operand compares equal.
    const cdOnly = cdOnlyOperands(winForm ?? command, ctx.cwd);
    // QA B1 / PM 10-12: a second cd/pushd/popd/chdir (any operand) cancels the
    // exemption — the first cd-to-root must also be the last directory change.
    const allowCdExempt = countDirectoryChanges(command) <= 1;
    let rootReadOnlyMemo: boolean | undefined;
    const rootReadOnly = () => (rootReadOnlyMemo ??= workspaceRootOnlyReadOnly(command, ctx));
    // Prefer absolute mentions from the shared detector; fall back to text regex.
    for (const m of mentions) {
      // O103: a word still holding `$VAR` / `$(…)` is not a path we resolved;
      // expanding it to '' used to misreport the workspace root as git internals.
      if (/\$|`/.test(m)) continue;
      // PM 10-12: exempt only when the cd target IS the workspace/worktree root
      // (realpath); `cd /`, `cd ~`, `cd ..` still hit the ancestor rule.
      const isCd =
        allowCdExempt && cdOnly.has(path.resolve(ctx.cwd, m)) && isWorkspaceRootPath(m, ctx);
      // O151: the root named only as a read-only operand (`git -C <root> diff`,
      // `ls -la <root>`) besides that single cd is not a delete of its .git.
      const isReadOnlyRoot = !isCd && isWorkspaceRootPath(m, ctx) && rootReadOnly();
      const hit =
        classifyProtectedPath(m, ctx) ??
        (isCd || isReadOnlyRoot ? undefined : deletesProtectedAncestor(m, ctx));
      if (!hit || seen.has(hit.resolved)) continue;
      seen.add(hit.resolved);
      hits.push({
        raw: displayPath(m, ctx),
        resolved: hit.resolved,
        category: hit.category,
        operation: 'shell',
      });
    }
    if (hits.length === 0 && unresolved.length > 0) {
      // O103: download target we cannot resolve → one honest confirmation line.
      const raw = unresolved[0]!;
      hits.push({ raw, resolved: raw, category: 'unresolved', operation: 'write' });
    }
    if (hits.length === 0) {
      const name = commandMentionsProtectedPath(command, ctx);
      if (name) {
        const cls = classifyProtectedPath(name, ctx);
        hits.push({
          raw: name,
          resolved: cls?.resolved ?? name,
          category:
            cls?.category ?? classifyNormalised(`/x/${name.toLowerCase()}/f`, []) ?? 'moss-config',
          operation: 'shell',
        });
      }
    }
  }

  // O103: hooksPath redirection.
  for (const hit of gitHooksPathHits(command, ctx)) {
    const key = `hookspath:${hit.raw}:${hit.resolved}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }

  // O101 layers 1–2: inline interpreter code + workspace script scan.
  // Merge with existing hits; attach source metadata when the same path already hit.
  for (const finding of findIndirectProtectedWrites(
    command,
    ctx.cwd,
    ctx.workspaceRoot ?? ctx.cwd
  )) {
    const hit =
      classifyProtectedPath(finding.raw, ctx) ?? deletesProtectedAncestor(finding.raw, ctx);
    if (!hit) continue;
    const key = hit.resolved;
    if (seen.has(key)) {
      const existing = hits.find((h) => h.resolved === key);
      if (existing && !existing.source) existing.source = finding.source;
      continue;
    }
    seen.add(key);
    hits.push({
      raw: finding.raw,
      resolved: hit.resolved,
      category: hit.category,
      operation: 'shell',
      source: finding.source,
    });
  }

  // O130 (a): write targets of PowerShell cmdlets / aliases, [IO.File]::Write*,
  // every redirection form, with `$env:X` / `${env:X}` / `%X%` / `$X` expanded
  // from the current env. Only write targets are examined (a `$` in an argument
  // or a read never prompts). A target that cannot be resolved (unknown or
  // same-line-assigned variable, command substitution, relative after an
  // unresolvable `cd`) is gated as possibly protected. Stricter only.
  const pw = findPwshWriteTargets(command, {
    cwd: ctx.cwd,
    home: homeOf(ctx),
    env: ctx.env ?? process.env,
  });
  for (const target of pw.resolved) {
    const hit = classifyProtectedPath(target, ctx) ?? deletesProtectedAncestor(target, ctx);
    if (!hit || seen.has(hit.resolved)) continue;
    seen.add(hit.resolved);
    hits.push({
      raw: displayPath(hit.resolved, ctx),
      resolved: hit.resolved,
      category: hit.category,
      operation: 'shell',
    });
  }
  if (hits.length === 0 && pw.unresolved.length > 0) {
    const raw = pw.unresolved[0]!;
    hits.push({
      raw,
      resolved: raw,
      category: 'unresolved',
      operation: 'write',
      kind: 'unresolved-var',
    });
  }

  // O130 (b): inline interpreter code (`node -e`, `python -c` …) naming a Moss
  // config file through process.env.X / os.environ[...] (+ string concat).
  if (!hits.some((h) => h.category === 'moss-config') && INLINE_INTERP.test(command)) {
    for (const token of configDirTokens(command, ctx)) {
      const hit = classifyProtectedPath(token, ctx);
      if (!hit || hit.category !== 'moss-config' || seen.has(hit.resolved)) continue;
      seen.add(hit.resolved);
      hits.push({
        raw: displayPath(hit.resolved, ctx),
        resolved: hit.resolved,
        category: hit.category,
        operation: 'shell',
      });
    }
  }
  // O151 F6: the prompt names hits[0]. A bare mention (`cd R/.git && node -e
  // "writeFileSync('config')"` → the word `fs` → `.git/fs`) must not be named
  // ahead of the write the O101 scan actually found (`.git/config`). Order
  // only; the set of hits is unchanged.
  const rank = (h: ProtectedPathHit) => (h.operation !== 'shell' || h.kind ? 0 : h.source ? 1 : 2);
  return hits
    .map((h, i) => [h, i] as const)
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j)
    .map(([h]) => h);
}

const INLINE_INTERP =
  /(?:^|[\s;|&(])(?:node|nodejs|bun|deno|python[23]?(?:\.\d+)?|py|ruby|perl|php)(?:\.exe)?\s+(?:[^;|&]*\s)?(?:-e|-c|-p|-r|-E|--eval|--print|eval)(?=\s)/i;

/** O130: tokens of the command with Windows / interpreter env references expanded. */
function configDirTokens(command: string, ctx: ProtectedPathContext): string[] {
  const env = ctx.env ?? process.env;
  const lookup = (name: string): string => {
    const direct = env[name];
    if (direct !== undefined) return direct;
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (env[key] ?? '') : '';
  };
  const expanded = command
    .replace(/\$\{env:(\w+)\}|\$env:(\w+)/gi, (_, a: string, b: string) => lookup(a ?? b))
    .replace(/%(\w+)%/g, (_, k: string) => lookup(k))
    .replace(
      /process\.env\.(\w+)|process\.env\[\s*['"](\w+)['"]\s*\]|os\.environ\[\s*['"](\w+)['"]\s*\]|os\.getenv\(\s*['"](\w+)['"]\s*\)|os\.environ\.get\(\s*['"](\w+)['"]\s*\)/g,
      (_m, a?: string, b?: string, c?: string, d?: string, e?: string) =>
        lookup((a ?? b ?? c ?? d ?? e)!)
    )
    // join string concatenation: X+'/moss/config.json' / X + "\\moss" / path.join(X,'moss')
    .replace(/['"]?\s*\+\s*['"]/g, '')
    .replace(/(path\.join|os\.path\.join|Join-Path)\s*\(?/gi, ' ');
  const out: string[] = [];
  for (const token of expanded.split(/[\s'"`=;|&()<>,]+/)) {
    if (token && /[/\\]/.test(token)) out.push(token);
  }
  return out;
}

/** Paths a file-mutation tool call would touch. */
export function fileToolProtectedTargets(
  toolName: string,
  input: Record<string, unknown>
): Array<{ raw: string; operation: ProtectedPathHit['operation'] }> {
  if (toolName === 'move_file') {
    return [input.source, input.destination]
      .filter((v): v is string => typeof v === 'string')
      .map((raw) => ({ raw, operation: 'move' as const }));
  }
  if (toolName === 'apply_patch' && typeof input.patch === 'string') {
    const out: Array<{ raw: string; operation: ProtectedPathHit['operation'] }> = [];
    for (const m of input.patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)) {
      out.push({ raw: m[2]!.trim(), operation: m[1] === 'Delete' ? 'delete' : 'write' });
    }
    for (const m of input.patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
      out.push({ raw: m[1]!.trim(), operation: 'move' });
    }
    for (const m of input.patch.matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm)) {
      if (m[1] !== '/dev/null') out.push({ raw: m[1]!, operation: 'write' });
    }
    return out;
  }
  const p = input.path ?? input.file_path;
  return typeof p === 'string' ? [{ raw: p, operation: 'write' }] : [];
}

export const PROTECTED_FILE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'move_file',
]);
export const PROTECTED_SHELL_TOOLS: ReadonlySet<string> = new Set(['exec', 'exec_background']);

/** All protected-path hits for one tool call (file tools + shell). */
export function findProtectedPathHits(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ProtectedPathContext,
  shellIsReadonly: boolean
): ProtectedPathHit[] {
  if (PROTECTED_FILE_TOOLS.has(toolName)) {
    const hits: ProtectedPathHit[] = [];
    for (const { raw, operation } of fileToolProtectedTargets(toolName, input)) {
      const hit = classifyProtectedPath(raw, ctx);
      if (hit) hits.push({ raw, resolved: hit.resolved, category: hit.category, operation });
    }
    return hits;
  }
  if (PROTECTED_SHELL_TOOLS.has(toolName) && !shellIsReadonly) {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command.trim()) return [];
    return findShellProtectedWrites(command, ctx);
  }
  return [];
}
