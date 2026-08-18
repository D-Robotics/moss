import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';
import { runProcess } from '../utils/run-process.js';
import { normalizeWritePath, writePathsOverlap } from './execution-graph-scheduler.js';
import { assertLeasePath, captureBaselineHashes, hashFile } from './workspace-lease-files.js';
import { isExcludedWorkspacePath } from './workspace-lease-files.js';
import type {
  CreateWorkspaceLeaseInput,
  WorkspaceLease,
  WorkspaceLeaseAdapter,
  WorkspaceLeaseAdapterOptions,
  WorkspaceLeaseKind,
  WorkspaceLeaseReleaseReason,
  WorkspaceMergeResult,
  WorkspacePatch,
} from './workspace-lease-types.js';

const PROCESS_TIMEOUT_MS = 120_000;

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function parseNullSeparated(value: string): string[] {
  return value.split('\0').filter(Boolean).map(normalizeWritePath).sort();
}

export abstract class BaseWorkspaceLeaseAdapter implements WorkspaceLeaseAdapter {
  protected readonly rootDir: string;
  protected readonly now: () => number;
  private readonly authorizeMerge: WorkspaceLeaseAdapterOptions['authorizeMerge'];

  protected constructor(
    private readonly kind: WorkspaceLeaseKind,
    options: WorkspaceLeaseAdapterOptions
  ) {
    this.rootDir = path.resolve(options.rootDir);
    this.now = options.now ?? Date.now;
    this.authorizeMerge = options.authorizeMerge;
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
  }

  abstract create(input: CreateWorkspaceLeaseInput): Promise<WorkspaceLease>;

