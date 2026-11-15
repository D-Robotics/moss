import type { RsiTaskScope } from './types.js';

export type RsiAssetKind = 'experience' | 'case' | 'adapter' | 'evaluation' | 'manifest';
export interface RsiAssetRecord {
  id: string;
  /** Exact payload digest; legacy records used id before scope-qualified identities. */
  contentDigest?: string;
  kind: RsiAssetKind;
  taskScopeDigest: string;
  taskScope: RsiTaskScope;
  bytes: number;
  createdAt: number;
  dependencies: string[];
  adapterDigest?: string;
  sessionId?: string;
  sourceId?: string;
  deletedAt?: number;
}
export interface RsiWorkspaceLease {
  id: string;
  sessionId: string;
  taskScopeDigest: string;
  kind: 'training' | 'upload';
  maxBytes: number;
  createdAt: number;
  endedAt?: number;
  status: 'running' | 'revoked' | 'completed' | 'failed' | 'cancelled';
}
export interface RsiAssetState {
  schemaVersion: 1;
  quotaBytes: number;
  evidenceRetentionDays: number;
  summaryRetentionDays: number;
  failedWorkspaceRetentionDays: number;
  records: RsiAssetRecord[];
  leases: RsiWorkspaceLease[];
  /** Monotonic revocations: a backup cannot resurrect deleted evidence or candidates. */
  deletedIds: string[];
  invalidatedAdapters: string[];
  deletions: Array<{
    id: string;
    taskScopeDigest: string;
    assetIds: string[];
    sessionIds: string[];
    at: number;
    completedAt?: number;
  }>;
}
export const defaultRsiAssets = (): RsiAssetState => ({
  schemaVersion: 1,
  quotaBytes: 1_073_741_824,
  evidenceRetentionDays: 30,
  summaryRetentionDays: 180,
  failedWorkspaceRetentionDays: 7,
  records: [],
  leases: [],
  deletedIds: [],
  invalidatedAdapters: [],
  deletions: [],
});
