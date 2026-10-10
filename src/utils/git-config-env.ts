/**
 * Git config injected into a model shell (`exec` / `exec_background`).
 *
 * Commands are not rewritten. Overrides are extra `GIT_CONFIG_KEY_<n>` /
 * `GIT_CONFIG_VALUE_<n>` entries appended after any count the user already
 * set, so they win and the user's pairs stay. Discovery is cached per git
 * dir, config mtime (and size), hooks directory, and the user/system git
 * config files the pairs may quote. A discovery failure does not invent
 * credential, ssh, pager, or fsmonitor overrides. An executable non-sample
 * hook still disables `core.hooksPath`, because that is visible without
 * config discovery.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listLocalExecutableConfig, shellGitConfigPairs, type GitConfigPair } from './git-spawn.js';

export type { GitConfigPair };

const CACHE_LIMIT = 64;

const cache = new Map<string, GitConfigPair[]>();
const inflight = new Map<string, Promise<GitConfigPair[]>>();

function configCountStart(raw: string | undefined): number {
  if (typeof raw !== 'string') return 0;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return 0;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return 0;
  return value;
}

/** Append pairs after `GIT_CONFIG_COUNT`. A non-numeric count is treated as unset. */
export function appendGitConfigEnv(
  env: Record<string, string>,
  pairs: readonly GitConfigPair[]
): void {
  if (pairs.length === 0) return;
  const start = configCountStart(env.GIT_CONFIG_COUNT);
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    const index = start + i;
    env[`GIT_CONFIG_KEY_${index}`] = pair.key;
    env[`GIT_CONFIG_VALUE_${index}`] = pair.value;
  }
  env.GIT_CONFIG_COUNT = String(start + pairs.length);
}

function readGitdirFile(gitPath: string): string | null {
  try {
    const text = fs.readFileSync(gitPath, 'utf8');
    const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(text)?.[1]?.trim();
    if (!gitdir) return null;
    return path.resolve(path.dirname(gitPath), gitdir);
  } catch {
    return null;
  }
}

interface GitLayout {
  gitDir: string;
  commonDir: string;
}

function findGitLayout(start: string): GitLayout | null {
  let current = path.resolve(start);
  for (;;) {
    const gitPath = path.join(current, '.git');
    let gitDir: string | null = null;
    try {
      const st = fs.statSync(gitPath);
      if (st.isDirectory()) gitDir = gitPath;
      else if (st.isFile()) gitDir = readGitdirFile(gitPath);
    } catch {
      gitDir = null;
    }
    if (gitDir) {
      let commonDir = gitDir;
      try {
        const text = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (text) commonDir = path.resolve(gitDir, text);
      } catch {
        /* main work tree: config lives in this git dir */
      }
      return { gitDir, commonDir };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs.toString(36)}:${st.size.toString(36)}`;
  } catch {
    return '-';
  }
}

function hookDirs(layout: GitLayout): string[] {
  const dirs = [path.join(layout.gitDir, 'hooks')];
  const common = path.join(layout.commonDir, 'hooks');
  if (common !== dirs[0]) dirs.push(common);
  return dirs;
}

/** Git's default templates are mode 0755 and named `*.sample`. Those are not hooks. */
function hooksDirHasExecutable(dir: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name.endsWith('.sample')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function repoHasExecutableHooks(layout: GitLayout): boolean {
  return hookDirs(layout).some(hooksDirHasExecutable);
}

function hooksStamp(dir: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return '-';
  }
  names.sort();
  return names
    .map((name) => {
      if (name.endsWith('.sample')) return `${name}:sample`;
      try {
        const st = fs.statSync(path.join(dir, name));
        const mode = (st.mode & 0o777).toString(8);
        return `${name}:${mode}:${Math.trunc(st.mtimeMs).toString(36)}:${st.size.toString(36)}`;
      } catch {
        return `${name}:-`;
      }
    })
    .join(',');
}

/** Files whose values may be copied into an override (`credential.helper`, ssh, pager). */
function userGitConfigFiles(): string[] {
  const files: string[] = [];
  const global = process.env.GIT_CONFIG_GLOBAL;
  if (typeof global === 'string' && global.trim()) files.push(global);
  else {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    if (home) files.push(path.join(home, '.gitconfig'));
  }
  const system = process.env.GIT_CONFIG_SYSTEM;
  if (typeof system === 'string' && system.trim()) files.push(system);
  else if (process.platform !== 'win32') files.push('/etc/gitconfig');
  return files;
}

function layoutStamp(layout: GitLayout | null): string {
  const user = userGitConfigFiles().map(fileStamp).join('|');
  if (!layout) return `nogit\0${user}`;
  const files = [
    path.join(layout.gitDir, 'config'),
    path.join(layout.gitDir, 'config.worktree'),
    path.join(layout.commonDir, 'config'),
    path.join(layout.commonDir, 'config.worktree'),
  ];
  const hooks = hookDirs(layout).map(hooksStamp).join('|');
  return `${layout.gitDir}\0${files.map(fileStamp).join('|')}\0${hooks}\0${user}`;
}

function remember(stamp: string, pairs: GitConfigPair[]): void {
  if (cache.has(stamp)) cache.delete(stamp);
  cache.set(stamp, pairs);
  if (cache.size <= CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

async function loadPairs(
  cwd: string,
  signal: AbortSignal | undefined,
  layout: GitLayout | null
): Promise<{ pairs: GitConfigPair[]; cacheable: boolean }> {
  const executableHooks = layout ? repoHasExecutableHooks(layout) : false;
  try {
    const stdout = await listLocalExecutableConfig(cwd, signal);
    return { pairs: shellGitConfigPairs(stdout, { executableHooks }), cacheable: true };
  } catch {
    return { pairs: shellGitConfigPairs('', { executableHooks }), cacheable: false };
  }
}

/**
 * Repo filter / textconv overrides, plus credential, ssh, pager, fsmonitor,
 * and hooks overrides when the repo (not the user's global config) sets them.
 * Cached until the repo config, hooks directory, or user gitconfig changes.
 */
export async function untrustedShellGitConfig(
  cwd: string,
  signal?: AbortSignal
): Promise<GitConfigPair[]> {
  const layout = findGitLayout(cwd);
  const stamp = layoutStamp(layout);
  const hit = cache.get(stamp);
  if (hit) return hit;
  const pending = inflight.get(stamp);
  if (pending) return pending;
  const run = loadPairs(cwd, signal, layout)
    .then((loaded) => {
      if (loaded.cacheable) remember(stamp, loaded.pairs);
      return loaded.pairs;
    })
    .finally(() => {
      inflight.delete(stamp);
    });
  inflight.set(stamp, run);
  return run;
}
