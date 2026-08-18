/** Isolation strategy used for one implementation assignment. @beta */
export type WorkspaceLeaseKind = 'git-worktree' | 'copy-snapshot';

/** Lifecycle retained on disk for an isolated workspace. @beta */
export type WorkspaceLeaseStatus = 'active' | 'merged' | 'rejected' | 'cancelled';

/** Input for creating an implementation workspace lease. @beta */
export interface CreateWorkspaceLeaseInput {
  readonly id: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly parentWorkspace: string;
  readonly writePaths: readonly string[];
}

/** Durable manifest for one isolated implementation workspace. @beta */
export interface WorkspaceLease {
  readonly id: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly kind: WorkspaceLeaseKind;
  readonly status: WorkspaceLeaseStatus;
  readonly parentWorkspace: string;
  readonly workspacePath: string;
  readonly writePaths: readonly string[];
  readonly baseRef: string;
  readonly baselineHashes: Readonly<Record<string, string | null>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Patch and artifact digest returned by an isolated worker. @beta */
export interface WorkspacePatch {
  readonly id: string;
  readonly leaseId: string;
  readonly patch: string;
  /** Durable local artifact containing the exact patch bytes. */
  readonly artifactRef: string;
  readonly digest: string;
  readonly changedPaths: readonly string[];
  readonly createdAt: number;
}

/** Guarded parent merge result. @beta */
export interface WorkspaceMergeResult {
  readonly status: 'merged' | 'merge_conflict';
  readonly patchId: string;
  readonly conflictingPaths: readonly string[];
}

/** Explicit terminal reasons that permit lease cleanup. @beta */
export type WorkspaceLeaseReleaseReason = 'merged' | 'rejected' | 'cancelled';

/** Isolation seam used by implementation roles. @beta */
export interface WorkspaceLeaseAdapter {
  create(input: CreateWorkspaceLeaseInput): Promise<WorkspaceLease>;
  load(leaseId: string): WorkspaceLease | undefined;
  list(): readonly WorkspaceLease[];
  createPatch(lease: WorkspaceLease): Promise<WorkspacePatch>;
  merge(lease: WorkspaceLease, patch: WorkspacePatch): Promise<WorkspaceMergeResult>;
  release(leaseId: string, reason: WorkspaceLeaseReleaseReason): Promise<void>;
}

/** Shared workspace adapter options. @beta */
export interface WorkspaceLeaseAdapterOptions {
  readonly rootDir: string;
  readonly now?: () => number;
  readonly authorizeMerge?: (request: WorkspaceMergeAuthorizationRequest) => void | Promise<void>;
}

/** Host approval request emitted after hash checks and before parent mutation. @beta */
export interface WorkspaceMergeAuthorizationRequest {
  readonly lease: WorkspaceLease;
  readonly patchId: string;
  readonly digest: string;
  readonly changedPaths: readonly string[];
}
