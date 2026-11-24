import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MossError } from '../../errors.js';
import { RsiError } from './error.js';
export { RsiError } from './error.js';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import { hashHarnessAdapter } from '../agent/harness-adapter.js';
import type { RsiDailyState } from './daily-store.js';
import type { RsiReplayState } from './replay-types.js';
import {
  assetPath,
  diskUsage,
  workspacePaths,
  documentPlan,
  hydrateDocuments,
  immutableBytes,
  restoreAuthenticatedBytes,
} from './asset-io.js';
import { defaultRsiAssets, type RsiAssetState } from './asset-types.js';
import { applySafetyLedger, readSafetyLedger, writeSafetyLedger } from './safety-ledger.js';
import type {
  RsiAdapter,
  RsiCandidate,
  RsiCase,
  RsiEvaluation,
  RsiPolicy,
  RsiPolicyTransition,
  RsiRun,
  RsiScope,
  RsiProtocol,
  RsiTrainingSession,
  RsiTrainingConfirmation,
  RsiTrainingReservation,
} from './types.js';

export const RSI_RETENTION = { days: 35, maxRuns: 200, maxEventsPerRun: 120 };
export const rsiDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const rsiAdapterDigest = (adapter: Pick<RsiAdapter, 'id' | 'version' | 'instructions'>) =>
  hashHarnessAdapter(adapter);
export const rsiCaseDigest = (item: RsiCase) =>
  rsiDigest(
    JSON.stringify([item.id, item.input, item.expectedOutcome, item.split, item.evidenceDigest])
  );
export const rsiProtocolDigest = (item: Omit<RsiProtocol, 'digest'>) =>
  rsiDigest(
    JSON.stringify([
      item.id,
      item.createdAt,
      item.baselineDigest,
      item.policyVersion,
      item.caseDigests.map((c) => [c.id, c.digest, c.split]),
      item.criterion.kind === 'correctness'
        ? ['correctness']
        : ['efficiency', item.criterion.metric, item.criterion.minimumAbsoluteGain],
      [item.budget.maxModelCalls, item.budget.maxOutputTokens],
      [item.perArmBudget.maxModelCalls, item.perArmBudget.maxOutputTokens],
      [
        item.validationIdentity.model,
        item.validationIdentity.evaluatorVersion,
        item.validationIdentity.providerIdentityDigest,
      ],
      [
        item.runtimeConfig.runnerVersion,
        item.runtimeConfig.oracleVersion,
        item.runtimeConfig.modelConfigDigest,
        item.runtimeConfig.tools,
        item.runtimeConfig.permissionsDigest,
      ],
    ])
  );
export const rsiHoldoutDigest = (item: RsiCase) =>
  rsiDigest(
    JSON.stringify(
      item.evidence.source === 'task-fixture'
        ? ['task-fixture', item.evidence.fixtureDigest]
        : [item.evidence.source, item.evidence.runtime, item.runId]
    )
  );
const baseline = { id: 'rdk-rsi-baseline', version: '1.0.0', instructions: '' };
export const RSI_BASELINE: RsiAdapter = Object.freeze({
  ...baseline,
  digest: rsiAdapterDigest(baseline),
});
export interface RsiState {
  schemaVersion: 2 | 3;
  scope: RsiScope;
  revision: number;
  /** Optional opt-in daily references. Legacy state is unchanged until configured. */
  daily?: RsiDailyState;
  replay?: RsiReplayState;
  assets?: RsiAssetState;
  safetyLedgerVersion?: 1;
  deletedTrainingSources?: Array<{ id: string; taskScopeDigest: string }>;
  /** External training uses one independent active policy per trusted task scope. */
  trainingPolicies?: Record<string, RsiPolicy>;
  runs: RsiRun[];
  cases: RsiCase[];
  candidates: RsiCandidate[];
  evaluations: RsiEvaluation[];
  /** Optional in legacy schema-2 documents; read() normalizes these collections. */
  protocols?: RsiProtocol[];
  /** Claim before the provider call; failure cannot reopen the same preregistered proposal. */
  protocolProposals?: string[];
  trainingSessions?: RsiTrainingSession[];
  trainingConfirmations?: RsiTrainingConfirmation[];
  trainingReservations?: RsiTrainingReservation[];
  /** Never cleared by case/evaluation deletion or evidence retention. Contains hashes only. */
  holdoutConsumptions: Array<{ digest: string; at: number }>;
  /** Original evidence split survives deletion and retention. Hashes reveal no annotation. */
  caseExposures: Array<{ digest: string; split: RsiCase['split']; at: number }>;
  policy: RsiPolicy;
  transitions: RsiPolicyTransition[];
}

