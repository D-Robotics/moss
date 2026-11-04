/**
 * Skill installation and supply-chain bookkeeping.
 *
 * A skill is a directory that may contain scripts, so "just copy a folder into
 * ~/.moss/skills" is not enough: the user needs to know what was installed, from
 * where, at which revision, and whether the installed files still match what the
 * lockfile recorded. This module implements:
 *
 *   moss skill install <dir|git-url|npm-package> [--workspace] [--name n] [--yes]
 *   moss skill update [name] [--workspace] [--yes]
 *   moss skill lock [--workspace]
 *
 * Design boundaries:
 * - scripts/ is copied, never executed (execution stays behind the exec tool's
 *   approval path);
 * - remote sources (git/npm) require --yes even on first install;
 * - overwriting an existing skill requires --yes;
 * - the lockfile stores {source, kind, resolved revision/version, sha256 of the
 *   installed tree, file count, license, target}. `moss skill lock` re-hashes the
 *   installed tree, so local drift is detected instead of silently trusted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runProcess } from '../utils/run-process.js';
import { readSkillManifest } from '../core/skills/skill-registry.js';

export interface SkillInstallContext {
  workspaceDir: string;
  configDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface LockEntry {
  source: string;
  kind: 'local' | 'git' | 'npm';
  resolved: string;
  hash: string;
  files: number;
  scope: 'workspace' | 'user';
  target: string;
  license?: string;
  installedAt: string;
}

interface LockFile {
  version: 1;
  skills: Record<string, LockEntry>;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

function lockPath(ctx: SkillInstallContext, scope: 'workspace' | 'user'): string {
  return scope === 'workspace'
    ? path.join(ctx.workspaceDir, '.moss', 'skills.lock.json')
    : path.join(ctx.configDir, 'skills.lock.json');
}

function readLock(ctx: SkillInstallContext, scope: 'workspace' | 'user'): LockFile {
  const file = lockPath(ctx, scope);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'skills' in parsed) {
      const skills = (parsed as { skills?: unknown }).skills;
      if (skills && typeof skills === 'object') {
        return { version: 1, skills: skills as Record<string, LockEntry> };
      }
    }
  } catch {
    // A missing or malformed lock is treated as empty; `lock` reports drift.
  }
  return { version: 1, skills: {} };
}

function writeLock(ctx: SkillInstallContext, scope: 'workspace' | 'user', lock: LockFile): void {
  const file = lockPath(ctx, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

/** Files under a skill directory, relative and sorted, skipping VCS/installed trees. */
function listTree(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  walk(root, '');
  return files;
}

function hashTree(root: string): { hash: string; files: number } {
  const files = listTree(root);
  const digest = crypto.createHash('sha256');
  for (const relative of files) {
    digest.update(relative);
    digest.update('\0');
    digest.update(fs.readFileSync(path.join(root, relative)));
    digest.update('\0');
  }
  return { hash: `sha256:${digest.digest('hex')}`, files: files.length };
}

function findSkillRoots(staging: string): string[] {
  const roots: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) roots.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(staging, 0);
  return roots;
}

function describeKind(source: string): 'local' | 'git' | 'npm' {
  if (fs.existsSync(source)) return 'local';
  if (/^(git@|ssh:\/\/|https?:\/\/|file:\/\/)/.test(source) || source.endsWith('.git'))
    return 'git';
  return 'npm';
}

async function fetchSource(
  source: string,
  staging: string
): Promise<{ contentDir: string; kind: LockEntry['kind']; resolved: string }> {
  const kind = describeKind(source);
  if (kind === 'local') {
    const contentDir = path.join(staging, 'content');
    fs.cpSync(fs.realpathSync(source), contentDir, {
      recursive: true,
      filter: (src) => !SKIP_DIRS.has(path.basename(src)),
    });
    return { contentDir, kind, resolved: fs.realpathSync(source) };
  }
  if (kind === 'git') {
    const cloneDir = path.join(staging, 'repo');
    await runProcess('git', {
      args: ['clone', '--depth', '1', source, cloneDir],
      timeout: 120_000,
    });
    const head = await runProcess('git', {
      args: ['rev-parse', 'HEAD'],
      cwd: cloneDir,
      timeout: 30_000,
    });
    return { contentDir: cloneDir, kind, resolved: head.stdout.trim() };
  }
  // npm: `npm pack --ignore-scripts` (never run lifecycle scripts), then extract.
  const packDir = path.join(staging, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const packed = await runProcess('npm', {
    args: ['pack', source, '--ignore-scripts', '--pack-destination', packDir],
    timeout: 120_000,
    cwd: staging,
  });
  const tarball = packed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .at(-1);
  if (!tarball) throw new Error(`npm pack produced no tarball for ${source}`);
  const extractDir = path.join(staging, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  await runProcess('tar', {
    args: ['-xzf', path.join(packDir, tarball), '-C', extractDir],
    timeout: 120_000,
  });
  const contentDir = path.join(extractDir, 'package');
  let resolved = source;
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(contentDir, 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown }).version;
    if (typeof version === 'string') resolved = `${source}@${version}`;
  } catch {
    // keep the request string
  }
  return { contentDir, kind, resolved };
}

