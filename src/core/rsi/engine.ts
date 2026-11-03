import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import type { HarnessAdapter } from '../agent/harness-adapter.js';
import type {
  RsiAdapter,
  RsiAdapterReceipt,
  RsiCandidate,
  RsiCase,
  RsiCaseSplit,
  RsiEvaluation,
  RsiEvaluationCaseResult,
  RsiLearningBudget,
  RsiRun,
  RsiRunEvent,
  RsiScope,
  RsiEngineStatus,
  RsiEvaluationCriterion,
  RsiMetrics,
  RsiTaskFixtureEvidence,
  RsiProtocol,
  RsiProtocolRuntimeConfig,
} from './types.js';
import {
  RSI_BASELINE,
  RSI_RETENTION,
  RsiError,
  RsiStore,
  rsiDigest,
  rsiAdapterDigest,
  rsiCaseDigest,
  rsiHoldoutDigest,
  rsiProtocolDigest,
  type RsiState,
} from './store.js';

export interface RsiLearningProvider {
  model: string;
  evaluatorVersion: string;
  identityDigest?: string;
  propose(input: {
    baseline: RsiAdapter;
    cases: RsiCase[];
    budget: RsiLearningBudget;
  }): Promise<RsiAdapter>;
  evaluate(input: {
    baseline: RsiAdapter;
    candidate: RsiAdapter;
    cases: RsiCase[];
    budget: RsiLearningBudget;
    criterion?: RsiEvaluationCriterion;
  }): Promise<{
    model: string;
    evaluatorVersion: string;
    results: RsiEvaluationCaseResult[];
    spend?: RsiEvaluation['spend'];
  }>;
}
export type RsiLearningProviderFactory = (scope: RsiScope) => RsiLearningProvider | null;
export interface RsiSelectedAdapter {
  adapter: RsiAdapter;
  receipt: RsiAdapterReceipt;
  harnessAdapter?: HarnessAdapter;
  reason?: 'adapter_model_mismatch';
}
export interface RsiRunObserver {
  observeMiniEvent(event: Readonly<MiniAgentEvent>): void;
  observeMossEvent(event: { type: string; data?: Record<string, unknown> }): void;
  onEvent(event: Readonly<MiniAgentEvent>): void;
  noteGap(code: string): void;
  finish(outcome: RsiRun['outcome']): void;
}
const token = (value: unknown, max = 128) =>
  String(value ?? '')
    .replace(/[^a-zA-Z0-9._:/-]/g, '')
    .slice(0, max);
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
function registerCaseExposure(state: RsiState, item: RsiCase) {
  const observation =
    item.evidence.source === 'task-fixture' ? item.evidence.observation : undefined;
  const digests = [rsiHoldoutDigest(item)];
  if (observation)
    digests.push(rsiHoldoutDigest({ ...item, runId: observation.runId, evidence: observation }));
  const additions = [];
  for (const digest of digests) {
    const exposure = state.caseExposures.find((record) => record.digest === digest);
    if (exposure && exposure.split !== item.split) throw new RsiError('case_split_immutable', 409);
    if (!exposure) additions.push({ digest, split: item.split, at: Date.now() });
  }
  if (state.caseExposures.length + additions.length > 10_000)
    throw new RsiError('case_exposure_ledger_limit', 409);
  state.caseExposures.push(...additions);
}
function requiredText(value: unknown, max: number, code: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > max ||
    /\u0000/.test(value)
  )
    throw new RsiError(code);
  return value;
}
function adapterFor(state: RsiState, digest = state.policy.activeDigest): RsiAdapter {
  const adapter =
    digest === RSI_BASELINE.digest
      ? RSI_BASELINE
      : state.candidates.find((item) => item.adapter.digest === digest)?.adapter;
  if (!adapter) throw new RsiError('adapter_not_found', 404);
  if (
    adapter.digest !== rsiAdapterDigest(adapter) ||
    Buffer.byteLength(adapter.instructions, 'utf8') > 8_192
  )
    throw new RsiError('adapter_integrity_failed', 409);
  return structuredClone(adapter);
}
function receipt(adapter: RsiAdapter, policyVersion: number): RsiAdapterReceipt {
  return {
    id: adapter.id,
    version: adapter.version,
    digest: adapter.digest,
    policyVersion,
    applicationMode: adapter.instructions ? 'native-sdk' : 'baseline',
  };
}
function budget(value: RsiLearningBudget): RsiLearningBudget {
  if (
    !value ||
    !Number.isInteger(value.maxModelCalls) ||
    value.maxModelCalls < 1 ||
    value.maxModelCalls > 64 ||
    !Number.isInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 32 ||
    value.maxOutputTokens > 16_384
  )
    throw new RsiError('invalid_learning_budget');
  return { maxModelCalls: value.maxModelCalls, maxOutputTokens: value.maxOutputTokens };
}
function selectCases(state: RsiState, ids: string[]) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30 || new Set(ids).size !== ids.length)
    throw new RsiError('invalid_case_selection');
  return ids.map((id) => {
    const item = state.cases.find((c) => c.id === id);
    if (!item) throw new RsiError('case_not_found', 404);
    if (item.evidence.source === 'task-fixture' && item.evidence.observation !== undefined) {
      if (item.split !== 'training')
        throw new RsiError('fixture_observation_training_required', 409);
      const digest = rsiHoldoutDigest({
        ...item,
        runId: item.evidence.observation.runId,
        evidence: item.evidence.observation,
      });
      if (
        !state.caseExposures.some(
          (exposure) => exposure.digest === digest && exposure.split === 'training'
        )
      )
        throw new RsiError('case_exposure_changed', 409);
    }
    return structuredClone(item);
  });
}
function criterion(value: RsiEvaluationCriterion | undefined): RsiEvaluationCriterion {
  if (value === undefined) return { kind: 'correctness' };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RsiError('invalid_evaluation_criterion');
  if (value.kind === 'correctness') return { kind: 'correctness' };
  if (
    value.kind !== 'efficiency' ||
    !['toolCalls', 'modelCalls', 'sshExecCalls'].includes(value.metric) ||
    !Number.isSafeInteger(value.minimumAbsoluteGain) ||
    value.minimumAbsoluteGain < 1
  ) {
    throw new RsiError('invalid_evaluation_criterion');
  }
  return {
    kind: 'efficiency',
    metric: value.metric,
    minimumAbsoluteGain: value.minimumAbsoluteGain,
  };
}
function validMetrics(value: RsiMetrics | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([key, amount]) =>
          ['toolCalls', 'modelCalls', 'sshExecCalls'].includes(key) &&
          Number.isSafeInteger(amount) &&
          amount >= 0
      ))
  );
}
function provesImprovement(
  results: RsiEvaluationCaseResult[],
  selection?: RsiEvaluationCriterion
): boolean {
  if (
    !results.length ||
    !results.every(
      (item) => item.candidatePassed === true && typeof item.baselinePassed === 'boolean'
    )
  )
    return false;
  const gate = criterion(selection);
  if (gate.kind === 'correctness')
    return results.some((item) => item.split === 'holdout' && !item.baselinePassed);
  if (!results.every((item) => item.baselinePassed)) return false;
  let gain = 0;
  for (const item of results) {
    const baseline = item.baselineMetrics?.[gate.metric];
    const candidate = item.candidateMetrics?.[gate.metric];
    if (
      !Number.isSafeInteger(baseline) ||
      !Number.isSafeInteger(candidate) ||
      baseline! < 0 ||
      candidate! < 0 ||
      candidate! > baseline!
    )
      return false;
    if (item.split === 'holdout') gain += baseline! - candidate!;
  }
  return gain >= gate.minimumAbsoluteGain;
}
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
function runtimeConfig(value: RsiProtocolRuntimeConfig | undefined): RsiProtocolRuntimeConfig {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'runnerVersion',
          'oracleVersion',
          'modelConfigDigest',
          'tools',
          'permissionsDigest',
        ].includes(key)
    ) ||
    !Array.isArray(value.tools) ||
    value.tools.length > 64 ||
    new Set(value.tools).size !== value.tools.length ||
    typeof value.modelConfigDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.modelConfigDigest) ||
    typeof value.permissionsDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.permissionsDigest)
  )
    throw new RsiError('invalid_protocol_runtime');
  return {
    runnerVersion: requiredText(value.runnerVersion, 128, 'invalid_protocol_runtime'),
    oracleVersion: requiredText(value.oracleVersion, 128, 'invalid_protocol_runtime'),
    modelConfigDigest: value.modelConfigDigest,
    tools: value.tools.map((tool) => requiredText(tool, 128, 'invalid_protocol_runtime')),
    permissionsDigest: value.permissionsDigest,
  };
}
function caseDigests(cases: RsiCase[]): RsiEvaluation['caseDigests'] {
  return cases.map((item) => ({ id: item.id, digest: rsiCaseDigest(item), split: item.split }));
}
function protocolFor(
  state: RsiState,
  id: string,
  provider: RsiLearningProvider | null | undefined,
  declaredRuntime: RsiProtocolRuntimeConfig | undefined
): RsiProtocol {
  const protocol = state.protocols?.find((item) => item.id === id);
  if (!protocol) throw new RsiError('protocol_not_found', 404);
  try {
    if (protocol.digest !== rsiProtocolDigest(protocol)) throw new Error('Digest mismatch');
  } catch (cause) {
    throw new RsiError('protocol_integrity_failed', 409, cause);
  }
  if (
    state.policy.version !== protocol.policyVersion ||
    state.policy.activeDigest !== protocol.baselineDigest
  )
    throw new RsiError('protocol_baseline_changed', 409);
  if (
    !provider ||
    provider.model !== protocol.validationIdentity.model ||
    provider.evaluatorVersion !== protocol.validationIdentity.evaluatorVersion ||
    provider.identityDigest !== protocol.validationIdentity.providerIdentityDigest
  )
    throw new RsiError('protocol_validation_changed', 409);
  if (JSON.stringify(runtimeConfig(declaredRuntime)) !== JSON.stringify(protocol.runtimeConfig))
    throw new RsiError('protocol_runtime_changed', 409);
  const cases = selectCases(
    state,
    protocol.caseDigests.map((item) => item.id)
  );
  if (
    JSON.stringify(caseDigests(cases)) !== JSON.stringify(protocol.caseDigests) ||
    !cases.every((item) =>
      state.caseExposures.some(
        (exposure) => exposure.digest === rsiHoldoutDigest(item) && exposure.split === item.split
      )
    )
  )
    throw new RsiError('protocol_cases_changed', 409);
  return structuredClone(protocol);
}
function assertProtocolPlan(
  protocol: RsiProtocol,
  input: { caseIds: string[]; budget: RsiLearningBudget; criterion?: RsiEvaluationCriterion },
  trainingOnly = false
) {
  const selected = protocol.caseDigests.filter(
    (item) => !trainingOnly || item.split === 'training'
  );
  if (
    JSON.stringify(input.caseIds) !== JSON.stringify(selected.map((item) => item.id)) ||
    JSON.stringify(budget(input.budget)) !== JSON.stringify(protocol.budget) ||
    (!trainingOnly &&
      JSON.stringify(criterion(input.criterion)) !== JSON.stringify(protocol.criterion))
  )
    throw new RsiError('protocol_plan_mismatch', 409);
}

