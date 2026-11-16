import fs from 'node:fs';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { backupKey, readSafetyLedger } from './safety-ledger.js';
import {
  RsiStore,
  RsiError,
  RSI_BASELINE,
  rsiDigest,
  rsiAdapterDigest,
  type RsiState,
} from './store.js';
import {
  assetDirectory,
  assetPath,
  byteDigest,
  diskUsage,
  workspacePaths,
  immutableBytes,
  restoreAuthenticatedBytes,
  verifiedBytes,
  recordCollections,
  type RsiDocumentIndex,
} from './asset-io.js';
import {
  defaultRsiAssets,
  type RsiAssetState,
  type RsiAssetRecord,
  type RsiAssetKind,
  type RsiWorkspaceLease,
} from './asset-types.js';
import { rsiTaskScopeDigest } from './external-training.js';
import type { RsiScope, RsiTaskScope, RsiAdapter, RsiPolicy } from './types.js';

const DAY = 86_400_000;
function assets(state: RsiState): RsiAssetState {
  return (state.assets ??= defaultRsiAssets());
}
function cas(state: RsiState, revision: number) {
  if (!Number.isSafeInteger(revision) || revision !== state.revision)
    throw new RsiError('asset_revision_conflict', 409);
}
function integer(value: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RsiError('invalid_asset_configuration');
}
function identifier(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value))
    throw new RsiError('invalid_asset_reference');
}
function recordFor(state: RsiState, taskScope: RsiTaskScope, id: string): RsiAssetRecord {
  const record = assets(state).records.find(
    (item) => item.id === id && item.taskScopeDigest === rsiTaskScopeDigest(taskScope)
  );
  if (!record || record.deletedAt || assets(state).deletedIds.includes(id))
    throw new RsiError('asset_not_found', 404);
  return record;
}
function protectedAdapters(state: RsiState): Set<string> {
  return new Set([
    ...[state.policy, ...Object.values(state.trainingPolicies ?? {})].flatMap((policy) =>
      [policy.activeDigest, policy.previousDigest].filter((value): value is string =>
        Boolean(value)
      )
    ),
    ...state.runs.filter((run) => run.outcome === 'running').map((run) => run.adapter.digest),
    ...(state.trainingSessions ?? [])
      .filter((session) => ['frozen', 'candidate-admitted', 'confirming'].includes(session.status))
      .flatMap((session) =>
        [session.baselineDigest, session.candidateDigest].filter((value): value is string =>
          Boolean(value)
        )
      ),
  ]);
}
function protectedRecords(state: RsiState): Set<string> {
  const protectedDigests = protectedAdapters(state);
  const sessions = new Set(
    assets(state)
      .leases.filter((lease) => ['running', 'revoked'].includes(lease.status))
      .map((lease) => lease.sessionId)
  );
  for (const candidate of state.candidates)
    if (protectedDigests.has(candidate.adapter.digest) && candidate.trainingSessionId)
      sessions.add(candidate.trainingSessionId);
  const ids = new Set(
    assets(state)
      .records.filter(
        (record) =>
          (record.adapterDigest && protectedDigests.has(record.adapterDigest)) ||
          (record.sessionId && sessions.has(record.sessionId))
      )
      .map((record) => record.id)
  );
  // Frozen replay sources are in flight before the host has written session artifacts.
  for (const session of state.trainingSessions ?? []) {
    if (
      !sessions.has(session.id) &&
      !['frozen', 'candidate-admitted', 'confirming'].includes(session.status)
    )
      continue;
    const cases = new Set(
      Object.values(session.cases)
        .flat()
        .map((item) => item.id)
    );
    for (const id of cases)
      if (assets(state).records.some((record) => record.id === id)) ids.add(id);
    for (const manifest of state.replay?.manifests ?? []) {
      if (
        rsiTaskScopeDigest(manifest.taskScope) === rsiTaskScopeDigest(session.taskScope) &&
        Object.values(manifest.cases)
          .flat()
          .every((item) => cases.has(item.id))
      )
        ids.add(manifest.id);
    }
  }
  for (;;) {
    const before = ids.size;
    for (const record of assets(state).records)
      if (ids.has(record.id)) for (const dependency of record.dependencies) ids.add(dependency);
    if (ids.size === before) return ids;
  }
}
export interface RsiAssetStatus {
  revision: number;
  schemaVersion: number;
  storageDirectory: string;
  bytes: number;
  reservedBytes: number;
  quotaBytes: number;
  quotaExceeded: boolean;
  evidenceRetentionDays: number;
  summaryRetentionDays: number;
  failedWorkspaceRetentionDays: number;
  records: RsiAssetRecord[];
  leases: RsiWorkspaceLease[];
  pendingDeletions: Array<{
    id: string;
    taskScopeDigest: string;
    taskScope?: RsiTaskScope;
    assetIds: string[];
    requiredStopSessions: string[];
    createdAt: number;
  }>;
}
export interface RsiAssetBackup {
  schemaVersion: 1;
  ownerDigest: string;
  state: RsiState;
  payloads: Record<string, string>;
  digest: string;
  signature: string;
}

