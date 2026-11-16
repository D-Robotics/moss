import path from 'node:path';
import { RsiError, RsiStore, rsiDigest } from './store.js';
import type { RsiScope } from './types.js';

/** Explicit UI consent option; hosts still authenticate and admit every project individually. */
export const RSI_DAILY_ALL_PROJECTS = 'all-admitted-projects';
const MAX_EXPERIENCES = 1000;

export type RsiDailyCollectionStatus =
  | { state: 'ready'; updatedAt: number }
  | { state: 'paused'; reason: 'quota' | 'error'; updatedAt: number };

/** References only: prompts, code, tool output and credentials stay in the host's owned run store. */
export interface RsiDailyExperience {
  id: string;
  runId: string;
  projectId: string;
  completedAt: number;
  outcome: 'completed' | 'failed' | 'cancelled' | 'partial';
  adapterDigest?: string;
  taskScopeDigest?: string;
  evidenceDigest?: string;
  eligibility: 'needs_judge';
}
export interface RsiDailyState {
  schemaVersion: 1;
  retentionDays: number;
  quotaBytes: number;
  projects: Array<{ projectId: string; enabled: boolean }>;
  experiences: RsiDailyExperience[];
  /** Minimal tombstones prevent a late completion event from recreating deleted experience. */
  deletedRunDigests: string[];
  collectionStatus: RsiDailyCollectionStatus;
}
export interface RsiDailyView extends RsiDailyState {
  revision: number;
  storageDirectory: string;
  metadataBytes: number;
  indexQuota: {
    bytes: number;
    limitBytes: number;
    experienceCount: number;
    limitExperiences: number;
    exceeded: boolean;
  };
}
/** Portable reference metadata only; excludes local paths, credentials and source task content. */
export interface RsiDailyMetadataExport {
  schemaVersion: 1;
  revision: number;
  retentionDays: number;
  quotaBytes: number;
  projects: RsiDailyState['projects'];
  experiences: RsiDailyExperience[];
  collectionStatus: RsiDailyCollectionStatus;
}
const defaults = (): RsiDailyState => ({
  schemaVersion: 1,
  retentionDays: 30,
  quotaBytes: 1_073_741_824,
  projects: [],
  experiences: [],
  deletedRunDigests: [],
  collectionStatus: { state: 'ready', updatedAt: 0 },
});
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value))
    throw new RsiError('invalid_daily_reference');
}
function positive(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RsiError('invalid_daily_configuration');
}
function daily(value: RsiDailyState | undefined): RsiDailyState {
  if (value === undefined) return defaults();
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.experiences) ||
    !Array.isArray(value.deletedRunDigests)
  )
    throw new RsiError('rsi_daily_store_unavailable', 503);
  positive(value.retentionDays, 3650);
  positive(value.quotaBytes, Number.MAX_SAFE_INTEGER);
  // Existing schema-1 indexes predate collection status; normalize without enabling collection.
  value.collectionStatus ??= { state: 'ready', updatedAt: 0 };
  const status = value.collectionStatus;
  if (
    !Number.isSafeInteger(status.updatedAt) ||
    status.updatedAt < 0 ||
    (status.state !== 'ready' && status.state !== 'paused') ||
    (status.state === 'paused' && status.reason !== 'quota' && status.reason !== 'error')
  )
    throw new RsiError('rsi_daily_store_unavailable', 503);
  value.collectionStatus =
    status.state === 'ready'
      ? { state: 'ready', updatedAt: status.updatedAt }
      : { state: 'paused', reason: status.reason, updatedAt: status.updatedAt };
  return value;
}
function assertRevision(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || actual !== expected)
    throw new RsiError('rsi_daily_revision_conflict', 409);
}

