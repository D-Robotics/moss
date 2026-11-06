import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MossError, ErrorCode } from '../errors.js';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, ' ');
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(filePath);
  if (normalized === '~') {
    return os.homedir();
  }
  if (normalized.startsWith('~/')) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

function shortPath(value: string): string {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}

/**
 * B20: a sandbox rejection is recoverable, so it must say how. Two shapes:
 * the caller asked for a path outside the workspace (use a path inside it, or
 * widen permissions), or a symlink made the real target ambiguous.
 */
const SANDBOX_ESCAPE_HINT =
  'Tools may only touch paths inside the workspace: use a workspace-relative path, copy the file in first, ' +
  'or ask the user to widen permissions (permissions.defaultMode: "full" or --full-access) and retry.';

const SANDBOX_WIDEN_HINT =
  'A symlink makes the real target ambiguous inside the workspace sandbox: point the tool at the resolved path ' +
  'inside the workspace, or ask the user to widen permissions (permissions.defaultMode: "full" or --full-access).';

async function assertNoSymlink(relative: string, root: string): Promise<void> {
  if (!relative) {
    return;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new MossError({
          code: ErrorCode.TOOL_NOT_ALLOWED,
          message: `Path contains symlink: ${current}`,
          hint: SANDBOX_WIDEN_HINT,
        });
      }
    } catch (err) {
      const anyErr = err as { code?: string };
      if (anyErr.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }
}

async function assertRootIsNotSymlink(root: string): Promise<void> {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink()) {
      throw new MossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `Sandbox root is a symlink: ${root}`,
        hint: SANDBOX_WIDEN_HINT,
      });
    }
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

function isUnderRoot(resolved: string, root: string): { ok: boolean; relative: string } {
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative === '') {
    return { ok: true, relative: '' };
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, relative };
  }
  return { ok: true, relative };
}

export function resolveSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  extraRoots?: string[];
}): { resolved: string; relative: string; matchedRoot: string } {
  const resolved = resolveToCwd(params.filePath, params.cwd);
  const primaryCheck = isUnderRoot(resolved, params.root);
  if (primaryCheck.ok) {
    return { resolved, relative: primaryCheck.relative, matchedRoot: path.resolve(params.root) };
  }
  if (params.extraRoots) {
    for (const extra of params.extraRoots) {
      const check = isUnderRoot(resolved, extra);
      if (check.ok) {
        return { resolved, relative: check.relative, matchedRoot: path.resolve(extra) };
      }
    }
  }
  throw new MossError({
    code: ErrorCode.TOOL_NOT_ALLOWED,
    message: `Path escapes workspace (${shortPath(path.resolve(params.root))}): ${params.filePath}`,
    hint: SANDBOX_ESCAPE_HINT,
  });
}

/**
 * Resolve a not-yet-existing target to its real location: realpath the nearest
 * existing ancestor and append the rest. macOS `/tmp` → `/private/tmp` is the
 * canonical case (B91): a lexical check compares `/tmp/ws/x` against a root
 * spelled `/private/tmp/ws` and refuses a write that is actually inside.
 */
async function realpathNearest(target: string): Promise<string> {
  let current = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** Lexical miss → retry once through realpath; a genuine escape still throws. */
async function resolveSandboxPathAfterRealpath(
  params: { filePath: string; cwd: string; root: string; extraRoots?: string[] },
  originalError: unknown
): Promise<{ resolved: string; relative: string; matchedRoot: string }> {
  const candidate = resolveToCwd(params.filePath, params.cwd);
  const realCandidate = await realpathNearest(candidate);
  for (const root of [params.root, ...(params.extraRoots ?? [])]) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    const relative = path.relative(realRoot, realCandidate);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return { resolved: candidate, relative, matchedRoot: realRoot };
    }
  }
  throw originalError;
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  extraRoots?: string[];
}): Promise<{ resolved: string; relative: string }> {
  let resolved: { resolved: string; relative: string; matchedRoot: string };
  try {
    resolved = resolveSandboxPath(params);
  } catch (err) {
    resolved = await resolveSandboxPathAfterRealpath(params, err);
  }
  await assertRootIsNotSymlink(resolved.matchedRoot);
  await assertNoSymlink(resolved.relative, resolved.matchedRoot);

  try {
    const realResolved = await fs.realpath(resolved.resolved);
    const realRoot = await fs.realpath(resolved.matchedRoot);
    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      throw new MossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `path escapes sandbox after realpath resolution: ${params.filePath}`,
        hint: SANDBOX_ESCAPE_HINT,
      });
    }
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== 'ENOENT') throw err;
  }

  return { resolved: resolved.resolved, relative: resolved.relative };
}