/** Local authority only. Identity and task scope are supplied by an authenticated host. */
export class RsiAssetStore {
  private readonly store: RsiStore;
  constructor(readonly rootDir: string) {
    this.store = new RsiStore(rootDir);
  }
  status(scope: RsiScope, taskScope?: RsiTaskScope): RsiAssetStatus {
    const state = this.store.read(scope),
      value = assets(state),
      directory = assetDirectory(this.rootDir, scope);
    const bytes = diskUsage(directory, workspacePaths(directory, state));
    const reservedBytes = value.leases
      .filter((lease) => ['running', 'revoked'].includes(lease.status))
      .reduce(
        (sum, lease) =>
          sum +
          Math.max(
            0,
            lease.maxBytes -
              diskUsage(
                assetPath(directory, 'training', lease.id),
                workspacePaths(directory, state)
              )
          ),
        0
      );
    const digest = taskScope ? rsiTaskScopeDigest(taskScope) : undefined;
    return structuredClone({
      revision: state.revision,
      schemaVersion: state.schemaVersion,
      storageDirectory: directory,
      bytes,
      reservedBytes,
      quotaBytes: value.quotaBytes,
      quotaExceeded: bytes + reservedBytes >= value.quotaBytes,
      evidenceRetentionDays: value.evidenceRetentionDays,
      summaryRetentionDays: value.summaryRetentionDays,
      failedWorkspaceRetentionDays: value.failedWorkspaceRetentionDays,
      records: value.records.filter(
        (item) => !item.deletedAt && (!digest || item.taskScopeDigest === digest)
      ),
      leases: value.leases.filter((item) => !digest || item.taskScopeDigest === digest),
      pendingDeletions: value.deletions
        .filter((item) => !item.completedAt && (!digest || item.taskScopeDigest === digest))
        .map((item) => ({
          id: item.id,
          taskScopeDigest: item.taskScopeDigest,
          taskScope: value.records.find((record) => item.assetIds.includes(record.id))?.taskScope,
          assetIds: item.assetIds,
          requiredStopSessions: item.sessionIds,
          createdAt: item.at,
        })),
    });
  }
  migrate(scope: RsiScope): RsiAssetStatus {
    if (this.store.read(scope).schemaVersion === 2)
      this.store.update(scope, (state) => {
        assets(state);
      });
    return this.status(scope);
  }
  configure(
    scope: RsiScope,
    input: {
      expectedRevision: number;
      quotaBytes?: number;
      evidenceRetentionDays?: number;
      summaryRetentionDays?: number;
      failedWorkspaceRetentionDays?: number;
    }
  ): RsiAssetStatus {
    this.store.update(scope, (state) => {
      cas(state, input.expectedRevision);
      const value = assets(state);
      for (const key of [
        'quotaBytes',
        'evidenceRetentionDays',
        'summaryRetentionDays',
        'failedWorkspaceRetentionDays',
      ] as const) {
        const next = input[key];
        if (next === undefined) continue;
        integer(next, key === 'quotaBytes' ? Number.MAX_SAFE_INTEGER : 3650);
        value[key] = next;
      }
    });
    return this.status(scope);
  }
  put(scope: RsiScope, taskScope: RsiTaskScope, input: RsiAssetInput): RsiAssetRecord {
    return this.store.update(scope, (state) => putRsiAsset(this.rootDir, state, taskScope, input));
  }
  read(scope: RsiScope, taskScope: RsiTaskScope, id: string): string {
    const record = recordFor(this.store.read(scope), taskScope, id);
    return verifiedBytes(
      assetPath(assetDirectory(this.rootDir, scope), 'assets', `${id}.bin`),
      record.contentDigest ?? id
    ).toString('utf8');
  }
  list(scope: RsiScope, taskScope: RsiTaskScope): RsiAssetRecord[] {
    return this.status(scope, taskScope).records;
  }
  exportAdapter(
    scope: RsiScope,
    taskScope: RsiTaskScope,
    digest: string
  ): {
    schemaVersion: 1;
    adapter: RsiAdapter;
    taskScope: RsiTaskScope;
    evaluation: { id: string; status: string } | null;
  } {
    const state = this.store.read(scope);
    const candidate = state.candidates.find(
      (item) =>
        item.adapter.digest === digest &&
        item.taskScope &&
        rsiTaskScopeDigest(item.taskScope) === rsiTaskScopeDigest(taskScope)
    );
    if (!candidate || assets(state).invalidatedAdapters.includes(digest))
      throw new RsiError('adapter_not_found', 404);
    if (rsiAdapterDigest(candidate.adapter) !== digest)
      throw new RsiError('adapter_integrity_failed', 409);
    const evaluation = state.trainingConfirmations?.find(
      (item) => item.id === candidate.validation?.evaluationId
    );
    return structuredClone({
      schemaVersion: 1,
      adapter: candidate.adapter,
      taskScope,
      evaluation: evaluation ? { id: evaluation.id, status: evaluation.status } : null,
    });
  }
  reserveWorkspace(
    scope: RsiScope,
    taskScope: RsiTaskScope,
    input: {
      sessionId: string;
      maxBytes: number;
      kind: 'training' | 'upload';
      expectedRevision: number;
    }
  ): RsiWorkspaceLease & { directory: string } {
    integer(input.maxBytes);
    identifier(input.sessionId);
    if (!['training', 'upload'].includes(input.kind))
      throw new RsiError('invalid_asset_configuration');
    const lease = this.store.update(scope, (state) => {
      cas(state, input.expectedRevision);
      const value = assets(state),
        digest = rsiTaskScopeDigest(taskScope);
      const session = state.trainingSessions?.find(
        (item) => item.id === input.sessionId && rsiTaskScopeDigest(item.taskScope) === digest
      );
      if (!session || session.status === 'cancelled')
        throw new RsiError('training_session_invalid', 409);
      if (
        value.leases.some(
          (item) =>
            item.sessionId === input.sessionId && ['running', 'revoked'].includes(item.status)
        )
      )
        throw new RsiError('workspace_already_reserved', 409);
      const usage = this.status(scope);
      if (usage.bytes + usage.reservedBytes + input.maxBytes + 4096 > value.quotaBytes)
        throw new RsiError('asset_quota_exceeded', 409);
      if (value.leases.length >= 1000) throw new RsiError('workspace_lease_limit', 409);
      const item: RsiWorkspaceLease = {
        id: randomUUID(),
        sessionId: input.sessionId,
        taskScopeDigest: digest,
        kind: input.kind,
        maxBytes: input.maxBytes,
        createdAt: Date.now(),
        status: 'running',
      };
      fs.mkdirSync(assetPath(assetDirectory(this.rootDir, scope), 'training', item.id), {
        recursive: true,
        mode: 0o700,
      });
      value.leases.push(item);
      return item;
    });
    return {
      ...lease,
      directory: assetPath(assetDirectory(this.rootDir, scope), 'training', lease.id),
    };
  }
  /** Call before each provider/actor operation; filesystem writers must respect their reserved cap. */
  checkWorkspace(scope: RsiScope, taskScope: RsiTaskScope, id: string): void {
    const state = this.store.read(scope),
      value = assets(state);
    const lease = value.leases.find(
      (item) => item.id === id && item.taskScopeDigest === rsiTaskScopeDigest(taskScope)
    );
    if (!lease || lease.status !== 'running') throw new RsiError('workspace_lease_revoked', 409);
    if (
      diskUsage(
        assetPath(assetDirectory(this.rootDir, scope), 'training', lease.id),
        workspacePaths(assetDirectory(this.rootDir, scope), state)
      ) > lease.maxBytes ||
      this.status(scope).quotaExceeded
    )
      throw new RsiError('asset_quota_exceeded', 409);
  }
  /** Trusted host acknowledgement: invoke only after its worker/process group has stopped. */
  finishWorkspace(
    scope: RsiScope,
    taskScope: RsiTaskScope,
    id: string,
    outcome: 'completed' | 'failed' | 'cancelled'
  ): RsiAssetStatus {
    if (!['completed', 'failed', 'cancelled'].includes(outcome))
      throw new RsiError('invalid_asset_configuration');
    this.store.update(scope, (state) => {
      const lease = assets(state).leases.find(
        (item) => item.id === id && item.taskScopeDigest === rsiTaskScopeDigest(taskScope)
      );
      if (!lease) throw new RsiError('workspace_not_found', 404);
      lease.status = lease.status === 'revoked' ? 'cancelled' : outcome;
      lease.endedAt = Date.now();
    });
    return this.status(scope, taskScope);
  }
  beginDeletion(
    scope: RsiScope,
    taskScope: RsiTaskScope,
    input: { assetIds: string[]; expectedRevision: number }
  ): { id: string; assetIds: string[]; requiredStopSessions: string[] } {
    return this.store.update(
      scope,
      (state) => beginRsiAssetDeletion(state, taskScope, input),
      true
    );
  }
  completeDeletion(scope: RsiScope, taskScope: RsiTaskScope, id: string): RsiAssetStatus {
    this.store.update(scope, (state) => {
      const value = assets(state),
        deletion = value.deletions.find(
          (item) => item.id === id && item.taskScopeDigest === rsiTaskScopeDigest(taskScope)
        );
      if (!deletion) throw new RsiError('deletion_not_found', 404);
      if (
        value.leases.some(
          (lease) =>
            deletion.sessionIds.includes(lease.sessionId) &&
            ['running', 'revoked'].includes(lease.status)
        )
      )
        throw new RsiError('deletion_jobs_still_running', 409);
      if (
        state.runs.some(
          (run) =>
            run.outcome === 'running' && value.invalidatedAdapters.includes(run.adapter.digest)
        )
      )
        throw new RsiError('deletion_runs_still_running', 409);
      const directory = assetDirectory(this.rootDir, scope);
      for (const assetId of deletion.assetIds)
        fs.rmSync(assetPath(directory, 'assets', `${assetId}.bin`), { force: true });
      for (const lease of value.leases)
        if (deletion.sessionIds.includes(lease.sessionId))
          fs.rmSync(assetPath(directory, 'training', lease.id), { recursive: true, force: true });
      // beginDeletion already committed removal of source records. Clear superseded
      // immutable versions and local migration backups, which may contain deleted text.
      this.collectUnreferencedDocuments(directory, 0);
      fs.rmSync(assetPath(directory, 'backups'), { recursive: true, force: true });
      deletion.completedAt = Date.now();
    });
    return this.status(scope, taskScope);
  }
  prune(scope: RsiScope): RsiAssetStatus {
    this.store.update(scope, (state) => {
      const value = assets(state),
        protectedIds = protectedRecords(state),
        directory = assetDirectory(this.rootDir, scope),
        now = Date.now();
      const protectedDigests = protectedAdapters(state);
      const keepCases = new Set(
        state.candidates
          .filter((candidate) => protectedDigests.has(candidate.adapter.digest))
          .flatMap((candidate) => candidate.caseIds)
      );
      const keepSessions = new Set(
        state.candidates
          .filter((candidate) => protectedDigests.has(candidate.adapter.digest))
          .flatMap((candidate) =>
            candidate.trainingSessionId ? [candidate.trainingSessionId] : []
          )
      );
      for (const session of state.trainingSessions ?? [])
        if (['frozen', 'candidate-admitted', 'confirming'].includes(session.status)) {
          keepSessions.add(session.id);
          for (const item of Object.values(session.cases).flat()) keepCases.add(item.id);
        }
      for (const lease of value.leases)
        if (['running', 'revoked'].includes(lease.status)) keepSessions.add(lease.sessionId);
      state.runs = state.runs.filter(
        (run) =>
          run.outcome === 'running' || run.startedAt >= now - value.evidenceRetentionDays * DAY
      );
      state.cases = state.cases.filter(
        (item) =>
          keepCases.has(item.id) || item.createdAt >= now - value.evidenceRetentionDays * DAY
      );
      const expiredCandidates = state.candidates.filter(
        (candidate) =>
          !protectedDigests.has(candidate.adapter.digest) &&
          candidate.createdAt < now - value.summaryRetentionDays * DAY
      );
      value.invalidatedAdapters = [
        ...new Set([
          ...value.invalidatedAdapters,
          ...expiredCandidates.map((candidate) => candidate.adapter.digest),
        ]),
      ];
      state.candidates = state.candidates.filter(
        (candidate) => !value.invalidatedAdapters.includes(candidate.adapter.digest)
      );
      state.evaluations = state.evaluations.filter(
        (item) =>
          protectedDigests.has(item.candidateDigest) ||
          item.createdAt >= now - value.summaryRetentionDays * DAY
      );
      state.trainingSessions = (state.trainingSessions ?? []).filter(
        (session) =>
          keepSessions.has(session.id) ||
          session.createdAt >= now - value.summaryRetentionDays * DAY
      );
      state.trainingConfirmations = (state.trainingConfirmations ?? []).filter(
        (confirmation) =>
          keepSessions.has(confirmation.sessionId) ||
          confirmation.createdAt >= now - value.summaryRetentionDays * DAY
      );
      for (const record of value.records) {
        const days = ['experience', 'case'].includes(record.kind)
          ? value.evidenceRetentionDays
          : value.summaryRetentionDays;
        if (
          !record.deletedAt &&
          !protectedIds.has(record.id) &&
          record.createdAt < now - days * DAY
        ) {
          record.deletedAt = now;
          value.deletedIds.push(record.id);
        }
      }
      if (value.deletedIds.length > 10000) throw new RsiError('asset_deletion_ledger_limit', 409);
      for (const lease of value.leases)
        if (
          ['failed', 'cancelled'].includes(lease.status) &&
          lease.endedAt &&
          lease.endedAt < now - value.failedWorkspaceRetentionDays * DAY
        )
          fs.rmSync(assetPath(directory, 'training', lease.id), { recursive: true, force: true });
      // Superseded immutable record versions expire; current references and backups stay intact.
      this.collectUnreferencedDocuments(directory, now - value.summaryRetentionDays * DAY);
    });
    // Expiration markers commit before physical collection; interruption is safe to retry.
    this.store.update(scope, (state) => {
      const directory = assetDirectory(this.rootDir, scope);
      for (const record of assets(state).records)
        if (record.deletedAt)
          fs.rmSync(assetPath(directory, 'assets', `${record.id}.bin`), { force: true });
      this.collectUnreferencedDocuments(
        directory,
        Date.now() - assets(state).summaryRetentionDays * DAY
      );
    });
    return this.status(scope);
  }
  private collectUnreferencedDocuments(directory: string, cutoff: number) {
    const indexFile = assetPath(directory, 'state.json');
    if (fs.existsSync(indexFile)) {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as {
        documents?: RsiDocumentIndex;
      };
      for (const key of recordCollections) {
        const dir = assetPath(directory, 'documents', key);
        if (!fs.existsSync(dir)) continue;
        const keep = new Set(index.documents?.[key] ?? []);
        for (const name of fs.readdirSync(dir))
          if (/^[a-f0-9]{64}\.json$/.test(name) && !keep.has(name.slice(0, -5))) {
            const file = assetPath(directory, 'documents', key, name);
            if (cutoff === 0 || fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file);
          }
      }
    }
  }
  backup(scope: RsiScope): RsiAssetBackup {
    return this.store.update(scope, (state) => {
      const value = assets(state),
        payloads: Record<string, string> = {};
      if (value.leases.some((lease) => ['running', 'revoked'].includes(lease.status)))
        throw new RsiError('backup_jobs_still_running', 409);
      if (state.runs.some((run) => run.outcome === 'running'))
        throw new RsiError('backup_runs_still_running', 409);
      for (const record of value.records)
        if (!record.deletedAt)
          payloads[record.id] = verifiedBytes(
            assetPath(assetDirectory(this.rootDir, scope), 'assets', `${record.id}.bin`),
            record.contentDigest ?? record.id
          ).toString('base64');
      const body = {
        schemaVersion: 1 as const,
        ownerDigest: rsiDigest(JSON.stringify(scope)),
        state: structuredClone(state),
        payloads,
      };
      const digest = rsiDigest(JSON.stringify(body));
      const key = backupKey(assetDirectory(this.rootDir, scope), true);
      return { ...body, digest, signature: createHmac('sha256', key).update(digest).digest('hex') };
    });
  }
  restore(
    scope: RsiScope,
    backup: RsiAssetBackup,
    input: { expectedRevision: number }
  ): RsiAssetStatus {
    const { digest, signature, ...body } = backup;
    const keyFile = assetPath(assetDirectory(this.rootDir, scope), 'backup-auth.key');
    if (!fs.existsSync(keyFile) || !/^[a-f0-9]{64}$/.test(signature ?? ''))
      throw new RsiError('backup_integrity_or_owner_mismatch', 409);
    const key = fs.readFileSync(keyFile);
    if (
      key.length !== 32 ||
      !timingSafeEqual(
        Buffer.from(signature, 'hex'),
        createHmac('sha256', key).update(digest).digest()
      )
    )
      throw new RsiError('backup_integrity_or_owner_mismatch', 409);
    if (
      body.schemaVersion !== 1 ||
      body.ownerDigest !== rsiDigest(JSON.stringify(scope)) ||
      body.state.scope.ownerKey !== scope.ownerKey ||
      body.state.scope.environment !== scope.environment ||
      digest !== rsiDigest(JSON.stringify(body))
    )
      throw new RsiError('backup_integrity_or_owner_mismatch', 409);
    let recovering = false;
    try {
      this.store.read(scope);
    } catch {
      recovering = true;
    }
    const mutate = (state: RsiState) => {
      cas(state, input.expectedRevision);
      const current = assets(state),
        restored = structuredClone(body.state),
        value = assets(restored);
      if (current.leases.some((lease) => ['running', 'revoked'].includes(lease.status)))
        throw new RsiError('restore_jobs_still_running', 409);
      if (state.runs.some((run) => run.outcome === 'running'))
        throw new RsiError('restore_runs_still_running', 409);
      for (const run of restored.runs)
        if (run.outcome === 'running') {
          run.outcome = 'interrupted';
          run.endedAt = Date.now();
        }
      const merge = <T>(left: T[], right: T[], key: (item: T) => string) => [
        ...new Map([...left, ...right].map((item) => [key(item), item])).values(),
      ];
      restored.holdoutConsumptions = merge(
        restored.holdoutConsumptions,
        state.holdoutConsumptions,
        (item) => item.digest
      );
      restored.caseExposures = merge(
        restored.caseExposures,
        state.caseExposures,
        (item) => item.digest
      );
      restored.protocolProposals = [
        ...new Set([...(restored.protocolProposals ?? []), ...(state.protocolProposals ?? [])]),
      ];
      restored.trainingReservations = merge(
        restored.trainingReservations ?? [],
        state.trainingReservations ?? [],
        (item) => item.id
      );
      value.deletedIds = [...new Set([...value.deletedIds, ...current.deletedIds])];
      value.invalidatedAdapters = [
        ...new Set([...value.invalidatedAdapters, ...current.invalidatedAdapters]),
      ];
      value.deletions = merge(value.deletions, current.deletions, (item) => item.id);
      if (state.daily) {
        restored.daily ??= structuredClone(state.daily);
        restored.daily.deletedRunDigests = [
          ...new Set([...restored.daily.deletedRunDigests, ...state.daily.deletedRunDigests]),
        ];
        restored.daily.experiences = restored.daily.experiences.filter(
          (item) => !restored.daily!.deletedRunDigests.includes(item.id)
        );
        restored.daily.projects = merge(
          restored.daily.projects,
          state.daily.projects,
          (item) => item.projectId
        );
        restored.daily.collectionStatus = structuredClone(state.daily.collectionStatus);
      }
      for (const record of value.records)
        if (value.deletedIds.includes(record.id)) record.deletedAt ??= Date.now();
      restored.candidates = restored.candidates.filter(
        (item) => !value.invalidatedAdapters.includes(item.adapter.digest)
      );
      const cancelledSessions = new Set(
        (state.trainingSessions ?? [])
          .filter((session) => session.status === 'cancelled')
          .map((session) => session.id)
      );
      for (const session of restored.trainingSessions ?? [])
        if (
          session.status !== 'confirmed' ||
          cancelledSessions.has(session.id) ||
          (session.candidateDigest && value.invalidatedAdapters.includes(session.candidateDigest))
        )
          session.status = 'cancelled';
      for (const lease of value.leases)
        if (['running', 'revoked'].includes(lease.status)) {
          lease.status = 'cancelled';
          lease.endedAt = Date.now();
        }
      const policies = [restored.policy, ...Object.values(restored.trainingPolicies ?? {})];
      for (const policy of policies) {
        policy.version =
          Math.max(
            policy.version,
            state.policy.version,
            ...Object.values(state.trainingPolicies ?? {}).map((item) => item.version)
          ) + 1;
        if (value.invalidatedAdapters.includes(policy.activeDigest))
          policy.activeDigest = RSI_BASELINE.digest;
        if (policy.previousDigest && value.invalidatedAdapters.includes(policy.previousDigest))
          policy.previousDigest = null;
        if (recovering) {
          policy.activeDigest = RSI_BASELINE.digest;
          policy.previousDigest = null;
        }
      }
      const directory = assetDirectory(this.rootDir, scope);
      let pending = 0;
      const files: Array<{ file: string; bytes: Buffer }> = [];
      for (const record of value.records)
        if (!record.deletedAt) {
          const bytes = Buffer.from(body.payloads[record.id] ?? '', 'base64');
          if (
            byteDigest(bytes) !== (record.contentDigest ?? record.id) ||
            bytes.length !== record.bytes
          )
            throw new RsiError('backup_asset_invalid', 409);
          const file = assetPath(directory, 'assets', `${record.id}.bin`);
          if (!fs.existsSync(file)) pending += bytes.length;
          files.push({ file, bytes });
        }
      if (
        diskUsage(directory, workspacePaths(directory, state)) +
          pending +
          Buffer.byteLength(JSON.stringify(restored)) >
        value.quotaBytes
      )
        throw new RsiError('asset_quota_exceeded', 409);
      for (const file of files) restoreAuthenticatedBytes(file.file, file.bytes);
      const revision = state.revision;
      Object.assign(state, restored, { revision });
      // Restoring payloads is not renewed permission to collect or train on content.
      if (state.replay)
        for (const profile of state.replay.profiles) {
          profile.enabled = false;
          profile.contentConsent = false;
        }
    };
    if (recovering) this.store.recover(scope, body.state, mutate);
    else this.store.update(scope, mutate);
    return this.status(scope);
  }
  /** Read-only recovery hint: never manufactures a missing consumption history. */
  recoveryStatus(scope: RsiScope): { revision: number; liveReferences: boolean } {
    const ledger = readSafetyLedger(assetDirectory(this.rootDir, scope), scope, true)!;
    return { revision: ledger.revision, liveReferences: ledger.liveReferences };
  }
}