/** Shares the SDK's owner/environment file, cross-process writer lock and atomic transaction. */
export class RsiDailyStore {
  private readonly store: RsiStore;
  constructor(readonly rootDir: string) {
    this.store = new RsiStore(rootDir);
  }
  read(scope: RsiScope): RsiDailyView {
    const state = this.store.read(scope);
    const value = daily(state.daily);
    const metadataBytes = Buffer.byteLength(JSON.stringify(value));
    return structuredClone({
      ...value,
      experiences: value.experiences.filter(
        (item) => item.completedAt >= Date.now() - value.retentionDays * 86_400_000
      ),
      revision: state.revision,
      storageDirectory: path.join(
        this.rootDir,
        rsiDigest(`${scope.ownerKey}\0${scope.environment}`)
      ),
      metadataBytes,
      indexQuota: {
        bytes: metadataBytes,
        limitBytes: value.quotaBytes,
        experienceCount: value.experiences.length,
        limitExperiences: MAX_EXPERIENCES,
        exceeded: metadataBytes > value.quotaBytes || value.experiences.length >= MAX_EXPERIENCES,
      },
    });
  }
  configure(
    scope: RsiScope,
    input: {
      expectedRevision: number;
      projectId: string;
      enabled: boolean;
      retentionDays?: number;
      quotaBytes?: number;
      resetCollectionStatus?: boolean;
    }
  ): RsiDailyView {
    identifier(input.projectId);
    if (typeof input.enabled !== 'boolean') throw new RsiError('invalid_daily_configuration');
    if (
      input.resetCollectionStatus !== undefined &&
      typeof input.resetCollectionStatus !== 'boolean'
    )
      throw new RsiError('invalid_daily_configuration');
    this.store.update(scope, (state) => {
      assertRevision(state.revision, input.expectedRevision);
      const value = daily(state.daily);
      const retentionDays = input.retentionDays ?? value.retentionDays;
      const quotaBytes = input.quotaBytes ?? value.quotaBytes;
      positive(retentionDays, 3650);
      positive(quotaBytes, Number.MAX_SAFE_INTEGER);
      value.retentionDays = retentionDays;
      value.quotaBytes = quotaBytes;
      if (input.resetCollectionStatus)
        value.collectionStatus = { state: 'ready', updatedAt: Date.now() };
      const project = value.projects.find((item) => item.projectId === input.projectId);
      if (project) project.enabled = input.enabled;
      else {
        if (value.projects.length >= 1000) throw new RsiError('daily_project_limit', 409);
        value.projects.push({ projectId: input.projectId, enabled: input.enabled });
      }
      value.experiences = value.experiences.filter(
        (item) => item.completedAt >= Date.now() - retentionDays * 86_400_000
      );
      state.daily = value;
    });
    return this.read(scope);
  }
  record(
    scope: RsiScope,
    input: Omit<RsiDailyExperience, 'id' | 'eligibility'>
  ): {
    recorded: boolean;
    reason?: 'disabled' | 'duplicate' | 'deleted' | 'expired' | 'quota' | 'paused';
  } {
    identifier(input.runId);
    identifier(input.projectId);
    if (
      !Number.isSafeInteger(input.completedAt) ||
      input.completedAt < 0 ||
      input.completedAt > Date.now() + 60_000 ||
      !['completed', 'failed', 'cancelled', 'partial'].includes(input.outcome)
    )
      throw new RsiError('invalid_daily_reference');
    for (const hash of [input.adapterDigest, input.taskScopeDigest, input.evidenceDigest])
      if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))
        throw new RsiError('invalid_daily_reference');
    // Construct the allowlisted shape; unknown host fields cannot persist raw content.
    const experience: RsiDailyExperience = {
      id: rsiDigest(JSON.stringify([input.projectId, input.runId])),
      runId: input.runId,
      projectId: input.projectId,
      completedAt: input.completedAt,
      outcome: input.outcome,
      adapterDigest: input.adapterDigest,
      taskScopeDigest: input.taskScopeDigest,
      evidenceDigest: input.evidenceDigest,
      eligibility: 'needs_judge',
    };
    return this.store.update(scope, (state) => {
      const value = daily(state.daily);
      const consent =
        value.projects.find((item) => item.projectId === input.projectId) ??
        value.projects.find((item) => item.projectId === RSI_DAILY_ALL_PROJECTS);
      if (!consent?.enabled) return { recorded: false, reason: 'disabled' as const };
      if (value.deletedRunDigests.includes(experience.id))
        return { recorded: false, reason: 'deleted' as const };
      if (value.experiences.some((item) => item.id === experience.id))
        return { recorded: false, reason: 'duplicate' as const };
      if (value.collectionStatus.state === 'paused')
        return { recorded: false, reason: 'paused' as const };
      const cutoff = Date.now() - value.retentionDays * 86_400_000;
      if (input.completedAt < cutoff) return { recorded: false, reason: 'expired' as const };
      const experiences = value.experiences.filter((item) => item.completedAt >= cutoff);
      experiences.push(experience);
      if (
        experiences.length > MAX_EXPERIENCES ||
        Buffer.byteLength(JSON.stringify({ ...value, experiences })) > value.quotaBytes
      ) {
        // Control metadata may exceed a tiny configured quota; never lose the pause reason.
        value.collectionStatus = { state: 'paused', reason: 'quota', updatedAt: Date.now() };
        state.daily = value;
        return { recorded: false, reason: 'quota' as const };
      }
      value.experiences = experiences;
      state.daily = value;
      return { recorded: true };
    });
  }
  /** Hosts can persist a generic collection failure; raw error messages are never accepted. */
  reportCollectionError(scope: RsiScope): RsiDailyView {
    this.store.update(scope, (state) => {
      const value = daily(state.daily);
      if (!value.projects.some((project) => project.enabled)) return;
      if (value.collectionStatus.state !== 'paused')
        value.collectionStatus = { state: 'paused', reason: 'error', updatedAt: Date.now() };
      state.daily = value;
    });
    return this.read(scope);
  }
  exportMetadata(scope: RsiScope): RsiDailyMetadataExport {
    const value = this.read(scope);
    return {
      schemaVersion: 1,
      revision: value.revision,
      retentionDays: value.retentionDays,
      quotaBytes: value.quotaBytes,
      projects: value.projects.map(({ projectId, enabled }) => ({ projectId, enabled })),
      experiences: value.experiences.map(
        ({
          id,
          runId,
          projectId,
          completedAt,
          outcome,
          adapterDigest,
          taskScopeDigest,
          evidenceDigest,
          eligibility,
        }) => ({
          id,
          runId,
          projectId,
          completedAt,
          outcome,
          adapterDigest,
          taskScopeDigest,
          evidenceDigest,
          eligibility,
        })
      ),
      collectionStatus: value.collectionStatus,
    };
  }
  /** Deletes references only; retains consent, pause state and bounded replay tombstones. */
  deleteMetadata(scope: RsiScope, input: { expectedRevision: number }): RsiDailyView {
    this.store.update(scope, (state) => {
      assertRevision(state.revision, input.expectedRevision);
      const value = daily(state.daily);
      if (
        state.replay?.captures.some(
          (capture) =>
            value.experiences.some(
              (item) => item.runId === capture.runId && item.projectId === capture.projectId
            ) && state.assets?.records.some((item) => item.id === capture.sourceAssetId)
        )
      )
        throw new RsiError('replay_source_requires_deletion', 409);
      const deleted = [
        ...new Set([...value.deletedRunDigests, ...value.experiences.map((item) => item.id)]),
      ];
      if (deleted.length > 10000) throw new RsiError('daily_deletion_retention_limit', 409);
      value.deletedRunDigests = deleted;
      value.experiences = [];
      state.daily = value;
    });
    return this.read(scope);
  }
  deleteExperience(scope: RsiScope, id: string, input: { expectedRevision: number }): RsiDailyView {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new RsiError('invalid_daily_reference');
    this.store.update(scope, (state) => {
      assertRevision(state.revision, input.expectedRevision);
      const value = daily(state.daily);
      if (!value.experiences.some((item) => item.id === id))
        throw new RsiError('daily_experience_not_found', 404);
      if (
        state.replay?.captures.some(
          (capture) =>
            rsiDigest(JSON.stringify([capture.projectId, capture.runId])) === id &&
            state.assets?.records.some((item) => item.id === capture.sourceAssetId)
        )
      )
        throw new RsiError('replay_source_requires_deletion', 409);
      if (value.deletedRunDigests.length >= 10000)
        throw new RsiError('daily_deletion_retention_limit', 409);
      value.experiences = value.experiences.filter((item) => item.id !== id);
      value.deletedRunDigests.push(id);
      state.daily = value;
    });
    return this.read(scope);
  }
}