function pickRoot(
  roots: readonly string[],
  requestedName: string | undefined,
  source: string
): { root: string; name: string } {
  if (roots.length === 0) {
    throw new Error(`no SKILL.md found in ${source}`);
  }
  const named = roots.flatMap((root) => {
    const parsed = readSkillManifest(path.join(root, 'SKILL.md'), path.basename(root), 'user');
    return parsed.manifest ? [{ root, manifest: parsed.manifest }] : [];
  });
  if (named.length === 0) throw new Error(`no loadable SKILL.md in ${source}`);
  if (requestedName) {
    const hit = named.find((entry) => entry.manifest.name === requestedName);
    if (!hit) {
      throw new Error(
        `skill "${requestedName}" not found in ${source}; found: ${named
          .map((entry) => entry.manifest.name)
          .join(', ')}`
      );
    }
    return { root: hit.root, name: hit.manifest.name };
  }
  if (named.length > 1) {
    throw new Error(
      `${source} contains multiple skills (${named
        .map((entry) => entry.manifest.name)
        .join(', ')}); pass --name to install one`
    );
  }
  const only = named[0] as { root: string; manifest: { name: string } };
  return { root: only.root, name: only.manifest.name };
}

export async function runSkillInstall(argv: string[], ctx: SkillInstallContext): Promise<number> {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const nameIndex = argv.indexOf('--name');
  const requestedName = nameIndex >= 0 ? argv[nameIndex + 1] : undefined;
  const source = positional[0];
  if (!source) {
    ctx.err('moss skill install: a source is required (directory, git URL, or npm package)');
    return 2;
  }
  const scope: 'workspace' | 'user' = flags.has('--workspace') ? 'workspace' : 'user';
  const yes = flags.has('--yes');
  const kind = describeKind(source);
  if (kind !== 'local' && !yes) {
    ctx.err(`moss skill install: ${kind} sources require --yes (they fetch and copy files)`);
    return 2;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-install-'));
  try {
    const fetched = await fetchSource(source, staging);
    const chosen = pickRoot(findSkillRoots(fetched.contentDir), requestedName, source);
    const parsed = readSkillManifest(path.join(chosen.root, 'SKILL.md'), chosen.name, scope);
    if (!parsed.manifest) {
      ctx.err(
        `moss skill install: "${chosen.name}" is not a loadable skill (${parsed.skip?.reason ?? 'invalid'})`
      );
      return 1;
    }
    const manifest = parsed.manifest;
    const destRoot =
      scope === 'workspace'
        ? path.join(ctx.workspaceDir, '.moss', 'skills')
        : path.join(ctx.configDir, 'skills');
    const dest = path.join(destRoot, manifest.name);
    if (fs.existsSync(dest) && !yes) {
      ctx.err(`moss skill install: ${dest} exists; re-run with --yes to overwrite`);
      return 2;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(chosen.root, dest, {
      recursive: true,
      filter: (src) => !SKIP_DIRS.has(path.basename(src)),
    });
    const { hash, files } = hashTree(dest);
    const lock = readLock(ctx, scope);
    lock.skills[manifest.name] = {
      source,
      kind: fetched.kind,
      resolved: fetched.resolved,
      hash,
      files,
      scope,
      target: dest,
      ...(manifest.license ? { license: manifest.license } : {}),
      installedAt: new Date().toISOString(),
    };
    writeLock(ctx, scope, lock);
    ctx.out(`installed ${manifest.name} → ${dest}`);
    ctx.out(`  source: ${source} (${fetched.kind}, ${fetched.resolved})`);
    ctx.out(`  files: ${String(files)} · ${hash.slice(0, 19)}… · scope: ${scope}`);
    if (manifest.allowedTools.length > 0) {
      ctx.out(
        `  declared tools: ${manifest.allowedTools.join(' ')} (declaration only; approvals are unchanged)`
      );
    }
    if (manifest.resources.scripts.length > 0) {
      ctx.out(
        `  scripts: ${String(manifest.resources.scripts.length)} file(s) copied but never executed automatically`
      );
    }
    for (const issue of manifest.issues) ctx.err(`  [${issue.code}] ${issue.message}`);
    return 0;
  } catch (err) {
    ctx.err(`moss skill install: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function runSkillUpdate(argv: string[], ctx: SkillInstallContext): Promise<number> {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const scope: 'workspace' | 'user' = flags.has('--workspace') ? 'workspace' : 'user';
  const yes = flags.has('--yes');
  const lock = readLock(ctx, scope);
  const names = positional.length > 0 ? positional : Object.keys(lock.skills);
  if (names.length === 0) {
    ctx.out('moss skill update: nothing installed through `moss skill install`');
    return 0;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-update-'));
  let changed = 0;
  let pending = 0;
  try {
    for (const name of names) {
      const entry = lock.skills[name];
      if (!entry) {
        ctx.err(`moss skill update: ${name} is not in ${lockPath(ctx, scope)}`);
        continue;
      }
      const fetched = await fetchSource(entry.source, fs.mkdtempSync(path.join(staging, 'x-')));
      const chosen = pickRoot(findSkillRoots(fetched.contentDir), name, entry.source);
      const next = hashTree(chosen.root);
      const installed = fs.existsSync(entry.target) ? hashTree(entry.target) : undefined;
      if (installed && next.hash === installed.hash) {
        ctx.out(`${name}: up to date (${installed.hash.slice(0, 19)}…)`);
        continue;
      }
      const before = installed ? listTree(entry.target) : [];
      const after = listTree(chosen.root);
      const added = after.filter((file) => !before.includes(file));
      const removed = before.filter((file) => !after.includes(file));
      ctx.out(`${name}: update available from ${entry.source}`);
      ctx.out(
        `  ${installed ? installed.hash.slice(0, 19) : '(missing)'} → ${next.hash.slice(0, 19)}… · ` +
          `+${String(added.length)} -${String(removed.length)} file(s)`
      );
      for (const file of added.slice(0, 5)) ctx.out(`  + ${file}`);
      for (const file of removed.slice(0, 5)) ctx.out(`  - ${file}`);
      if (!yes) {
        pending += 1;
        ctx.err(`moss skill update: re-run with --yes to apply ${name}`);
        continue;
      }
      fs.rmSync(entry.target, { recursive: true, force: true });
      fs.cpSync(chosen.root, entry.target, {
        recursive: true,
        filter: (src) => !SKIP_DIRS.has(path.basename(src)),
      });
      lock.skills[name] = {
        ...entry,
        resolved: fetched.resolved,
        hash: next.hash,
        files: next.files,
        installedAt: new Date().toISOString(),
      };
      changed += 1;
    }
    if (changed > 0) writeLock(ctx, scope, lock);
    return pending > 0 ? 1 : 0;
  } catch (err) {
    ctx.err(`moss skill update: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** `moss skill lock`: verify the installed trees still match the recorded hashes. */
export function runSkillLock(argv: string[], ctx: SkillInstallContext): number {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const scope: 'workspace' | 'user' = flags.has('--workspace') ? 'workspace' : 'user';
  const lock = readLock(ctx, scope);
  const names = Object.keys(lock.skills);
  if (names.length === 0) {
    ctx.out(`no installed skills recorded in ${lockPath(ctx, scope)}`);
    return 0;
  }
  let drift = 0;
  for (const name of names.sort()) {
    const entry = lock.skills[name];
    if (!entry) continue;
    if (!fs.existsSync(entry.target)) {
      ctx.err(`${name}: DRIFT — installed directory is missing (${entry.target})`);
      drift += 1;
      continue;
    }
    const actual = hashTree(entry.target);
    if (actual.hash === entry.hash) {
      ctx.out(`${name}: ok (${String(actual.files)} files, ${actual.hash.slice(0, 19)}…)`);
    } else {
      ctx.err(
        `${name}: DRIFT — ${entry.hash.slice(0, 19)}… recorded, ${actual.hash.slice(0, 19)}… on disk`
      );
      drift += 1;
    }
  }
  if (drift > 0) {
    ctx.err(`${String(drift)} skill(s) drifted from the lockfile; reinstall or update explicitly.`);
    return 1;
  }
  ctx.out(`${String(names.length)} skill(s) match the lockfile.`);
  return 0;
}