export type RsiAssetInput = {
  kind: RsiAssetKind;
  content: string;
  dependencies?: string[];
  adapterDigest?: string;
  sessionId?: string;
  sourceId?: string;
  expectedRevision: number;
};

/** Internal composition: caller owns the SDK transaction lock. */
export function putRsiAsset(
  rootDir: string,
  state: RsiState,
  taskScope: RsiTaskScope,
  input: RsiAssetInput
): RsiAssetRecord {
  const scope = state.scope;
  const taskScopeDigest = rsiTaskScopeDigest(taskScope);
  if (
    !['experience', 'case', 'adapter', 'evaluation', 'manifest'].includes(input.kind) ||
    typeof input.content !== 'string'
  )
    throw new RsiError('invalid_asset');
  const bytes = Buffer.from(input.content);
  if (bytes.length > (input.kind === 'adapter' ? 8192 : 16 * 1024 * 1024))
    throw new RsiError('asset_too_large');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[^\s"']{8,}/i.test(
      input.content
    )
  )
    throw new RsiError('asset_contains_credentials');
  if (
    input.dependencies !== undefined &&
    (!Array.isArray(input.dependencies) || input.dependencies.length > 1000)
  )
    throw new RsiError('asset_dependency_limit');
  const dependencies = [...new Set(input.dependencies ?? [])].sort();
  const binding = (value: {
    kind: RsiAssetKind;
    sessionId?: string;
    sourceId?: string;
    adapterDigest?: string;
    dependencies?: string[];
  }) =>
    JSON.stringify([
      value.kind,
      value.sessionId ?? null,
      value.sourceId ?? null,
      value.adapterDigest ?? null,
      [...new Set(value.dependencies ?? [])].sort(),
    ]);
  const frozenBinding = binding({ ...input, dependencies });
  const contentDigest = byteDigest(bytes);
  const id = rsiDigest(JSON.stringify([taskScopeDigest, contentDigest, frozenBinding]));
  cas(state, input.expectedRevision);
  const value = assets(state);
  if (value.deletedIds.includes(id) || value.deletedIds.includes(contentDigest))
    throw new RsiError('asset_deleted', 409);
  const existing = value.records.find(
    (item) =>
      item.id === id ||
      (item.taskScopeDigest === taskScopeDigest &&
        (item.contentDigest ?? item.id) === contentDigest &&
        binding(item) === frozenBinding)
  );
  if (existing) {
    recordFor(state, taskScope, existing.id);
    verifiedBytes(
      assetPath(assetDirectory(rootDir, scope), 'assets', `${existing.id}.bin`),
      existing.contentDigest ?? existing.id
    );
    return existing;
  }
  if (value.records.length >= 10000) throw new RsiError('asset_index_limit', 409);
  if (input.adapterDigest && !/^[a-f0-9]{64}$/.test(input.adapterDigest))
    throw new RsiError('invalid_asset_reference');
  if (input.sourceId) identifier(input.sourceId);
  if (input.sessionId) {
    const session = state.trainingSessions?.find(
      (item) =>
        item.id === input.sessionId && rsiTaskScopeDigest(item.taskScope) === taskScopeDigest
    );
    if (!session || session.status === 'cancelled')
      throw new RsiError('training_session_invalid', 409);
  }
  for (const dependency of dependencies) recordFor(state, taskScope, dependency);
  const usage = new RsiAssetStore(rootDir).status(scope);
  if (usage.bytes + usage.reservedBytes + bytes.length + 4096 > value.quotaBytes)
    throw new RsiError('asset_quota_exceeded', 409);
  const record: RsiAssetRecord = {
    id,
    contentDigest,
    kind: input.kind,
    taskScopeDigest,
    taskScope: structuredClone(taskScope),
    bytes: bytes.length,
    createdAt: Date.now(),
    dependencies,
    ...(input.adapterDigest ? { adapterDigest: input.adapterDigest } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
  };
  immutableBytes(assetPath(assetDirectory(rootDir, scope), 'assets', `${id}.bin`), bytes);
  value.records.push(record);
  return record;
}