/** One bounded document per owner/environment; synchronous transactions never span provider calls. */
export class RsiStore {
  constructor(
    readonly rootDir: string,
    private readonly workspaceDir?: string
  ) {}
  private file(scope: RsiScope) {
    if (
      !scope.ownerKey?.trim() ||
      scope.ownerKey.length > 512 ||
      !['production', 'staging', 'development', 'test'].includes(scope.environment)
    )
      throw new RsiError('invalid_scope', 401);
    return path.join(
      this.rootDir,
      rsiDigest(`${scope.ownerKey}\0${scope.environment}`),
      'state.json'
    );
  }
  read(scope: RsiScope): RsiState {
    const file = this.file(scope);
    assetPath(path.dirname(file), 'state.json');
    let state: RsiState;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8')) as RsiState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new RsiError('rsi_store_unavailable', 503, error);
      // An existing owner directory with historical payloads is not a new account.
      // Missing index/ledger must never silently reset consumed evaluation opportunities.
      if (
        ['backup-auth.key', 'safety-ledger.json', 'documents', 'backups', 'assets'].some((name) =>
          fs.existsSync(assetPath(path.dirname(file), name))
        )
      )
        throw new RsiError('rsi_store_unavailable', 503, error);
      return {
        schemaVersion: 2,
        scope: { ...scope },
        revision: 0,
        runs: [],
        cases: [],
        candidates: [],
        evaluations: [],
        protocols: [],
        protocolProposals: [],
        trainingSessions: [],
        trainingConfirmations: [],
        trainingReservations: [],
        holdoutConsumptions: [],
        caseExposures: [],
        policy: {
          version: 0,
          activeDigest: RSI_BASELINE.digest,
          previousDigest: null,
          updatedAt: 0,
        },
        transitions: [],
      };
    }
    if (state.scope?.ownerKey !== scope.ownerKey || state.scope?.environment !== scope.environment)
      throw new RsiError('invalid_scope', 401);
    hydrateDocuments(path.dirname(file), state);
    if (
      state.assets &&
      (state.assets.schemaVersion !== 1 ||
        !['records', 'leases', 'deletedIds', 'invalidatedAdapters', 'deletions'].every((key) =>
          Array.isArray((state.assets as unknown as Record<string, unknown>)[key])
        ) ||
        ![
          'quotaBytes',
          'evidenceRetentionDays',
          'summaryRetentionDays',
          'failedWorkspaceRetentionDays',
        ].every((key) => {
          const value = (state.assets as unknown as Record<string, unknown>)[key];
          return Number.isSafeInteger(value) && Number(value) > 0;
        }))
    )
      throw new RsiError('asset_index_invalid', 503);
    // Schema-2 documents from before protocol support remain valid legacy evidence.
    if (state.protocols === undefined) state.protocols = [];
    if (state.protocolProposals === undefined) state.protocolProposals = [];
    if (state.trainingSessions === undefined) state.trainingSessions = [];
    if (state.trainingConfirmations === undefined) state.trainingConfirmations = [];
    if (state.trainingReservations === undefined) state.trainingReservations = [];
    if (
      ![2, 3].includes(state.schemaVersion) ||
      state.scope?.ownerKey !== scope.ownerKey ||
      state.scope?.environment !== scope.environment ||
      !Array.isArray(state.runs) ||
      !Array.isArray(state.cases) ||
      !Array.isArray(state.candidates) ||
      !Array.isArray(state.evaluations) ||
      !Array.isArray(state.protocols) ||
      !Array.isArray(state.protocolProposals) ||
      !Array.isArray(state.trainingSessions) ||
      !Array.isArray(state.trainingConfirmations) ||
      !Array.isArray(state.trainingReservations) ||
      !Array.isArray(state.caseExposures) ||
      !Array.isArray(state.holdoutConsumptions) ||
      !Array.isArray(state.transitions) ||
      !state.policy
    )
      throw new RsiError('rsi_store_unavailable', 503);
    // Retention is an explicit asset transaction, never a destructive side effect of reading.
    const ledger = readSafetyLedger(path.dirname(file), scope, state.safetyLedgerVersion === 1);
    if (ledger) {
      applySafetyLedger(state, ledger);
      state.revision = Math.max(state.revision, ledger.revision);
    }
    return state;
  }
  /** Internal recovery boundary. Caller must authenticate the fallback snapshot before invoking. */
  recover<T>(scope: RsiScope, fallback: RsiState, mutate: (state: RsiState) => T): T {
    return this.transact(scope, mutate, false, fallback);
  }
  update<T>(scope: RsiScope, mutate: (state: RsiState) => T, controlOnly = false): T {
    try {
      return this.transact(scope, mutate, controlOnly);
    } catch (cause) {
      if (cause instanceof MossError) throw cause;
      throw new RsiError('rsi_store_unavailable', 503, cause);
    }
  }
  /** Called under the same transaction lock immediately before a model/actor reservation. */
  assertAssetCapacity(scope: RsiScope, state = this.read(scope), sessionId?: string): void {
    const value = state.assets;
    if (!value) return;
    const directory = path.dirname(this.file(scope));
    const open = value.leases.filter((lease) => ['running', 'revoked'].includes(lease.status));
    let remaining = 0;
    for (const lease of open) {
      const bytes = diskUsage(
        assetPath(directory, 'training', lease.id),
        workspacePaths(directory, state)
      );
      if (bytes > lease.maxBytes) throw new RsiError('asset_quota_exceeded', 409);
      if (lease.sessionId === sessionId && lease.status === 'revoked')
        throw new RsiError('workspace_lease_revoked', 409);
      remaining += Math.max(0, lease.maxBytes - bytes);
    }
    if (diskUsage(directory, workspacePaths(directory, state)) + remaining >= value.quotaBytes)
      throw new RsiError('asset_quota_exceeded', 409);
  }
  private transact<T>(
    scope: RsiScope,
    mutate: (state: RsiState) => T,
    controlOnly: boolean,
    fallback?: RsiState
  ): T {
    const file = this.file(scope);
    if (this.workspaceDir) ensureMossRuntimeGitignore(this.workspaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    assetPath(path.dirname(file), 'state.json');
    const lock = `${file}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch {
      // Serialize stale-lock recovery: two recoverers must never unlink each
      // other's newly acquired writer lock and both pass the policy CAS.
      const recoveryLock = `${lock}.recovery`;
      let recoveryFd: number;
      try {
        recoveryFd = fs.openSync(recoveryLock, 'wx', 0o600);
      } catch {
        throw new RsiError('rsi_store_busy', 409);
      }
      try {
        let stale = false;
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            stale = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }
        // Unknown ownership, including an empty lock, fails closed.
        if (!stale) throw new RsiError('rsi_store_busy', 409);
        fs.rmSync(lock);
        fd = fs.openSync(lock, 'wx', 0o600);
      } catch {
        throw new RsiError('rsi_store_busy', 409);
      } finally {
        fs.closeSync(recoveryFd);
        fs.rmSync(recoveryLock, { force: true });
      }
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(fd, String(process.pid));
      let state: RsiState;
      let recovering = false;
      try {
        state = this.read(scope);
      } catch (error) {
        if (!fallback) throw error;
        const ledger = readSafetyLedger(path.dirname(file), scope, true)!;
        if (ledger.liveReferences) throw new RsiError('recovery_live_references_unresolved', 409);
        state = structuredClone(fallback);
        if (
          state.scope.ownerKey !== scope.ownerKey ||
          state.scope.environment !== scope.environment
        )
          throw new RsiError('invalid_scope', 401);
        applySafetyLedger(state, ledger);
        state.revision = ledger.revision;
        recovering = true;
      }
      const wasLegacy = state.schemaVersion === 2 && fs.existsSync(file);
      const oldBytes = wasLegacy ? fs.readFileSync(file) : undefined;
      const result = mutate(state);
      state.revision += 1;
      const running = state.runs.filter((run) => run.outcome === 'running');
      if (running.length > RSI_RETENTION.maxRuns)
        throw new RsiError('running_retention_limit', 409);
      const ended = state.runs.filter((run) => run.outcome !== 'running');
      const remaining = RSI_RETENTION.maxRuns - running.length;
      state.runs = [...(remaining ? ended.slice(-remaining) : []), ...running];
      state.transitions = state.transitions.slice(-100);
      // Candidate artifacts and their minimal promotion validation outlive the
      // bounded evaluation/transition history, including active and rollback versions.
      if (state.candidates.length > 100) throw new RsiError('candidate_retention_limit', 409);
      if (state.cases.length > 100) throw new RsiError('case_retention_limit', 409);
      if ((state.protocols?.length ?? 0) > 100) throw new RsiError('protocol_retention_limit', 409);
      if ((state.trainingSessions?.length ?? 0) > 100)
        throw new RsiError('training_session_retention_limit', 409);
      if ((state.trainingConfirmations?.length ?? 0) > 100)
        throw new RsiError('training_confirmation_retention_limit', 409);
      if ((state.trainingReservations?.length ?? 0) > 10000)
        throw new RsiError('training_reservation_retention_limit', 409);
      state.assets ??= defaultRsiAssets();
      state.safetyLedgerVersion = 1;
      if (
        state.candidates.some((candidate) =>
          state.assets!.invalidatedAdapters.includes(candidate.adapter.digest)
        )
      )
        throw new RsiError('adapter_revoked', 409);
      const directory = path.dirname(file);
      const plan = documentPlan(directory, state, recovering);
      const indexBytes = Buffer.from(`${JSON.stringify(plan.serialized)}\n`);
      const backup = oldBytes
        ? assetPath(directory, 'backups', `legacy-v2-${rsiDigest(oldBytes.toString('utf8'))}.json`)
        : undefined;
      const added =
        plan.pending.reduce((sum, item) => sum + item.bytes.length, 0) +
        (backup && !fs.existsSync(backup) ? oldBytes!.length : 0);
      const reserved = state.assets.leases
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
      // Allow control-only updates over quota (pause, cancellation, deletion), never new payloads.
      if (
        !controlOnly &&
        added > 0 &&
        diskUsage(directory, workspacePaths(directory, state)) +
          added +
          indexBytes.length +
          reserved >
          state.assets.quotaBytes
      )
        throw new RsiError('asset_quota_exceeded', 409);
      if (backup && oldBytes) immutableBytes(backup, oldBytes);
      for (const item of plan.pending) {
        if (item.repair) restoreAuthenticatedBytes(item.file, item.bytes);
        else immutableBytes(item.file, item.bytes);
      }
      // Safety claims become durable before the policy/index can advertise their result.
      writeSafetyLedger(directory, state);
      fs.writeFileSync(temporary, indexBytes, { mode: 0o600 });
      const indexFd = fs.openSync(temporary, 'r+');
      try {
        fs.fsyncSync(indexFd);
      } finally {
        fs.closeSync(indexFd);
      }
      fs.renameSync(temporary, file);
      return structuredClone(result);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
      fs.rmSync(temporary, { force: true });
    }
  }
}
