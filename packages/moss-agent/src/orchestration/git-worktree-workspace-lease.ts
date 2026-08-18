import fs from 'node:fs';
import path from 'node:path';

import { ErrorCode, MossError } from '../errors.js';
import { BaseWorkspaceLeaseAdapter } from './workspace-lease-adapter.js';
import { copyWorkspaceEntry, isExcludedWorkspacePath } from './workspace-lease-files.js';
import type {
  CreateWorkspaceLeaseInput,
  WorkspaceLease,
  WorkspaceLeaseAdapterOptions,
} from './workspace-lease-types.js';

/** Git worktree adapter seeded with tracked, staged, unstaged, and safe untracked content. @beta */
export class GitWorktreeWorkspaceLeaseAdapter extends BaseWorkspaceLeaseAdapter {
  constructor(options: WorkspaceLeaseAdapterOptions) {
    super('git-worktree', options);
  }

  async create(input: CreateWorkspaceLeaseInput): Promise<WorkspaceLease> {
    if (this.load(input.id)) throw this.invalid(`workspace lease already exists: ${input.id}`);
    const parentWorkspace = path.resolve(input.parentWorkspace);
    const inside = await this.git(parentWorkspace, ['rev-parse', '--is-inside-work-tree']);
    if (inside.stdout.trim() !== 'true')
      throw this.invalid('parent workspace is not a Git worktree');
    const head = await this.git(parentWorkspace, ['rev-parse', '--verify', 'HEAD']);
    const leaseDir = this.leaseDirectory(input.id);
    const workspacePath = path.join(leaseDir, 'workspace');
    fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    try {
      await this.git(parentWorkspace, [
        'worktree',
        'add',
        '--detach',
        workspacePath,
        head.stdout.trim(),
      ]);
      const tracked = await this.git(parentWorkspace, ['ls-files', '-z']);
      const untracked = await this.git(parentWorkspace, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]);
      for (const relative of [...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')]) {
        if (!relative || isExcludedWorkspacePath(relative)) continue;
        const source = path.join(parentWorkspace, relative);
        try {
          fs.lstatSync(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        copyWorkspaceEntry(parentWorkspace, workspacePath, relative);
      }
      this.removeExcludedRoots(workspacePath);
      await this.git(workspacePath, ['add', '-A']);
      await this.git(
        workspacePath,
        ['commit', '--allow-empty', '-m', 'moss workspace lease baseline'],
        undefined,
        this.commitEnvironment()
      );
      const base = await this.git(workspacePath, ['rev-parse', 'HEAD']);
      const lease = this.createManifest(
        { ...input, parentWorkspace },
        workspacePath,
        base.stdout.trim()
      );
      this.writeManifest(lease);
      return lease;
    } catch (error) {
      try {
        await this.git(parentWorkspace, ['worktree', 'remove', '--force', workspacePath]);
      } catch {}
      fs.rmSync(leaseDir, { recursive: true, force: true });
      throw error;
    }
  }

  protected async removeWorkspace(lease: WorkspaceLease): Promise<void> {
    if (!fs.existsSync(lease.workspacePath)) return;
    await this.git(lease.parentWorkspace, ['worktree', 'remove', '--force', lease.workspacePath]);
  }

  private removeExcludedRoots(workspacePath: string): void {
    for (const entry of fs.readdirSync(workspacePath)) {
      if (entry === '.git') continue;
      if (!isExcludedWorkspacePath(entry)) continue;
      fs.rmSync(path.join(workspacePath, entry), { recursive: true, force: true });
    }
  }

  private invalid(message: string): MossError {
    return new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
  }
}