  load(leaseId: string): WorkspaceLease | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.manifestFile(leaseId), 'utf8')) as WorkspaceLease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw this.failure(`Failed to load workspace lease "${leaseId}"`, error);
    }
  }

  list(): readonly WorkspaceLease[] {
    return fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.load(entry.name))
      .filter((lease): lease is WorkspaceLease => lease !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async createPatch(lease: WorkspaceLease): Promise<WorkspacePatch> {
    this.assertCompatible(lease);
    const loaded = this.requiredLease(lease.id);
    await this.git(loaded.workspacePath, ['add', '-A']);
    const names = await this.git(loaded.workspacePath, [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      loaded.baseRef,
      '--',
      '.',
    ]);
    const changedPaths = parseNullSeparated(names.stdout);
    const excluded = changedPaths.filter(isExcludedWorkspacePath);
    if (excluded.length > 0) {
      throw new MossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `workspace changes include excluded secret or runtime paths: ${excluded.join(', ')}`,
      });
    }
    const outside = changedPaths.filter(
      (changed) => !loaded.writePaths.some((declared) => writePathsOverlap([changed], [declared]))
    );
    if (outside.length > 0) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `workspace changes outside declared write paths: ${outside.join(', ')}`,
      });
    }
    const diff = await this.git(loaded.workspacePath, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      loaded.baseRef,
      '--',
      '.',
    ]);
    const patchId = `patch_${randomUUID()}`;
    const artifactDirectory = path.join(this.leaseDirectory(loaded.id), 'artifacts');
    const artifactRef = path.join(artifactDirectory, `${patchId}.patch`);
    fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(artifactRef, diff.stdout, { mode: 0o600 });
    const patch: WorkspacePatch = {
      id: patchId,
      leaseId: loaded.id,
      patch: diff.stdout,
      artifactRef,
      digest: `sha256:${createHash('sha256').update(diff.stdout).digest('hex')}`,
      changedPaths,
      createdAt: this.now(),
    };
    this.writeJsonAtomic(path.join(artifactDirectory, `${patchId}.json`), patch);
    return patch;
  }

  async merge(lease: WorkspaceLease, patch: WorkspacePatch): Promise<WorkspaceMergeResult> {
    this.assertCompatible(lease);
    const loaded = this.requiredLease(lease.id);
    const trusted = this.requiredPatch(loaded, patch);
    if (trusted.leaseId !== loaded.id) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `patch "${patch.id}" belongs to another workspace lease`,
      });
    }
    const excluded = trusted.changedPaths.filter(isExcludedWorkspacePath);
    const outside = trusted.changedPaths.filter(
      (changed) => !loaded.writePaths.some((declared) => writePathsOverlap([changed], [declared]))
    );
    if (excluded.length > 0 || outside.length > 0) {
      throw new MossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `stored patch violates workspace write policy: ${[...excluded, ...outside].join(', ')}`,
      });
    }
    const conflictingPaths = trusted.changedPaths.filter((relative) => {
      const current = hashFile(path.join(loaded.parentWorkspace, ...relative.split('/')));
      return current !== (loaded.baselineHashes[relative] ?? null);
    });
    if (conflictingPaths.length > 0) {
      return {
        status: 'merge_conflict',
        patchId: patch.id,
        conflictingPaths,
        digest: trusted.digest,
        changedPaths: trusted.changedPaths,
      };
    }
    if (this.authorizeMerge) {
      try {
        await this.authorizeMerge({
          lease: loaded,
          patchId: trusted.id,
          digest: trusted.digest,
          changedPaths: trusted.changedPaths,
        });
      } catch (error) {
        throw wrapAsMoss(error, ErrorCode.TOOL_NOT_ALLOWED, {
          message: `Workspace patch authorization failed: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        });
      }
    }
    if (trusted.patch) {
      await this.git(
        loaded.parentWorkspace,
        ['apply', '--check', '--whitespace=nowarn', '-'],
        trusted.patch
      );
      await this.git(loaded.parentWorkspace, ['apply', '--whitespace=nowarn', '-'], trusted.patch);
    }
    await this.release(loaded.id, 'merged');
    return {
      status: 'merged',
      patchId: patch.id,
      conflictingPaths: [],
      digest: trusted.digest,
      changedPaths: trusted.changedPaths,
    };
  }

  async mergeStored(leaseId: string, patchId: string): Promise<WorkspaceMergeResult> {
    const lease = this.requiredLease(leaseId);
    return this.merge(lease, this.loadStoredPatch(lease, patchId));
  }

  async release(leaseId: string, reason: WorkspaceLeaseReleaseReason): Promise<void> {
    const lease = this.load(leaseId);
    if (!lease) return;
    this.assertCompatible(lease);
    const terminal: WorkspaceLease = {
      ...lease,
      status: reason,
      updatedAt: this.now(),
    };
    this.writeManifest(terminal);
    await this.removeWorkspace(terminal);
    fs.rmSync(assertLeasePath(this.rootDir, leaseId), { recursive: true, force: true });
  }

  protected abstract removeWorkspace(lease: WorkspaceLease): Promise<void>;

  protected createManifest(
    input: CreateWorkspaceLeaseInput,
    workspacePath: string,
    baseRef: string
  ): WorkspaceLease {
    const now = this.now();
    const writePaths = input.writePaths.map(normalizeWritePath);
    if (writePaths.length === 0) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: 'implementation workspace lease requires at least one declared write path',
      });
    }
    return {
      id: input.id,
      graphId: input.graphId,
      nodeId: input.nodeId,
      kind: this.kind,
      status: 'active',
      parentWorkspace: path.resolve(input.parentWorkspace),
      workspacePath,
      writePaths,
      baseRef,
      baselineHashes: captureBaselineHashes(input.parentWorkspace, writePaths),
      createdAt: now,
      updatedAt: now,
    };
  }

  protected writeManifest(lease: WorkspaceLease): void {
    const file = this.manifestFile(lease.id);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  protected leaseDirectory(leaseId: string): string {
    return assertLeasePath(this.rootDir, leaseId);
  }

  protected async git(
    cwd: string,
    args: readonly string[],
    stdin?: string,
    extraEnv: Readonly<Record<string, string>> = {}
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await runProcess('git', {
        args: [...args],
        cwd,
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
        ...(stdin !== undefined ? { stdin } : {}),
        env: { ...processEnvironment(), ...extraEnv },
      });
    } catch (error) {
      throw this.failure(`Git command failed: git ${args.join(' ')}`, error);
    }
  }

  protected commitEnvironment(): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: 'Moss Workspace Lease',
      GIT_AUTHOR_EMAIL: 'moss-workspace@example.invalid',
      GIT_COMMITTER_NAME: 'Moss Workspace Lease',
      GIT_COMMITTER_EMAIL: 'moss-workspace@example.invalid',
    };
  }

  private manifestFile(leaseId: string): string {
    return path.join(assertLeasePath(this.rootDir, leaseId), 'lease.json');
  }

  private requiredPatch(lease: WorkspaceLease, supplied: WorkspacePatch): WorkspacePatch {
    const persisted = this.loadStoredPatch(lease, supplied.id);
    const exactMetadata =
      supplied.leaseId === persisted.leaseId &&
      supplied.artifactRef === persisted.artifactRef &&
      supplied.digest === persisted.digest &&
      supplied.patch === persisted.patch &&
      JSON.stringify(supplied.changedPaths) === JSON.stringify(persisted.changedPaths);
    if (!exactMetadata) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `patch "${supplied.id}" does not match its stored artifact`,
      });
    }
    return persisted;
  }

  private loadStoredPatch(lease: WorkspaceLease, patchId: string): WorkspacePatch {
    const artifactDirectory = path.join(this.leaseDirectory(lease.id), 'artifacts');
    const expectedArtifact = path.join(artifactDirectory, `${patchId}.patch`);
    const metadataFile = path.join(artifactDirectory, `${patchId}.json`);
    let persisted: WorkspacePatch;
    let patchBody: string;
    try {
      persisted = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) as WorkspacePatch;
      patchBody = fs.readFileSync(expectedArtifact, 'utf8');
    } catch (error) {
      throw this.failure(`Failed to load stored workspace patch "${patchId}"`, error);
    }
    const digest = `sha256:${createHash('sha256').update(patchBody).digest('hex')}`;
    const exactMetadata =
      persisted.id === patchId &&
      persisted.leaseId === lease.id &&
      persisted.artifactRef === expectedArtifact;
    if (!exactMetadata || digest !== persisted.digest) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `patch "${patchId}" does not match its stored artifact`,
      });
    }
    return { ...persisted, patch: patchBody };
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  private requiredLease(leaseId: string): WorkspaceLease {
    const lease = this.load(leaseId);
    if (!lease) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `unknown workspace lease "${leaseId}"`,
      });
    }
    if (lease.status !== 'active') {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `workspace lease "${leaseId}" is ${lease.status}`,
      });
    }
    return lease;
  }

  private assertCompatible(lease: WorkspaceLease): void {
    if (lease.kind !== this.kind) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `workspace lease "${lease.id}" requires ${lease.kind} adapter`,
      });
    }
  }

  private failure(message: string, cause: unknown): MossError {
    return wrapAsMoss(cause, ErrorCode.EXECUTION_STORE_FAILED, {
      message,
      recoverable: true,
    });
  }
}