/** Internal composition: revocation and source tombstones share one transaction. */
export function beginRsiAssetDeletion(
  state: RsiState,
  taskScope: RsiTaskScope,
  input: { assetIds: string[]; expectedRevision: number }
): { id: string; assetIds: string[]; requiredStopSessions: string[] } {
  cas(state, input.expectedRevision);
  const value = assets(state),
    taskScopeDigest = rsiTaskScopeDigest(taskScope);
  if (!Array.isArray(input.assetIds) || !input.assetIds.length || input.assetIds.length > 1000)
    throw new RsiError('invalid_asset_reference');
  const ids = new Set(input.assetIds);
  for (const id of ids) recordFor(state, taskScope, id);
  for (;;) {
    const before = ids.size;
    for (const record of value.records)
      if (!record.deletedAt && record.dependencies.some((id) => ids.has(id))) ids.add(record.id);
    if (ids.size === before) break;
  }
  const records = value.records.filter((item) => ids.has(item.id));
  if (records.some((item) => item.taskScopeDigest !== taskScopeDigest))
    throw new RsiError('asset_scope_mismatch', 409);
  const sourceIds = new Set(
    records.flatMap((item) => [item.id, ...(item.sourceId ? [item.sourceId] : [])])
  );
  const sessionIds = new Set(records.flatMap((item) => (item.sessionId ? [item.sessionId] : [])));
  const revoked = new Set(
    records.flatMap((item) => (item.adapterDigest ? [item.adapterDigest] : []))
  );
  for (;;) {
    const before = revoked.size + sessionIds.size;
    for (const session of state.trainingSessions ?? [])
      if (
        rsiTaskScopeDigest(session.taskScope) === taskScopeDigest &&
        (Object.values(session.cases)
          .flat()
          .some((item) => sourceIds.has(item.id)) ||
          (session.candidateDigest && revoked.has(session.candidateDigest)))
      )
        sessionIds.add(session.id);
    for (const candidate of state.candidates)
      if (
        candidate.taskScope &&
        rsiTaskScopeDigest(candidate.taskScope) === taskScopeDigest &&
        (candidate.caseIds.some((id) => sourceIds.has(id)) ||
          revoked.has(candidate.baseDigest) ||
          (candidate.trainingSessionId && sessionIds.has(candidate.trainingSessionId)))
      )
        revoked.add(candidate.adapter.digest);
    if (before === revoked.size + sessionIds.size) break;
  }
  // Policy and revocations commit together, before physical deletion can begin.
  const reset = (policy: RsiPolicy, scopeDigest?: string) => {
    if (
      !revoked.has(policy.activeDigest) &&
      !(policy.previousDigest && revoked.has(policy.previousDigest))
    )
      return;
    const from = policy.activeDigest;
    policy.version += 1;
    policy.activeDigest = RSI_BASELINE.digest;
    policy.previousDigest = null;
    policy.updatedAt = Date.now();
    state.transitions.push({
      at: Date.now(),
      kind: 'rollback',
      fromDigest: from,
      toDigest: RSI_BASELINE.digest,
      policyVersion: policy.version,
      ...(scopeDigest ? { taskScopeDigest: scopeDigest } : {}),
    });
  };
  reset(state.policy);
  for (const [digest, policy] of Object.entries(state.trainingPolicies ?? {}))
    reset(policy, digest);
  for (const session of state.trainingSessions ?? [])
    if (sessionIds.has(session.id)) session.status = 'cancelled';
  for (const lease of value.leases)
    if (sessionIds.has(lease.sessionId) && lease.status === 'running') lease.status = 'revoked';
  for (const record of value.records) if (ids.has(record.id)) record.deletedAt = Date.now();
  value.deletedIds = [...new Set([...value.deletedIds, ...ids])];
  value.invalidatedAdapters = [...new Set([...value.invalidatedAdapters, ...revoked])];
  if (
    value.deletedIds.length > 10000 ||
    value.invalidatedAdapters.length > 10000 ||
    value.deletions.length >= 1000
  )
    throw new RsiError('asset_deletion_ledger_limit', 409);
  state.candidates = state.candidates.filter((candidate) => !revoked.has(candidate.adapter.digest));
  state.cases = state.cases.filter((item) => !sourceIds.has(item.id));
  state.evaluations = state.evaluations.filter((item) => !revoked.has(item.candidateDigest));
  for (const confirmation of state.trainingConfirmations ?? [])
    if (sessionIds.has(confirmation.sessionId)) {
      confirmation.status = 'unavailable';
      confirmation.results = [];
      confirmation.errorCode = 'asset_deleted';
    }
  const deletion = {
    id: randomUUID(),
    taskScopeDigest,
    assetIds: [...ids],
    sessionIds: [...sessionIds],
    at: Date.now(),
  };
  value.deletions.push(deletion);
  return {
    id: deletion.id,
    assetIds: deletion.assetIds,
    requiredStopSessions: deletion.sessionIds,
  };
}