/** Optional host-neutral evolution lifecycle. No model call occurs during ordinary capture. */
export class RsiEngine {
  readonly store: RsiStore;
  private learning?: RsiLearningProvider | RsiLearningProviderFactory;
  private readonly authorize: (scope: RsiScope) => void;
  constructor(
    options: {
      rootDir?: string;
      learning?: RsiLearningProvider | RsiLearningProviderFactory;
      authorize?: (scope: RsiScope) => void;
    } = {}
  ) {
    this.store = new RsiStore(
      options.rootDir ?? path.join(process.cwd(), '.moss', 'runtime', 'rsi'),
      options.rootDir === undefined ? process.cwd() : undefined
    );
    this.learning = options.learning;
    this.authorize = options.authorize ?? (() => {});
  }
  setLearningProvider(provider: RsiLearningProvider | RsiLearningProviderFactory) {
    this.learning = provider;
  }
  private learningFor(scope: RsiScope) {
    return typeof this.learning === 'function'
      ? this.learning(Object.freeze({ ...scope }))
      : this.learning;
  }
  status(scope: RsiScope): RsiEngineStatus {
    const state = this.store.read(scope);
    let learningAvailable = false;
    try {
      learningAvailable = Boolean(this.learningFor(scope));
    } catch {
      /* Missing model is unavailable. */
    }
    return {
      learningAvailable,
      policy: state.policy,
      activeAdapter: receipt(adapterFor(state), state.policy.version),
      retention: RSI_RETENTION,
      coverage: {
        source: 'native-moss-observer',
        mode: 'bounded-metadata',
        historicalBackfill: false,
      },
    };
  }
  private requireEnabled(scope: RsiScope) {
    this.authorize(scope);
  }
  listRuns(scope: RsiScope) {
    this.requireEnabled(scope);
    return this.store.read(scope).runs.slice().reverse();
  }
  getRun(scope: RsiScope, runId: string) {
    const run = this.listRuns(scope).find((item) => item.runId === runId);
    if (!run) throw new RsiError('run_not_found', 404);
    return run;
  }
  listCases(scope: RsiScope) {
    this.requireEnabled(scope);
    const state = this.store.read(scope);
    return state.cases.map((item) => ({
      ...item,
      holdoutConsumed:
        item.split === 'holdout' &&
        state.holdoutConsumptions.some((used) => used.digest === rsiHoldoutDigest(item)),
    }));
  }
  enrollCase(
    scope: RsiScope,
    input: { runId: string; input: string; expectedOutcome: string; split: RsiCaseSplit }
  ) {
    this.requireEnabled(scope);
    const task = requiredText(input.input, 4_000, 'invalid_case_input');
    requiredText(input.expectedOutcome, 256, 'invalid_expected_outcome');
    if (!['training', 'validation', 'holdout'].includes(input.split))
      throw new RsiError('invalid_case_split');
    return this.store.update(scope, (state) => {
      const run = state.runs.find((item) => item.runId === input.runId);
      if (!run) throw new RsiError('run_not_found', 404);
      if (run.outcome === 'running') throw new RsiError('run_not_terminal', 409);
      if (state.cases.some((item) => item.runId === run.runId))
        throw new RsiError('run_already_enrolled', 409);
      const evidence = structuredClone(run);
      const item: RsiCase = {
        id: randomUUID(),
        runId: run.runId,
        createdAt: Date.now(),
        input: task,
        expectedOutcome: input.expectedOutcome,
        split: input.split,
        evidenceDigest: rsiDigest(JSON.stringify(evidence)),
        evidence,
      };
      registerCaseExposure(state, item);
      state.cases.push(item);
      return item;
    });
  }
  /** Enroll a frozen definition before solving it; not an HTTP/native-observation ingest. */
  enrollTaskCase(
    scope: RsiScope,
    input: {
      sourceKey: string;
      input: string;
      expectedOutcome: string;
      split: RsiCaseSplit;
      fixtureDigest: string;
      oracleVersion: string;
      /** Only training fixtures may bind an authentic terminal native run. */
      observationRunId?: string;
    }
  ): RsiCase {
    this.requireEnabled(scope);
    const sourceKey = requiredText(input.sourceKey, 256, 'invalid_fixture_source');
    const task = requiredText(input.input, 4000, 'invalid_case_input');
    const expectedOutcome = requiredText(input.expectedOutcome, 256, 'invalid_expected_outcome');
    const oracleVersion = requiredText(input.oracleVersion, 128, 'invalid_oracle_version');
    if (!['training', 'validation', 'holdout'].includes(input.split))
      throw new RsiError('invalid_case_split');
    if (input.observationRunId !== undefined && input.split !== 'training')
      throw new RsiError('fixture_observation_training_required', 409);
    if (typeof input.fixtureDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.fixtureDigest))
      throw new RsiError('invalid_fixture_digest');
    return this.store.update(scope, (state) => {
      if (
        state.cases.some(
          (item) =>
            item.evidence.source === 'task-fixture' &&
            item.evidence.fixtureDigest === input.fixtureDigest
        )
      )
        throw new RsiError('fixture_already_enrolled', 409);
      let observation: RsiRun | undefined;
      if (input.observationRunId !== undefined) {
        observation = state.runs.find((run) => run.runId === input.observationRunId);
        if (!observation) throw new RsiError('run_not_found', 404);
        if (observation.outcome === 'running') throw new RsiError('run_not_terminal', 409);
      }
      const evidence: RsiTaskFixtureEvidence = {
        source: 'task-fixture',
        runtime: 'moss',
        sourceKey,
        fixtureDigest: input.fixtureDigest,
        oracleVersion,
        taskDefinitionDigest: rsiDigest(
          JSON.stringify([sourceKey, task, expectedOutcome, input.fixtureDigest, oracleVersion])
        ),
        ...(observation ? { observation: structuredClone(observation) } : {}),
      };
      const item: RsiCase = {
        id: randomUUID(),
        runId: `fixture:${input.fixtureDigest}`,
        createdAt: Date.now(),
        input: task,
        expectedOutcome,
        split: input.split,
        evidence,
        evidenceDigest: rsiDigest(JSON.stringify(evidence)),
      };
      registerCaseExposure(state, item);
      state.cases.push(item);
      return item;
    });
  }
  deleteCase(scope: RsiScope, id: string) {
    this.requireEnabled(scope);
    return this.store.update(scope, (state) => {
      if (!state.cases.some((item) => item.id === id)) throw new RsiError('case_not_found', 404);
      state.cases = state.cases.filter((item) => item.id !== id);
      // Deleted evidence cannot continue authorizing a candidate promotion.
      state.evaluations = state.evaluations.filter(
        (item) => !item.caseDigests.some((c) => c.id === id)
      );
      return { deleted: true };
    });
  }
  listCandidates(scope: RsiScope) {
    this.requireEnabled(scope);
    return this.store.read(scope).candidates;
  }
  listProtocols(scope: RsiScope): RsiProtocol[] {
    this.requireEnabled(scope);
    return this.store.read(scope).protocols ?? [];
  }
  freezeProtocol(
    scope: RsiScope,
    input: {
      caseIds: string[];
      budget: RsiLearningBudget;
      criterion?: RsiEvaluationCriterion;
      runtimeConfig: RsiProtocolRuntimeConfig;
    }
  ): RsiProtocol {
    this.requireEnabled(scope);
    const provider = this.learningFor(scope);
    if (!provider) throw new RsiError('learning_provider_unavailable', 503);
    const frozenBudget = budget(input.budget);
    const frozenCriterion = criterion(input.criterion);
    const declaredRuntime = runtimeConfig(input.runtimeConfig);
    const validationIdentity = {
      model: requiredText(provider.model, 256, 'protocol_validation_required'),
      evaluatorVersion: requiredText(
        provider.evaluatorVersion,
        256,
        'protocol_validation_required'
      ),
      providerIdentityDigest: requiredText(
        provider.identityDigest,
        256,
        'protocol_validation_required'
      ),
    };
    return freezeSnapshot(
      this.store.update(scope, (state) => {
        const cases = selectCases(state, input.caseIds);
        if (
          !cases.every((item) =>
            state.caseExposures.some(
              (exposure) =>
                exposure.digest === rsiHoldoutDigest(item) && exposure.split === item.split
            )
          )
        )
          throw new RsiError('case_exposure_changed', 409);
        if (
          !['training', 'validation', 'holdout'].every((split) =>
            cases.some((c) => c.split === split)
          )
        )
          throw new RsiError('nonoverlapping_splits_required');
        if (
          cases.some(
            (item) =>
              item.split === 'holdout' &&
              state.holdoutConsumptions.some((used) => used.digest === rsiHoldoutDigest(item))
          )
        )
          throw new RsiError('holdout_already_consumed', 409);
        const perArmBudget = {
          maxModelCalls: Math.floor(frozenBudget.maxModelCalls / (cases.length * 2)),
          maxOutputTokens: frozenBudget.maxOutputTokens,
        };
        if (perArmBudget.maxModelCalls < 1) throw new RsiError('learning_budget_insufficient');
        const value = {
          id: randomUUID(),
          createdAt: Date.now(),
          baselineDigest: state.policy.activeDigest,
          policyVersion: state.policy.version,
          caseDigests: caseDigests(cases),
          criterion: frozenCriterion,
          budget: frozenBudget,
          perArmBudget,
          validationIdentity,
          runtimeConfig: declaredRuntime,
        };
        const protocol = { ...value, digest: rsiProtocolDigest(value) };
        state.protocols!.push(protocol);
        return protocol;
      })
    );
  }
  importCandidate(
    scope: RsiScope,
    input: { id: string; version: string; instructions: string; baseDigest?: string },
    origin: RsiCandidate['origin'] = 'import',
    caseIds: string[] = []
  ) {
    return this.saveCandidate(scope, input, origin, caseIds);
  }
  private saveCandidate(
    scope: RsiScope,
    input: { id: string; version: string; instructions: string; baseDigest?: string },
    origin: RsiCandidate['origin'],
    caseIds: string[],
    protocol?: RsiProtocol
  ) {
    this.requireEnabled(scope);
    const id = requiredText(input.id, 128, 'invalid_adapter_id');
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version)
    )
      throw new RsiError('invalid_adapter_version');
    const instructions = requiredText(input.instructions, 8_192, 'invalid_adapter_instructions');
    const adapter = {
      id,
      version: input.version,
      instructions,
      digest: rsiAdapterDigest({ id, version: input.version, instructions }),
    };
    return this.store.update(scope, (state) => {
      if (protocol)
        protocolFor(state, protocol.id, this.learningFor(scope), protocol.runtimeConfig);
      if (input.baseDigest && input.baseDigest !== state.policy.activeDigest)
        throw new RsiError('baseline_changed', 409);
      const same = state.candidates.find((item) => item.adapter.digest === adapter.digest);
      if (same) {
        if (same.protocolDigest !== protocol?.digest)
          throw new RsiError('candidate_protocol_conflict', 409);
        return same;
      }
      if (
        state.candidates.some(
          (item) => item.adapter.id === id && item.adapter.version === adapter.version
        )
      )
        throw new RsiError('immutable_adapter_version', 409);
      const candidate: RsiCandidate = {
        adapter,
        createdAt: Date.now(),
        origin,
        baseDigest: state.policy.activeDigest,
        caseIds: [...caseIds],
        ...(protocol ? { protocolId: protocol.id, protocolDigest: protocol.digest } : {}),
      };
      state.candidates.push(candidate);
      return candidate;
    });
  }
  async propose(
    scope: RsiScope,
    input: {
      caseIds: string[];
      budget: RsiLearningBudget;
      protocolId?: string;
      runtimeConfig?: RsiProtocolRuntimeConfig;
    }
  ) {
    scope = Object.freeze({ ...scope });
    this.requireEnabled(scope);
    const provider = this.learningFor(scope);
    if (!provider) throw new RsiError('learning_provider_unavailable', 503);
    const state = this.store.read(scope),
      baseline = adapterFor(state);
    const cases = selectCases(state, input.caseIds).filter((item) => item.split !== 'holdout');
    if (!cases.some((item) => item.split === 'training'))
      throw new RsiError('training_cases_required');
    let protocol: RsiProtocol | undefined;
    if (input.protocolId !== undefined) {
      protocol = this.store.update(scope, (current) => {
        const plan = protocolFor(current, input.protocolId!, provider, input.runtimeConfig);
        assertProtocolPlan(plan, input, true);
        if (current.protocolProposals?.includes(plan.digest))
          throw new RsiError('protocol_proposal_consumed', 409);
        current.protocolProposals!.push(plan.digest);
        return plan;
      });
    }
    const proposed = await provider.propose({
      baseline: protocol ? freezeSnapshot(baseline) : baseline,
      cases: protocol ? freezeSnapshot(cases) : cases,
      budget: protocol ? freezeSnapshot(budget(input.budget)) : budget(input.budget),
    });
    this.requireEnabled(scope);
    if (!proposed || proposed.digest !== rsiAdapterDigest(proposed))
      throw new RsiError('invalid_proposed_adapter', 422);
    return this.saveCandidate(
      scope,
      { ...proposed, baseDigest: baseline.digest },
      'learner',
      cases.map((item) => item.id),
      protocol
    );
  }
  listEvaluations(scope: RsiScope) {
    this.requireEnabled(scope);
    return this.store.read(scope).evaluations;
  }
  async evaluate(
    scope: RsiScope,
    digest: string,
    input: {
      caseIds: string[];
      budget: RsiLearningBudget;
      criterion?: RsiEvaluationCriterion;
      protocolId?: string;
      runtimeConfig?: RsiProtocolRuntimeConfig;
    }
  ) {
    scope = Object.freeze({ ...scope });
    this.requireEnabled(scope);
    const provider = this.learningFor(scope);
    if (!provider) throw new RsiError('learning_provider_unavailable', 503);
    const state = this.store.read(scope),
      candidate = adapterFor(state, digest),
      baseline = adapterFor(state);
    const cases = selectCases(state, input.caseIds);
    const candidateRecord = state.candidates.find((item) => item.adapter.digest === digest);
    let protocol: RsiProtocol | undefined;
    if (
      candidateRecord?.protocolId !== undefined ||
      candidateRecord?.protocolDigest !== undefined ||
      input.protocolId !== undefined
    ) {
      if (!candidateRecord?.protocolId || input.protocolId !== candidateRecord.protocolId)
        throw new RsiError('candidate_protocol_mismatch', 409);
      protocol = protocolFor(state, input.protocolId, provider, input.runtimeConfig);
      if (
        candidateRecord.protocolDigest !== protocol.digest ||
        !state.protocolProposals?.includes(protocol.digest)
      )
        throw new RsiError('candidate_protocol_mismatch', 409);
      assertProtocolPlan(protocol, input);
    }
    if (
      cases.length < 3 ||
      !['training', 'validation', 'holdout'].every((split) =>
        cases.some((item) => item.split === split)
      )
    )
      throw new RsiError('nonoverlapping_splits_required');
    const record: RsiEvaluation = {
      id: randomUUID(),
      candidateDigest: candidate.digest,
      baselineDigest: baseline.digest,
      caseDigests: caseDigests(cases),
      evaluatorVersion: provider.evaluatorVersion,
      model: provider.model,
      providerIdentityDigest: provider.identityDigest,
      ...(protocol ? { protocolId: protocol.id, protocolDigest: protocol.digest } : {}),
      budget: freezeSnapshot(budget(input.budget)),
      criterion: freezeSnapshot(criterion(input.criterion)),
      createdAt: Date.now(),
      status: 'running',
      results: [],
    };
    this.store.update(scope, (current) => {
      if (protocol) {
        protocolFor(current, protocol.id, this.learningFor(scope), input.runtimeConfig);
        const admitted = current.candidates.find((item) => item.adapter.digest === digest);
        if (admitted?.protocolDigest !== protocol.digest || admitted.protocolId !== protocol.id)
          throw new RsiError('candidate_protocol_mismatch', 409);
      }
      const heldout = cases.filter((item) => item.split === 'holdout').map(rsiHoldoutDigest);
      if (
        heldout.some((digest) => current.holdoutConsumptions.some((item) => item.digest === digest))
      )
        throw new RsiError('holdout_already_consumed', 409);
      if (current.holdoutConsumptions.length + heldout.length > 10_000)
        throw new RsiError('holdout_ledger_limit', 409);
      if (
        !cases.every((item) =>
          current.cases.some((c) => c.id === item.id && rsiCaseDigest(c) === rsiCaseDigest(item))
        )
      )
        throw new RsiError('evaluation_evidence_changed', 409);
      if (
        !cases.every((item) =>
          current.caseExposures.some(
            (exposure) =>
              exposure.digest === rsiHoldoutDigest(item) && exposure.split === item.split
          )
        )
      )
        throw new RsiError('case_exposure_changed', 409);
      current.holdoutConsumptions.push(...heldout.map((digest) => ({ digest, at: Date.now() })));
      current.evaluations.push(record);
    });
    try {
      const output = await provider.evaluate({
        baseline: freezeSnapshot(baseline),
        candidate: freezeSnapshot(candidate),
        cases: freezeSnapshot(cases),
        budget: record.budget,
        criterion: record.criterion,
      });
      if (
        output.model !== record.model ||
        output.evaluatorVersion !== record.evaluatorVersion ||
        output.results.length !== cases.length ||
        new Set(output.results.map((item) => item.caseId)).size !== cases.length ||
        output.results.some(
          (item) =>
            !cases.some((c) => c.id === item.caseId && c.split === item.split) ||
            typeof item.baselinePassed !== 'boolean' ||
            typeof item.candidatePassed !== 'boolean' ||
            !validMetrics(item.baselineMetrics) ||
            !validMetrics(item.candidateMetrics)
        )
      )
        throw new RsiError('invalid_evaluation_result', 422);
      record.results = output.results.map((item) => ({
        ...structuredClone(item),
        reason: token(item.reason, 160),
      }));
      if (output.spend) {
        if (
          !Number.isSafeInteger(output.spend.modelCalls) ||
          output.spend.modelCalls < 0 ||
          output.spend.modelCalls > record.budget.maxModelCalls ||
          (output.spend.inputTokens !== undefined &&
            (!Number.isSafeInteger(output.spend.inputTokens) || output.spend.inputTokens < 0)) ||
          (output.spend.outputTokens !== undefined &&
            (!Number.isSafeInteger(output.spend.outputTokens) || output.spend.outputTokens < 0))
        )
          throw new RsiError('invalid_evaluation_spend', 422);
        record.spend = structuredClone(output.spend);
      }
      if (protocol)
        protocolFor(
          this.store.read(scope),
          protocol.id,
          this.learningFor(scope),
          input.runtimeConfig
        );
      record.status = provesImprovement(record.results, record.criterion) ? 'passed' : 'failed';
    } catch (error) {
      record.status = 'unavailable';
      record.errorCode = error instanceof RsiError ? error.rsiCode : 'evaluation_provider_failed';
    }
    record.completedAt = Date.now();
    this.store.update(scope, (current) => {
      const index = current.evaluations.findIndex((item) => item.id === record.id);
      if (
        index < 0 ||
        !cases.every((item) =>
          current.cases.some((c) => c.id === item.id && rsiCaseDigest(c) === rsiCaseDigest(item))
        )
      )
        throw new RsiError('evaluation_evidence_deleted', 409);
      current.evaluations[index] = record;
    });
    return record;
  }
  promote(
    scope: RsiScope,
    digest: string,
    input: {
      evaluationId: string;
      expectedPolicyVersion: number;
      protocolId?: string;
      runtimeConfig?: RsiProtocolRuntimeConfig;
    }
  ) {
    this.requireEnabled(scope);
    return this.store.update(scope, (state) => {
      if (state.policy.version !== input.expectedPolicyVersion)
        throw new RsiError('policy_version_conflict', 409);
      const candidate = adapterFor(state, digest);
      const evaluation = state.evaluations.find((item) => item.id === input.evaluationId);
      const candidateRecord = state.candidates.find((item) => item.adapter.digest === digest);
      if (
        candidateRecord?.protocolId !== undefined ||
        candidateRecord?.protocolDigest !== undefined ||
        evaluation?.protocolId !== undefined ||
        evaluation?.protocolDigest !== undefined ||
        input.protocolId !== undefined
      ) {
        if (
          !candidateRecord?.protocolId ||
          input.protocolId !== candidateRecord.protocolId ||
          evaluation?.protocolId !== input.protocolId
        )
          throw new RsiError('candidate_protocol_mismatch', 409);
        const protocol = protocolFor(
          state,
          input.protocolId,
          this.learningFor(scope),
          input.runtimeConfig
        );
        if (
          candidateRecord.protocolDigest !== protocol.digest ||
          evaluation.protocolDigest !== protocol.digest ||
          !state.protocolProposals?.includes(protocol.digest)
        )
          throw new RsiError('candidate_protocol_mismatch', 409);
        assertProtocolPlan(protocol, {
          caseIds: evaluation.caseDigests.map((item) => item.id),
          budget: evaluation.budget,
          criterion: evaluation.criterion,
        });
      }
      if (
        !evaluation ||
        evaluation.status !== 'passed' ||
        evaluation.candidateDigest !== candidate.digest ||
        evaluation.baselineDigest !== state.policy.activeDigest ||
        evaluation.caseDigests.length < 3 ||
        evaluation.results.length !== evaluation.caseDigests.length ||
        new Set(evaluation.results.map((item) => item.caseId)).size !==
          evaluation.caseDigests.length ||
        !evaluation.results.every((item) =>
          evaluation.caseDigests.some(
            (frozen) => frozen.id === item.caseId && frozen.split === item.split
          )
        ) ||
        !provesImprovement(evaluation.results, evaluation.criterion) ||
        !['training', 'validation', 'holdout'].every((split) =>
          evaluation.caseDigests.some((item) => item.split === split)
        ) ||
        !evaluation.caseDigests.every((item) =>
          state.cases.some((c) => c.id === item.id && rsiCaseDigest(c) === item.digest)
        )
      )
        throw new RsiError('passing_evaluation_required', 409);
      // Historical evaluations must also satisfy the current source-exposure boundary.
      selectCases(
        state,
        evaluation.caseDigests.map((item) => item.id)
      );
      const provider = this.learningFor(scope);
      if (!provider) throw new RsiError('learning_provider_unavailable', 503);
      if (
        provider.model !== evaluation.model ||
        provider.evaluatorVersion !== evaluation.evaluatorVersion ||
        provider.identityDigest !== evaluation.providerIdentityDigest
      )
        throw new RsiError('evaluation_provider_changed', 409);
      if (!candidateRecord) throw new RsiError('passing_evaluation_required', 409);
      candidateRecord.validation = {
        model: evaluation.model,
        evaluatorVersion: evaluation.evaluatorVersion,
        providerIdentityDigest: evaluation.providerIdentityDigest,
        evaluationId: evaluation.id,
        ...(evaluation.protocolId
          ? { protocolId: evaluation.protocolId, protocolDigest: evaluation.protocolDigest }
          : {}),
      };
      const previous = state.policy.activeDigest;
      state.policy = {
        version: state.policy.version + 1,
        activeDigest: digest,
        previousDigest: previous,
        updatedAt: Date.now(),
      };
      state.transitions.push({
        at: Date.now(),
        kind: 'promote',
        fromDigest: previous,
        toDigest: digest,
        policyVersion: state.policy.version,
        evaluationId: evaluation.id,
      });
      return state.policy;
    });
  }
  rollback(scope: RsiScope, expectedPolicyVersion: number) {
    this.requireEnabled(scope);
    return this.store.update(scope, (state) => {
      if (state.policy.version !== expectedPolicyVersion)
        throw new RsiError('policy_version_conflict', 409);
      const previous = state.policy.previousDigest;
      if (!previous) throw new RsiError('rollback_unavailable', 409);
      adapterFor(state, previous);
      const from = state.policy.activeDigest;
      state.policy = {
        version: state.policy.version + 1,
        activeDigest: previous,
        previousDigest: null,
        updatedAt: Date.now(),
      };
      state.transitions.push({
        at: Date.now(),
        kind: 'rollback',
        fromDigest: from,
        toDigest: previous,
        policyVersion: state.policy.version,
      });
      return state.policy;
    });
  }
  captureAdapter(
    scope: RsiScope,
    expected?: { model?: string; providerIdentityDigest?: string }
  ): RsiSelectedAdapter | null {
    try {
      this.requireEnabled(scope);
      const state = this.store.read(scope),
        adapter = adapterFor(state);
      if (adapter.digest !== RSI_BASELINE.digest && expected) {
        const validation = state.candidates.find(
          (item) => item.adapter.digest === adapter.digest
        )?.validation;
        if (
          !validation ||
          validation.model !== expected.model ||
          validation.providerIdentityDigest !== expected.providerIdentityDigest
        )
          return freezeSnapshot(
            structuredClone({
              adapter: RSI_BASELINE,
              receipt: receipt(RSI_BASELINE, state.policy.version),
              reason: 'adapter_model_mismatch' as const,
            })
          );
      }
      return freezeSnapshot(
        structuredClone({
          adapter,
          receipt: receipt(adapter, state.policy.version),
          ...(adapter.instructions
            ? {
                harnessAdapter: {
                  id: adapter.id,
                  version: adapter.version,
                  instructions: adapter.instructions,
                  sha256: adapter.digest,
                },
              }
            : {}),
        })
      );
    } catch {
      return null;
    }
  }
  createRunObserver(input: {
    scope: RsiScope;
    runId: string;
    adapter: RsiSelectedAdapter;
    model?: string;
  }): RsiRunObserver | null {
    try {
      input = {
        ...input,
        scope: Object.freeze({ ...input.scope }),
        adapter: freezeSnapshot(structuredClone(input.adapter)),
      };
      this.requireEnabled(input.scope);
      if (!input.runId || input.runId.length > 200) return null;
      if (
        input.adapter.adapter.digest !== rsiAdapterDigest(input.adapter.adapter) ||
        input.adapter.receipt.digest !== input.adapter.adapter.digest ||
        input.adapter.receipt.id !== input.adapter.adapter.id ||
        input.adapter.receipt.version !== input.adapter.adapter.version ||
        input.adapter.receipt.applicationMode !==
          (input.adapter.adapter.instructions ? 'native-sdk' : 'baseline')
      )
        return null;
      const run: RsiRun = {
        runId: input.runId,
        source: 'native-moss-observer',
        runtime: 'moss',
        startedAt: Date.now(),
        outcome: 'running',
        adapter: structuredClone(input.adapter.receipt),
        model: token(input.model),
        events: [],
        toolCalls: 0,
        toolFailures: 0,
        retries: 0,
        usage: { inputTokens: 0, outputTokens: 0, observed: false },
        coverage: {
          source: 'native-moss-observer',
          mode: 'bounded-metadata',
          observedEvents: 0,
          firstRetainedSeq: null,
          lastSeq: 0,
          truncated: false,
          gaps: [
            'raw_payloads_not_captured',
            ...(input.adapter.reason ? [input.adapter.reason] : []),
          ],
        },
      };
      let closed = false;
      let attested = false;
      const save = () => {
        if (!attested) return;
        try {
          this.store.update(input.scope, (state) => {
            const index = state.runs.findIndex((item) => item.runId === run.runId);
            if (index < 0) state.runs.push(structuredClone(run));
            else state.runs[index] = structuredClone(run);
          });
        } catch {
          if (!run.coverage.gaps.includes('persistence_gap'))
            run.coverage.gaps.push('persistence_gap');
        }
      };
      const observeMiniEvent = (event: Readonly<MiniAgentEvent>) => {
        if (closed) return;
        if (!attested) {
          if (event.type !== 'turn_start') return;
          const native = event.harnessAdapter;
          const selected = input.adapter.adapter;
          const matches = selected.instructions
            ? native?.id === selected.id &&
              native.version === selected.version &&
              native.sha256 === selected.digest
            : native === undefined;
          if (!matches) {
            closed = true;
            return;
          }
          attested = true;
        }
        try {
          run.coverage.observedEvents++;
          if (event.type === 'llm_usage') {
            run.usage.inputTokens += finite(event.inputTokens) ?? 0;
            run.usage.outputTokens += finite(event.outputTokens) ?? 0;
            run.usage.observed = true;
          }
          const allowed = [
            'turn_start',
            'turn_end',
            'tool_execution_start',
            'tool_execution_end',
            'tool_execution_progress',
            'tool_skipped',
            'tool_approval_request',
            'tool_approval_resolved',
            'retry',
            'compaction',
            'agent_end',
            'agent_error',
            'llm_usage',
          ];
          if (!allowed.includes(event.type)) return;
          const raw = event as unknown as Record<string, unknown>;
          const item: RsiRunEvent = {
            seq: ++run.coverage.lastSeq,
            at: Date.now(),
            type: event.type,
          };
          if (typeof raw.toolCallId === 'string') item.toolCallId = token(raw.toolCallId);
          if (typeof raw.toolName === 'string') item.toolName = token(raw.toolName);
          if (finite(raw.durationMs) !== undefined) item.durationMs = finite(raw.durationMs);
          if (finite(raw.turn) !== undefined) item.turn = finite(raw.turn);
          if (event.type === 'tool_execution_start') run.toolCalls++;
          if (event.type === 'tool_execution_end') {
            item.outcome = event.isError ? 'error' : 'ok';
            if (event.isError) run.toolFailures++;
          }
          if (event.type === 'tool_approval_resolved') item.outcome = event.decision;
          if (event.type === 'retry') run.retries++;
          run.events.push(item);
          if (run.events.length > RSI_RETENTION.maxEventsPerRun) {
            run.events = run.events.slice(-RSI_RETENTION.maxEventsPerRun);
            run.coverage.truncated = true;
          }
          run.coverage.firstRetainedSeq = run.events[0]?.seq ?? null;
          save();
        } catch {
          if (!run.coverage.gaps.includes('observer_gap')) run.coverage.gaps.push('observer_gap');
        }
      };
      return {
        observeMiniEvent,
        onEvent: observeMiniEvent,
        noteGap: (code) => {
          if (
            closed ||
            ![
              'child_runs_not_captured',
              'native_identity_unavailable',
              'prompt_attestation_unavailable',
              'adapter_model_mismatch',
            ].includes(code) ||
            run.coverage.gaps.includes(code)
          )
            return;
          run.coverage.gaps.push(code);
          save();
        },
        observeMossEvent: () => {
          /* Native events remain the sole captured execution authority. */
        },
        finish: (outcome) => {
          if (closed) return;
          closed = true;
          run.outcome = outcome === 'running' ? 'interrupted' : outcome;
          run.endedAt = Date.now();
          save();
        },
      };
    } catch {
      return null;
    }
  }
}
