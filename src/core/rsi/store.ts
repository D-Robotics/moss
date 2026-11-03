import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ErrorCode, MossError } from '../../errors.js';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import { hashHarnessAdapter } from '../agent/harness-adapter.js';
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
/** Stable domain identity plus the ordinary Moss error boundary. */
export class RsiError extends MossError {
  constructor(
    readonly rsiCode: string,
    readonly status = 400,
    cause?: unknown
  ) {
    super({
      code: ['rsi_model_call_failed', 'rsi_task_evaluation_failed'].includes(rsiCode)
        ? ErrorCode.PROVIDER_UPSTREAM_ERROR
        : status >= 500
          ? ErrorCode.EXECUTION_STORE_FAILED
          : ErrorCode.USER_INPUT_INVALID,
      message: rsiCode,
      cause,
    });
    this.name = 'RsiError';
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), rsiCode: this.rsiCode, status: this.status };
  }
}
export interface RsiState {
  schemaVersion: 2;
  scope: RsiScope;
  revision: number;
  runs: RsiRun[];
  cases: RsiCase[];
  candidates: RsiCandidate[];
  evaluations: RsiEvaluation[];
  /** Optional in legacy schema-2 documents; read() normalizes these collections. */
  protocols?: RsiProtocol[];
  /** Claim before the provider call; failure cannot reopen the same preregistered proposal. */
  protocolProposals?: string[];
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
    let state: RsiState;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8')) as RsiState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
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
    // Schema-2 documents from before protocol support remain valid legacy evidence.
    if (state.protocols === undefined) state.protocols = [];
    if (state.protocolProposals === undefined) state.protocolProposals = [];
    if (
      state.schemaVersion !== 2 ||
      state.scope?.ownerKey !== scope.ownerKey ||
      state.scope?.environment !== scope.environment ||
      !Array.isArray(state.runs) ||
      !Array.isArray(state.cases) ||
      !Array.isArray(state.candidates) ||
      !Array.isArray(state.evaluations) ||
      !Array.isArray(state.protocols) ||
      !Array.isArray(state.protocolProposals) ||
      !Array.isArray(state.caseExposures) ||
      !Array.isArray(state.holdoutConsumptions) ||
      !Array.isArray(state.transitions) ||
      !state.policy
    )
      throw new RsiError('rsi_store_unavailable', 503);
    const cutoff = Date.now() - RSI_RETENTION.days * 86_400_000;
    state.runs = state.runs.filter((run) => run.startedAt >= cutoff).slice(-RSI_RETENTION.maxRuns);
    state.cases = state.cases.filter((item) => item.createdAt >= cutoff).slice(-100);
    state.evaluations = state.evaluations.filter((item) => item.createdAt >= cutoff).slice(-60);
    return state;
  }
  update<T>(scope: RsiScope, mutate: (state: RsiState) => T): T {
    try {
      return this.transact(scope, mutate);
    } catch (cause) {
      if (cause instanceof MossError) throw cause;
      throw new RsiError('rsi_store_unavailable', 503, cause);
    }
  }
  private transact<T>(scope: RsiScope, mutate: (state: RsiState) => T): T {
    const file = this.file(scope);
    if (this.workspaceDir) ensureMossRuntimeGitignore(this.workspaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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
      const state = this.read(scope);
      const result = mutate(state);
      state.revision += 1;
      state.runs = state.runs.slice(-RSI_RETENTION.maxRuns);
      state.transitions = state.transitions.slice(-100);
      // Candidate artifacts and their minimal promotion validation outlive the
      // bounded evaluation/transition history, including active and rollback versions.
      if (state.candidates.length > 100) throw new RsiError('candidate_retention_limit', 409);
      if (state.cases.length > 100) throw new RsiError('case_retention_limit', 409);
      if ((state.protocols?.length ?? 0) > 100) throw new RsiError('protocol_retention_limit', 409);
      fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
      return structuredClone(result);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
      fs.rmSync(temporary, { force: true });
    }
  }
}
