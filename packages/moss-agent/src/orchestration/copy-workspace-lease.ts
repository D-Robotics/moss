import fs from 'node:fs';
import path from 'node:path';

import { ErrorCode, MossError } from '../errors.js';
import { BaseWorkspaceLeaseAdapter } from './workspace-lease-adapter.js';
import { copyWorkspaceEntry } from './workspace-lease-files.js';
import type {
  CreateWorkspaceLeaseInput,
  WorkspaceLease,
  WorkspaceLeaseAdapterOptions,
} from './workspace-lease-types.js';

/** Non-Git and unborn-repository fallback backed by a filtered copy snapshot. @beta */
export class CopyWorkspaceLeaseAdapter extends BaseWorkspaceLeaseAdapter {
  constructor(options: WorkspaceLeaseAdapterOptions) {
    super('copy-snapshot', options);
  }

  async create(input: CreateWorkspaceLeaseInput): Promise<WorkspaceLease> {
    if (this.load(input.id)) throw this.invalid(`workspace lease already exists: ${input.id}`);
    const parentWorkspace = path.resolve(input.parentWorkspace);
    const leaseDir = this.leaseDirectory(input.id);
    const workspacePath = path.join(leaseDir, 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    try {
      for (const entry of fs.readdirSync(parentWorkspace)) {
        copyWorkspaceEntry(parentWorkspace, workspacePath, entry);
      }
      await this.git(workspacePath, ['init']);
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
      fs.rmSync(leaseDir, { recursive: true, force: true });
      throw error;
    }
  }

  protected removeWorkspace(_lease: WorkspaceLease): Promise<void> {
    return Promise.resolve();
  }

  private invalid(message: string): MossError {
    return new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
  }
}
