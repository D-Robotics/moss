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
 * O97's shared `detectShellWriteTargets` (./shell-write-detect.ts). Rule:
 * prompt when a known target is protected, or when the detector is uncertain
 * AND a protected path is mentioned (`mentions` / command text). Best effort,
 * not a sandbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectShellWriteTargets, type ShellWriteDetection } from './shell-write-detect.js';

export type ProtectedPathCategory = 'git' | 'ssh' | 'shell-rc' | 'env' | 'moss-config';

export interface ProtectedPathHit {
  raw: string;
  resolved: string;
  category: ProtectedPathCategory;
  operation: 'write' | 'delete' | 'move' | 'shell';
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
    Partial<Pick<ShellWriteDetection, 'mentions'>>;
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
  const anchors: Array<[string, ProtectedPathCategory]> = [[norm(homeOf(ctx)), 'ssh']];
  if (ctx.workspaceRoot) anchors.push([norm(ctx.workspaceRoot), 'git']);
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
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = homeOf(ctx);
  const fromHome = path.relative(home, abs);
  if (!fromHome.startsWith('..') && !path.isAbsolute(fromHome))
    return fromHome ? `~/${fromHome}` : '~';
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

/** O97's detector expands `~` via os.homedir(); honour ctx.env.HOME when set. */
function withDetectorHome<T>(ctx: ProtectedPathContext, fn: () => T): T {
  const want = ctx.env?.HOME ?? ctx.home;
  if (!want || want === process.env.HOME) return fn();
  const prev = process.env.HOME;
  process.env.HOME = want;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

export function findShellProtectedWrites(
  command: string,
  ctx: ProtectedPathContext
): ProtectedPathHit[] {
  const detect = ctx.shellWriteTargets ?? detectShellWriteTargets;
  const detection = withDetectorHome(ctx, () => detect(command, ctx.cwd));
  const { uncertain, mentions = [] } = detection;
  // O97 does not flag chmod/chown/chgrp as writes; O94 still gates permission
  // changes on protected paths.
  const targets = [...detection.targets, ...permissionChangeTargets(command, ctx.cwd)];
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
      operation: 'write',
    });
  }
  if (hits.length === 0 && uncertain) {
    // Prefer absolute mentions from the shared detector; fall back to text regex.
    for (const m of mentions) {
      const hit = classifyProtectedPath(m, ctx) ?? deletesProtectedAncestor(m, ctx);
      if (!hit || seen.has(hit.resolved)) continue;
      seen.add(hit.resolved);
      hits.push({
        raw: displayPath(m, ctx),
        resolved: hit.resolved,
        category: hit.category,
        operation: 'shell',
      });
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
  return hits;
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
