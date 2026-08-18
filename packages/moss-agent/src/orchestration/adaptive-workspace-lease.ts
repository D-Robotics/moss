import { ErrorCode, MossError } from '../errors.js';
import { runProcess } from '../utils/run-process.js';
import { CopyWorkspaceLeaseAdapter } from './copy-workspace-lease.js';
import { GitWorktreeWorkspaceLeaseAdapter } from './git-worktree-workspace-lease.js';
import type {
  CreateWorkspaceLeaseInput,
  WorkspaceLease,
  WorkspaceLeaseAdapter,
  WorkspaceLeaseAdapterOptions,
  WorkspaceLeaseReleaseReason,
  WorkspaceMergeResult,
  WorkspacePatch,
} from './workspace-lease-types.js';

/** Selects Git worktrees for repositories with a HEAD and copy snapshots otherwise. @beta */
export class AdaptiveWorkspaceLeaseAdapter implements WorkspaceLeaseAdapter {
  private readonly git: GitWorktreeWorkspaceLeaseAdapter;
  private readonly copy: CopyWorkspaceLeaseAdapter;

  constructor(options: WorkspaceLeaseAdapterOptions) {
    this.git = new GitWorktreeWorkspaceLeaseAdapter({
      ...options,
      rootDir: `${options.rootDir}/git`,
    });
    this.copy = new CopyWorkspaceLeaseAdapter({
      ...options,
      rootDir: `${options.rootDir}/copy`,
    });
  }

  async create(input: CreateWorkspaceLeaseInput): Promise<WorkspaceLease> {
    if (this.load(input.id)) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `workspace lease already exists: ${input.id}`,
      });
    }
    let hasGitHead = false;
    try {
      await runProcess('git', {
        args: ['rev-parse', '--verify', 'HEAD'],
        cwd: input.parentWorkspace,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      hasGitHead = true;
    } catch {}
    return hasGitHead ? this.git.create(input) : this.copy.create(input);
  }

  load(leaseId: string): WorkspaceLease | undefined {
    return this.git.load(leaseId) ?? this.copy.load(leaseId);
  }

  list(): readonly WorkspaceLease[] {
    return [...this.git.list(), ...this.copy.list()].sort(
      (left, right) => right.updatedAt - left.updatedAt
    );
  }

  createPatch(lease: WorkspaceLease): Promise<WorkspacePatch> {
    return this.adapterFor(lease).createPatch(lease);
  }

  merge(lease: WorkspaceLease, patch: WorkspacePatch): Promise<WorkspaceMergeResult> {
    return this.adapterFor(lease).merge(lease, patch);
  }

  mergeStored(leaseId: string, patchId: string): Promise<WorkspaceMergeResult> {
    const lease = this.load(leaseId);
    if (!lease) {
      return Promise.reject(
        new MossError({
          code: ErrorCode.EXECUTION_STATE_INVALID,
          message: `unknown workspace lease "${leaseId}"`,
        })
      );
    }
    return this.adapterFor(lease).mergeStored(leaseId, patchId);
  }

  release(leaseId: string, reason: WorkspaceLeaseReleaseReason): Promise<void> {
    const lease = this.load(leaseId);
    return lease ? this.adapterFor(lease).release(leaseId, reason) : Promise.resolve();
  }

  private adapterFor(lease: WorkspaceLease): WorkspaceLeaseAdapter {
    return lease.kind === 'git-worktree' ? this.git : this.copy;
  }
}
