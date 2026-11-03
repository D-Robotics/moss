/**
 * Worktree isolation for writable parallel sub-agents (v0.15-S2).
 *
 * A `worktree: true` sub-agent runs in its own `git worktree` detached at the
 * parent's HEAD, so concurrent writers cannot stomp each other or the parent
 * workspace. When the child finishes, its changes are collected as a binary
 * patch under `<parent>/.moss/patches/<leaseId>.patch`; the parent merges
 * leases back with `git apply --3way` (see mergeLeasePatch, wired into
 * ToolContext.mergeWorkspacePatch).
 *
 * All git access goes through runGit with argv arrays — never a shell.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from '../../utils/git-spawn.js';
import type { RunProcessResult } from '../../utils/run-process.js';
import { getRootLogger } from '../../logger.js';
import { errorMessage } from '../../errors.js';

const log = getRootLogger().child('worktree-isolation');
const GIT_TIMEOUT_MS = 60_000;

async function git(
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; readOnly?: boolean }
): Promise<RunProcessResult> {
  return runGit(args, {
    cwd: opts.cwd,
    signal: opts.signal,
    timeout: GIT_TIMEOUT_MS,
    readOnly: opts.readOnly,
  });
}

export interface WorktreeLease {
  leaseId: string;
  worktreePath: string;
  baseRev: string;
}

export async function createWorktree(opts: {
  parentWorkspace: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<WorktreeLease> {
  const head = await git(['rev-parse', 'HEAD'], { cwd: opts.parentWorkspace });
  const baseRev = head.stdout.trim();
  const leaseId = opts.runId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-60);
  const worktreePath = path.join(opts.parentWorkspace, '.moss', 'worktrees', leaseId);
  await git(['worktree', 'add', '--detach', worktreePath, baseRev], {
    cwd: opts.parentWorkspace,
    signal: opts.signal,
    readOnly: false,
  });
  return { leaseId, worktreePath, baseRev };
}

export interface WorktreePatch {
  patchId: string;
  patchPath: string;
  patchDigest: string;
  changedPaths: string[];
  patch: string;
  empty: boolean;
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') || text === '' ? text : `${text}\n`;
}

export async function collectWorktreePatch(opts: {
  parentWorkspace: string;
  lease: WorktreeLease;
  signal?: AbortSignal;
}): Promise<WorktreePatch> {
  const wt = opts.lease.worktreePath;
  const ignored = await git(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    {
      cwd: wt,
      signal: opts.signal,
    }
  );
  if (ignored.stdout || ignored.stdoutOverflow) {
    throw new Error('Worktree contains ignored files that cannot be included in the patch');
  }
  // -N records new files in the index without content so untracked work shows
  // up in `git diff`.
  await git(['add', '-A', '-N'], { cwd: wt, signal: opts.signal, readOnly: false });
  const index = await git(['ls-files', '--stage', '-z'], { cwd: wt, signal: opts.signal });
  if (index.stdoutOverflow || index.stdout.includes('�')) {
    throw new Error('Worktree index cannot be inspected reliably');
  }
  for (const entry of index.stdout.split('\0')) {
    const match = /^160000 [0-9a-f]+ \d\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    try {
      fs.lstatSync(path.join(wt, match[1], '.git'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const baseEntry = await git(
      ['ls-tree', '-z', opts.lease.baseRev, '--', `:(literal)${match[1]}`],
      {
        cwd: wt,
        signal: opts.signal,
      }
    );
    if (baseEntry.stdoutOverflow || !baseEntry.stdout.startsWith('160000 commit ')) {
      throw new Error(
        'Worktree contains an embedded Git repository that cannot be included in the patch'
      );
    }
    const nestedStatus = await git(
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignored=matching',
        '--ignore-submodules=none',
      ],
      { cwd: path.join(wt, match[1]), signal: opts.signal }
    );
    if (nestedStatus.stdout || nestedStatus.stdoutOverflow) {
      throw new Error('Worktree contains submodule changes that cannot be included in the patch');
    }
  }
  const names = await git(['diff', '--name-only', opts.lease.baseRev], {
    cwd: wt,
    signal: opts.signal,
  });
  if (names.stdoutOverflow) throw new Error('Worktree changed paths exceed the capture limit');
  const changedPaths = names.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const diff = await git(
    [
      'diff',
      '--binary',
      '--unified=3',
      '--no-color',
      '--no-relative',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      opts.lease.baseRev,
    ],
    {
      cwd: wt,
      signal: opts.signal,
    }
  );
  if (diff.stdoutOverflow) throw new Error('Worktree diff exceeds the capture limit');
  // The process boundary decodes each chunk as UTF-8. A replacement character
  // can mean non-UTF-8 bytes or a split multibyte sequence; either would make
  // writing this string back potentially lossy.
  if (diff.stdout.includes('�')) throw new Error('Worktree diff has unsafe UTF-8 encoding');
  const patch = withTrailingNewline(diff.stdout);
  const patchDigest = createHash('sha256').update(patch).digest('hex').slice(0, 16);
  const patchDir = path.join(opts.parentWorkspace, '.moss', 'patches');
  fs.mkdirSync(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${opts.lease.leaseId}.patch`);
  fs.writeFileSync(patchPath, patch, { encoding: 'utf8', flag: 'wx' });
  return {
    patchId: patchDigest,
    patchPath,
    patchDigest,
    changedPaths,
    patch,
    empty: patch.trim() === '',
  };
}

export type ApplyPatchResult =
  | { status: 'merged' }
  | { status: 'merge_conflict'; conflictingPaths: readonly string[] };

export async function applyWorktreePatch(opts: {
  parentWorkspace: string;
  patchPath: string;
  signal?: AbortSignal;
}): Promise<ApplyPatchResult> {
  // Paths this patch touches — staged after a successful merge so the NEXT
  // lease's `git apply --3way` sees it as "ours" via the index (3-way takes
  // ours from the index, not the working tree).
  const numstat = await git(['apply', '--numstat', opts.patchPath], {
    cwd: opts.parentWorkspace,
    readOnly: false,
  }).catch(() => undefined);
  const touched = (numstat?.stdout ?? '')
    .split('\n')
    .map((line) => line.split('\t')[2]?.trim())
    .filter(Boolean);
  try {
    await git(['apply', '--3way', opts.patchPath], {
      cwd: opts.parentWorkspace,
      signal: opts.signal,
      readOnly: false,
    });
    if (touched.length) {
      await git(['add', '--', ...touched], {
        cwd: opts.parentWorkspace,
        readOnly: false,
      }).catch(() => undefined);
    }
    return { status: 'merged' };
  } catch {
    const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], {
      cwd: opts.parentWorkspace,
    })
      .then((r) =>
        r.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      )
      .catch(() => [] as string[]);
    return { status: 'merge_conflict', conflictingPaths: conflicts };
  }
}

/** Merge a collected lease patch back into the parent workspace (digest-checked). */
export async function mergeLeasePatch(opts: {
  parentWorkspace: string;
  leaseId: string;
  patchId: string;
  signal?: AbortSignal;
}): Promise<ApplyPatchResult> {
  const patchPath = path.join(opts.parentWorkspace, '.moss', 'patches', `${opts.leaseId}.patch`);
  if (!fs.existsSync(patchPath)) {
    return {
      status: 'merge_conflict',
      conflictingPaths: [`.moss/patches/${opts.leaseId}.patch (lease patch missing)`],
    };
  }
  const patch = fs.readFileSync(patchPath, 'utf8');
  const digest = createHash('sha256').update(withTrailingNewline(patch)).digest('hex').slice(0, 16);
  if (digest !== opts.patchId) {
    return {
      status: 'merge_conflict',
      conflictingPaths: [
        `.moss/patches/${opts.leaseId}.patch (digest mismatch: expected ${opts.patchId})`,
      ],
    };
  }
  return applyWorktreePatch({
    parentWorkspace: opts.parentWorkspace,
    patchPath,
    signal: opts.signal,
  });
}

export async function cleanupWorktree(opts: {
  parentWorkspace: string;
  worktreePath: string;
}): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', opts.worktreePath], {
      cwd: opts.parentWorkspace,
      readOnly: false,
    });
  } catch (err) {
    log.warn('worktree remove failed', {
      error: errorMessage(err),
      path: opts.worktreePath,
    });
  }
  try {
    await git(['worktree', 'prune'], { cwd: opts.parentWorkspace, readOnly: false });
  } catch {
    /* best-effort */
  }
}
