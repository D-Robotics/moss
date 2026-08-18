import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ErrorCode, MossError } from '../errors.js';
import { normalizeWritePath } from './execution-graph-scheduler.js';

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.moss',
  'node_modules',
  '.cache',
  '.next',
  'dist',
  'build',
  'coverage',
]);

export function isExcludedWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true;
  const basename = segments.at(-1) ?? '';
  return basename === '.env' || basename.startsWith('.env.');
}

export function hashFile(file: string): string | null {
  try {
    const stats = fs.lstatSync(file);
    if (stats.isSymbolicLink()) {
      return `symlink:${createHash('sha256').update(fs.readlinkSync(file)).digest('hex')}`;
    }
    if (!stats.isFile()) return null;
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function listFiles(root: string, relativeRoot = ''): string[] {
  const absolute = path.join(root, relativeRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    const stats = fs.lstatSync(absolute);
    return stats.isFile() || stats.isSymbolicLink() ? [normalizeWritePath(relativeRoot)] : [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (isExcludedWorkspacePath(relative)) continue;
    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(normalizeWritePath(relative));
  }
  return files.sort();
}

export function captureBaselineHashes(
  parentWorkspace: string,
  writePaths: readonly string[]
): Readonly<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const declared of writePaths.map(normalizeWritePath)) {
    const absolute = path.join(parentWorkspace, ...declared.split('/'));
    const direct = hashFile(absolute);
    if (direct !== null) {
      hashes[declared] = direct;
      continue;
    }
    for (const relative of listFiles(parentWorkspace, declared)) {
      hashes[relative] = hashFile(path.join(parentWorkspace, ...relative.split('/')));
    }
  }
  return hashes;
}

export function copyWorkspaceEntry(sourceRoot: string, targetRoot: string, relative: string): void {
  if (isExcludedWorkspacePath(relative)) return;
  const normalized = normalizeWritePath(relative);
  const source = path.join(sourceRoot, ...normalized.split('/'));
  const target = path.join(targetRoot, ...normalized.split('/'));
  const stats = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stats.isSymbolicLink()) {
    const link = fs.readlinkSync(source);
    const resolved = path.resolve(path.dirname(source), link);
    const parent = `${path.resolve(sourceRoot)}${path.sep}`;
    if (!resolved.startsWith(parent)) return;
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fs.symlinkSync(link, target, process.platform === 'win32' ? 'junction' : undefined);
    return;
  }
  if (stats.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyWorkspaceEntry(sourceRoot, targetRoot, `${normalized}/${entry}`);
    }
    return;
  }
  if (stats.isFile()) fs.copyFileSync(source, target);
}

export function assertLeasePath(rootDir: string, leaseId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(leaseId)) {
    throw new MossError({
      code: ErrorCode.EXECUTION_STATE_INVALID,
      message: 'workspace lease id contains unsafe characters',
    });
  }
  const leaseDir = path.resolve(rootDir, leaseId);
  if (!leaseDir.startsWith(`${path.resolve(rootDir)}${path.sep}`)) {
    throw new MossError({
      code: ErrorCode.EXECUTION_STATE_INVALID,
      message: 'workspace lease escaped its storage root',
    });
  }
  return leaseDir;
}
