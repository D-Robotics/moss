import path from 'node:path';
import { RsiError, RsiStore, rsiDigest } from './store.js';
import type { RsiScope } from './types.js';

/** Explicit UI consent option; hosts still authenticate and admit every project individually. */
export const RSI_DAILY_ALL_PROJECTS = 'all-admitted-projects';

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
}
export interface RsiDailyView extends RsiDailyState {
  revision: number;
  storageDirectory: string;
  metadataBytes: number;
}
const defaults = (): RsiDailyState => ({
  schemaVersion: 1,
  retentionDays: 30,
  quotaBytes: 1_073_741_824,
  projects: [],
  experiences: [],
  deletedRunDigests: [],
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
      metadataBytes: Buffer.byteLength(JSON.stringify(value)),
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
    }
  ): RsiDailyView {
    identifier(input.projectId);
    if (typeof input.enabled !== 'boolean') throw new RsiError('invalid_daily_configuration');
    this.store.update(scope, (state) => {
      assertRevision(state.revision, input.expectedRevision);
      const value = daily(state.daily);
      const retentionDays = input.retentionDays ?? value.retentionDays;
      const quotaBytes = input.quotaBytes ?? value.quotaBytes;
      positive(retentionDays, 3650);
      positive(quotaBytes, Number.MAX_SAFE_INTEGER);
      value.retentionDays = retentionDays;
      value.quotaBytes = quotaBytes;
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
  ): { recorded: boolean; reason?: 'disabled' | 'duplicate' | 'deleted' | 'expired' | 'quota' } {
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
      const cutoff = Date.now() - value.retentionDays * 86_400_000;
      if (input.completedAt < cutoff) return { recorded: false, reason: 'expired' as const };
      const experiences = value.experiences.filter((item) => item.completedAt >= cutoff);
      experiences.push(experience);
      if (
        experiences.length > 1000 ||
        Buffer.byteLength(JSON.stringify({ ...value, experiences })) > value.quotaBytes
      )
        return { recorded: false, reason: 'quota' as const };
      value.experiences = experiences;
      state.daily = value;
      return { recorded: true };
    });
  }
  deleteExperience(scope: RsiScope, id: string, input: { expectedRevision: number }): RsiDailyView {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new RsiError('invalid_daily_reference');
    this.store.update(scope, (state) => {
      assertRevision(state.revision, input.expectedRevision);
      const value = daily(state.daily);
      if (!value.experiences.some((item) => item.id === id))
        throw new RsiError('daily_experience_not_found', 404);
      if (value.deletedRunDigests.length >= 10000)
        throw new RsiError('daily_deletion_retention_limit', 409);
      value.experiences = value.experiences.filter((item) => item.id !== id);
      value.deletedRunDigests.push(id);
      state.daily = value;
    });
    return this.read(scope);
  }
}
