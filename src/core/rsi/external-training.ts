import { randomUUID } from 'node:crypto';
import {
  RSI_BASELINE,
  RsiError,
  rsiAdapterDigest,
  rsiDigest,
  type RsiState,
  type RsiStore,
} from './store.js';
import type {
  RsiAdapter,
  RsiExternalTrainingProvider,
  RsiExternalTrainingProviderFactory,
  RsiFunctionalResult,
  RsiScope,
  RsiTaskScope,
  RsiTrainingConfirmation,
  RsiTrainingPlan,
  RsiTrainingProvenance,
  RsiTrainingReservation,
  RsiTrainingSession,
  RsiTrainingStage,
  RsiTrainingUsage,
  RsiPolicy,
} from './types.js';

function fail(code: string): never {
  throw new RsiError(code, 409);
}
const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => rsiDigest(canonical(value));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function text(value: unknown, max = 512): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    value.includes('\0')
  )
    fail('invalid_training_text');
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid_training_digest');
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    fail('invalid_training_integer');
}
function keys(value: object, expected: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), expected.sort())
  )
    fail('invalid_training_shape');
}
export function rsiTaskScopeDigest(scope: RsiTaskScope): string {
  keys(scope, [
    'projectId',
    'repositoryRevision',
    'taskFamily',
    'taskFamilyVersion',
    'capabilitiesDigest',
  ]);
  text(scope.projectId);
  text(scope.repositoryRevision);
  if (!/^[a-f0-9]{40}$/.test(scope.repositoryRevision)) fail('unknown_repository_revision');
  text(scope.taskFamily);
  text(scope.taskFamilyVersion);
  digest(scope.capabilitiesDigest);
  return hash(scope);
}
export function trainingPolicyFor(state: RsiState, taskScope: RsiTaskScope): RsiPolicy {
  return (
    state.trainingPolicies?.[rsiTaskScopeDigest(taskScope)] ?? {
      version: 0,
      activeDigest: RSI_BASELINE.digest,
      previousDigest: null,
      updatedAt: 0,
    }
  );
}
function usage(value: RsiTrainingUsage) {
  if (!value || typeof value !== 'object') fail('training_usage_missing');
  for (const key of Object.keys(value))
    if (!['modelCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens'].includes(key))
      fail('invalid_training_usage');
  integer(value.modelCalls);
  integer(value.inputTokens);
  integer(value.outputTokens);
  if (value.cacheReadTokens !== undefined) {
    integer(value.cacheReadTokens);
    if (value.cacheReadTokens > value.inputTokens) fail('invalid_training_usage');
  }
  return value;
}
const tokens = (value: Pick<RsiTrainingUsage, 'inputTokens' | 'outputTokens'>) =>
  value.inputTokens + value.outputTokens;
function sessionDigest(session: RsiTrainingSession) {
  const {
    digest: _digest,
    status: _status,
    candidateDigest: _candidate,
    provenance: _provenance,
    confirmationId: _confirmation,
    ...plan
  } = session;
  return hash(plan);
}
function sessionFor(state: RsiState, id: string) {
  const session = state.trainingSessions?.find((item) => item.id === id);
  if (
    !session ||
    session.schemaVersion !== 1 ||
    session.digest !== sessionDigest(session) ||
    session.scopeDigest !== hash(state.scope)
  )
    fail('training_session_invalid');
  return session;
}
function fixtures(session: RsiTrainingPlan, finalOnly = false) {
  return Object.entries(session.cases)
    .filter(([split]) => !finalOnly || split === 'holdout' || split === 'regression')
    .flatMap(([split, cases]) =>
      cases.map((item) => ({
        ...item,
        split,
        fixtureClaim: rsiDigest(JSON.stringify(['task-fixture', item.fixtureDigest])),
        groupClaim: hash(['training-group', item.groupDigest]),
      }))
    );
}
function validatePlan(plan: RsiTrainingPlan) {
  keys(plan, ['taskScope', 'cases', 'budget', 'seed']);
  rsiTaskScopeDigest(plan.taskScope);
  integer(plan.seed);
  keys(plan.cases, ['training', 'validation', 'holdout', 'regression']);
  for (const cases of Object.values(plan.cases)) {
    if (!Array.isArray(cases) || cases.length !== 4) fail('training_requires_four_cases_per_split');
    for (const item of cases) {
      keys(item, ['id', 'groupDigest', 'fixtureDigest']);
      text(item.id, 128);
      digest(item.groupDigest);
      digest(item.fixtureDigest);
    }
  }
  const all = fixtures(plan);
  for (const key of ['id', 'fixtureDigest'] as const)
    if (new Set(all.map((item) => item[key])).size !== all.length) fail('training_splits_overlap');
  const groups = new Map<string, string>();
  for (const item of all) {
    const split = groups.get(item.groupDigest);
    if (split && split !== item.split) fail('training_splits_overlap');
    groups.set(item.groupDigest, item.split);
  }
  keys(plan.budget, [
    'totalTokens',
    'training',
    'confirmation',
    'adoptionRollback',
    'maxTaskModelCalls',
    'maxTaskToolCalls',
    'maxTaskWallMs',
    'maxOutputTokens',
  ]);
  for (const key of [
    'totalTokens',
    'maxTaskModelCalls',
    'maxTaskToolCalls',
    'maxTaskWallMs',
    'maxOutputTokens',
  ] as const) {
    integer(plan.budget[key]);
    if (!plan.budget[key]) fail('training_budget_invalid');
  }
  for (const key of ['training', 'confirmation', 'adoptionRollback'] as const) {
    const stage = plan.budget[key];
    keys(stage, ['maxModelCalls', 'maxTokens', 'maxWallMs']);
    for (const n of Object.values(stage)) {
      integer(n);
      if (!n) fail('training_budget_invalid');
    }
  }
  if (
    plan.budget.training.maxTokens +
      plan.budget.confirmation.maxTokens +
      plan.budget.adoptionRollback.maxTokens >
    plan.budget.totalTokens
  )
    fail('training_budget_invalid');
}
function validateProvider(
  provider: RsiExternalTrainingProvider | null | undefined
): asserts provider is RsiExternalTrainingProvider {
  if (!provider) fail('external_training_provider_unavailable');
  keys(provider.hermit, ['version', 'commit', 'method', 'configDigest', 'templateDigest']);
  text(provider.hermit.version, 128);
  if (!/^[a-f0-9]{40}$/.test(provider.hermit.commit) || provider.hermit.method !== 'gepa')
    fail('invalid_hermit_identity');
  digest(provider.hermit.configDigest);
  digest(provider.hermit.templateDigest);
  text(provider.model);
  text(provider.evaluatorVersion);
  digest(provider.providerIdentityDigest);
  keys(provider.runtimeConfig, [
    'runnerVersion',
    'oracleVersion',
    'modelConfigDigest',
    'tools',
    'permissionsDigest',
  ]);
  text(provider.runtimeConfig.runnerVersion);
  text(provider.runtimeConfig.oracleVersion);
  digest(provider.runtimeConfig.modelConfigDigest);
  digest(provider.runtimeConfig.permissionsDigest);
  if (!Array.isArray(provider.runtimeConfig.tools) || provider.runtimeConfig.tools.length > 128)
    fail('invalid_runtime_config');
  provider.runtimeConfig.tools.forEach((item) => text(item));
}
function stageUsage(
  state: RsiState,
  session: RsiTrainingSession,
  stage: RsiTrainingStage
): RsiTrainingUsage {
  const reservations =
    state.trainingReservations?.filter(
      (item) => item.sessionId === session.id && item.stage === stage
    ) ?? [];
  if (!reservations.length || reservations.some((item) => item.status !== 'settled' || !item.usage))
    fail('training_meter_unsettled');
  return reservations.reduce(
    (total, item) => ({
      modelCalls: total.modelCalls + 1,
      inputTokens: total.inputTokens + item.usage!.inputTokens,
      outputTokens: total.outputTokens + item.usage!.outputTokens,
      cacheReadTokens: (total.cacheReadTokens ?? 0) + (item.usage!.cacheReadTokens ?? 0),
    }),
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  );
}
function sameUsage(a: RsiTrainingUsage, b: RsiTrainingUsage) {
  usage(a);
  usage(b);
  return (
    a.modelCalls === b.modelCalls &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    (a.cacheReadTokens ?? 0) === (b.cacheReadTokens ?? 0)
  );
}
function assertCurrent(state: RsiState, session: RsiTrainingSession) {
  if (session.status === 'cancelled') fail('training_session_cancelled');
  const policy = trainingPolicyFor(state, session.taskScope);
  if (
    policy.version !== session.policyVersion ||
    policy.activeDigest !== session.policyActiveDigest
  )
    fail('training_baseline_changed');
}
function checkedResults(
  session: RsiTrainingSession,
  candidate: RsiAdapter,
  results: RsiFunctionalResult[]
) {
  if (!Array.isArray(results) || results.length !== 16) fail('confirmation_requires_32_attempts');
  const seen = new Set<string>(),
    runs = new Set<string>();
  const total: RsiTrainingUsage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };
  let unavailable = false;
  for (const result of results) {
    keys(result, ['caseId', 'split', 'repetition', 'baseline', 'candidate']);
    if (
      !['holdout', 'regression'].includes(result.split) ||
      ![0, 1].includes(result.repetition) ||
      !session.cases[result.split].some((item) => item.id === result.caseId)
    )
      fail('invalid_confirmation_case');
    const key = `${result.caseId}:${result.repetition}`;
    if (seen.has(key)) fail('duplicate_confirmation_case');
    seen.add(key);
    for (const arm of ['baseline', 'candidate'] as const) {
      const attempt = result[arm];
      keys(attempt, [
        'runId',
        'adapterDigest',
        'taskScopeDigest',
        'evidenceDigest',
        'status',
        'functionalPassed',
        'durationMs',
        'usage',
        'toolCalls',
        ...(attempt?.formatPassed === undefined ? [] : ['formatPassed']),
      ]);
      if (attempt.formatPassed !== undefined && typeof attempt.formatPassed !== 'boolean')
        fail('invalid_functional_result');
      text(attempt.runId, 128);
      digest(attempt.evidenceDigest);
      if (runs.has(attempt.runId)) fail('duplicate_confirmation_run');
      runs.add(attempt.runId);
      if (
        attempt.adapterDigest !==
          (arm === 'baseline' ? session.baselineDigest : candidate.digest) ||
        attempt.taskScopeDigest !== rsiTaskScopeDigest(session.taskScope)
      )
        fail('confirmation_execution_mismatch');
      if (
        !['completed', 'failed', 'unavailable'].includes(attempt.status) ||
        typeof attempt.functionalPassed !== 'boolean' ||
        (attempt.functionalPassed && attempt.status !== 'completed')
      )
        fail('invalid_functional_result');
      unavailable ||= attempt.status === 'unavailable';
      usage(attempt.usage);
      integer(attempt.toolCalls);
      integer(attempt.durationMs);
      if (
        attempt.usage.modelCalls < 1 ||
        attempt.usage.modelCalls > session.budget.maxTaskModelCalls ||
        attempt.toolCalls > session.budget.maxTaskToolCalls ||
        attempt.durationMs > session.budget.maxTaskWallMs
      )
        fail('confirmation_task_budget_exceeded');
      total.modelCalls += attempt.usage.modelCalls;
      total.inputTokens += attempt.usage.inputTokens;
      total.outputTokens += attempt.usage.outputTokens;
      total.cacheReadTokens! += attempt.usage.cacheReadTokens ?? 0;
    }
  }
  const improvement = session.cases.holdout.some((item) =>
    results
      .filter((row) => row.caseId === item.id)
      .every((row) => !row.baseline.functionalPassed && row.candidate.functionalPassed)
  );
  return {
    total,
    status: unavailable
      ? ('unavailable' as const)
      : results.every((row) => row.candidate.functionalPassed) && improvement
        ? ('passed' as const)
        : ('failed' as const),
  };
}

/** Durable protocol primitives; model execution and the business oracle remain trusted host callbacks. */
export class RsiTrainingController {
  constructor(
    private readonly store: RsiStore,
    private readonly authorize: (scope: RsiScope) => void,
    private readonly providerFor: RsiExternalTrainingProviderFactory,
    private readonly adapterFor: (state: RsiState, digest?: string) => RsiAdapter
  ) {}
  private provider(scope: RsiScope, session: RsiTrainingSession) {
    const provider = this.providerFor(clone(scope), clone(session.taskScope));
    validateProvider(provider);
    if (
      !same(provider.hermit, session.hermit) ||
      !same(provider.runtimeConfig, session.runtimeConfig) ||
      provider.model !== session.validationIdentity.model ||
      provider.evaluatorVersion !== session.validationIdentity.evaluatorVersion ||
      provider.providerIdentityDigest !== session.validationIdentity.providerIdentityDigest
    )
      fail('training_provider_changed');
    return provider;
  }
  listSessions(scope: RsiScope) {
    this.authorize(scope);
    return clone(this.store.read(scope).trainingSessions ?? []);
  }
  canCapture(scope: RsiScope, sessionId: string, candidateDigest: string) {
    try {
      this.authorize(scope);
      const session = sessionFor(this.store.read(scope), sessionId);
      this.provider(scope, session);
      return session.status === 'confirmed' && session.candidateDigest === candidateDigest;
    } catch {
      return false;
    }
  }
  listConfirmations(scope: RsiScope) {
    this.authorize(scope);
    return clone(this.store.read(scope).trainingConfirmations ?? []);
  }
  listReservations(scope: RsiScope, sessionId: string) {
    this.authorize(scope);
    const state = this.store.read(scope);
    sessionFor(state, sessionId);
    return clone(state.trainingReservations!.filter((item) => item.sessionId === sessionId));
  }
  freeze(scope: RsiScope, input: RsiTrainingPlan) {
    this.authorize(scope);
    this.store.assertAssetCapacity(scope);
    const plan = clone(input);
    validatePlan(plan);
    const provider = this.providerFor(clone(scope), clone(plan.taskScope));
    validateProvider(provider);
    return this.store.update(scope, (state) => {
      const policy = trainingPolicyFor(state, plan.taskScope);
      const deletedSources = new Set(
        state.assets?.records
          .filter(
            (record) =>
              record.deletedAt && record.taskScopeDigest === rsiTaskScopeDigest(plan.taskScope)
          )
          .flatMap((record) => [record.id, ...(record.sourceId ? [record.sourceId] : [])]) ?? []
      );
      if (
        Object.values(plan.cases)
          .flat()
          .some((item) => deletedSources.has(item.id))
      )
        fail('training_evidence_deleted');
      const active = state.candidates.find((item) => item.adapter.digest === policy.activeDigest);
      const eligible =
        active?.trainingSessionId &&
        this.canCapture(scope, active.trainingSessionId, active.adapter.digest) &&
        same(active.taskScope, plan.taskScope) &&
        active.validation?.model === provider.model &&
        active.validation.providerIdentityDigest === provider.providerIdentityDigest;
      const baselineDigest = eligible ? policy.activeDigest : RSI_BASELINE.digest;
      const session: RsiTrainingSession = {
        ...plan,
        schemaVersion: 1,
        id: randomUUID(),
        digest: '',
        scopeDigest: hash(scope),
        createdAt: Date.now(),
        baselineDigest,
        policyActiveDigest: policy.activeDigest,
        policyVersion: policy.version,
        hermit: clone(provider.hermit),
        validationIdentity: {
          model: provider.model,
          evaluatorVersion: provider.evaluatorVersion,
          providerIdentityDigest: provider.providerIdentityDigest,
        },
        runtimeConfig: clone(provider.runtimeConfig),
        status: 'frozen',
      };
      for (const item of fixtures(session)) {
        const split =
          item.split === 'regression'
            ? 'holdout'
            : (item.split as 'training' | 'validation' | 'holdout');
        for (const claim of [item.fixtureClaim, item.groupClaim]) {
          if (state.holdoutConsumptions.some((old) => old.digest === claim))
            fail('holdout_already_consumed');
          const old = state.caseExposures.find((old) => old.digest === claim);
          if (old && old.split !== split) fail('case_split_immutable');
          if (!old) state.caseExposures.push({ digest: claim, split, at: Date.now() });
        }
      }
      if (state.caseExposures.length > 10000) fail('case_exposure_ledger_limit');
      session.digest = sessionDigest(session);
      state.trainingSessions!.push(session);
      return clone(session);
    });
  }
  reserve(
    scope: RsiScope,
    sessionId: string,
    input: { stage: RsiTrainingStage; maxInputTokens: number; maxOutputTokens: number }
  ) {
    this.authorize(scope);
    const request = clone(input);
    keys(request, ['stage', 'maxInputTokens', 'maxOutputTokens']);
    if (!['training', 'confirmation', 'adoptionRollback'].includes(request.stage))
      fail('invalid_training_stage');
    integer(request.maxInputTokens);
    integer(request.maxOutputTokens);
    if (!tokens({ inputTokens: request.maxInputTokens, outputTokens: request.maxOutputTokens }))
      fail('empty_training_reservation');
    return this.store.update(scope, (state) => {
      const session = sessionFor(state, sessionId);
      this.store.assertAssetCapacity(scope, state, sessionId);
      this.provider(scope, session);
      if (session.status === 'cancelled') fail('training_session_cancelled');
      const expected =
        request.stage === 'training'
          ? 'frozen'
          : request.stage === 'confirmation'
            ? 'confirming'
            : 'confirmed';
      if (session.status !== expected) fail('invalid_training_stage');
      if (request.stage === 'adoptionRollback') {
        const confirmation = state.trainingConfirmations!.find(
          (item) => item.id === session.confirmationId
        );
        if (
          confirmation?.status !== 'passed' ||
          ![session.candidateDigest, session.policyActiveDigest, session.baselineDigest].includes(
            trainingPolicyFor(state, session.taskScope).activeDigest
          )
        )
          fail('passing_confirmation_required');
      }
      if (request.stage !== 'adoptionRollback') assertCurrent(state, session);
      const records = state.trainingReservations!.filter((item) => item.sessionId === sessionId);
      if (records.some((item) => item.status === 'unknown')) fail('training_meter_blocked');
      const charged = (record: RsiTrainingReservation) =>
        record.status === 'settled'
          ? tokens(record.usage!)
          : record.maxInputTokens + record.maxOutputTokens;
      const stageRecords = records.filter((item) => item.stage === request.stage),
        budget = session.budget[request.stage];
      if (stageRecords.length && Date.now() - stageRecords[0]!.createdAt > budget.maxWallMs)
        fail('training_stage_timeout');
      const amount = request.maxInputTokens + request.maxOutputTokens;
      if (
        stageRecords.length >= budget.maxModelCalls ||
        stageRecords.reduce((n, item) => n + charged(item), 0) + amount > budget.maxTokens ||
        records.reduce((n, item) => n + charged(item), 0) + amount > session.budget.totalTokens ||
        request.maxOutputTokens > session.budget.maxOutputTokens
      )
        fail('training_budget_exhausted');
      const record: RsiTrainingReservation = {
        ...request,
        sessionId,
        id: randomUUID(),
        createdAt: Date.now(),
        status: 'reserved',
      };
      state.trainingReservations!.push(record);
      return clone(record);
    });
  }
  settle(
    scope: RsiScope,
    sessionId: string,
    reservationId: string,
    input: Omit<RsiTrainingUsage, 'modelCalls'> | null
  ) {
    this.authorize(scope);
    let validUsage = false;
    try {
      if (input) {
        keys(input, [
          'inputTokens',
          'outputTokens',
          ...(input.cacheReadTokens === undefined ? [] : ['cacheReadTokens']),
        ]);
        usage({ ...input, modelCalls: 1 });
        validUsage = true;
      }
    } catch {
      /* Malformed provider accounting is unknown usage, never free. */
    }
    return this.store.update(scope, (state) => {
      const session = sessionFor(state, sessionId);
      const reservation = state.trainingReservations!.find(
        (item) => item.sessionId === sessionId && item.id === reservationId
      );
      if (!reservation || reservation.status !== 'reserved') fail('training_reservation_not_open');
      const stageStart = state.trainingReservations!.find(
        (item) => item.sessionId === sessionId && item.stage === reservation.stage
      )!.createdAt;
      if (
        !validUsage ||
        !input ||
        input.inputTokens > reservation.maxInputTokens ||
        input.outputTokens > reservation.maxOutputTokens ||
        Date.now() - stageStart > session.budget[reservation.stage].maxWallMs
      )
        reservation.status = 'unknown';
      else {
        reservation.status = 'settled';
        reservation.usage = clone(input);
      }
      return clone(reservation);
    });
  }
  async admit(
    scope: RsiScope,
    sessionId: string,
    input: Pick<RsiAdapter, 'id' | 'version' | 'instructions'> & {
      provenance: RsiTrainingProvenance;
    }
  ) {
    this.authorize(scope);
    input = clone(input);
    text(input.id, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.id)) fail('invalid_adapter_id');
    text(input.instructions, 8192);
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.version)) fail('invalid_adapter_version');
    const adapter = {
      id: input.id,
      version: input.version,
      instructions: input.instructions,
      digest: rsiAdapterDigest(input),
    };
    const provenance = input.provenance;
    keys(provenance, ['runId', 'adapterCommit', 'instructionsDigest', 'steps', 'trainingUsage']);
    text(provenance.runId, 128);
    digest(provenance.instructionsDigest);
    if (
      !Array.isArray(provenance.steps) ||
      provenance.steps.length !== 2 ||
      provenance.steps.some(
        (step, index) =>
          step.step !== index + 1 ||
          !/^[a-f0-9]{40}$/.test(step.adapterCommit) ||
          !/^[a-f0-9]{64}$/.test(step.instructionsDigest)
      ) ||
      !provenance.steps.some(
        (step) =>
          step.adapterCommit === provenance.adapterCommit &&
          step.instructionsDigest === provenance.instructionsDigest
      ) ||
      provenance.instructionsDigest !== rsiDigest(adapter.instructions)
    )
      fail('untrusted_training_provenance');
    provenance.steps.forEach((step) => keys(step, ['step', 'adapterCommit', 'instructionsDigest']));
    const before = this.store.read(scope),
      session = sessionFor(before, sessionId);
    assertCurrent(before, session);
    if (session.status !== 'frozen' || session.candidateDigest)
      fail('training_champion_already_claimed');
    if (!sameUsage(provenance.trainingUsage, stageUsage(before, session, 'training')))
      fail('training_usage_mismatch');
    const provider = this.provider(scope, session);
    if (
      !(await provider.verifyCandidate({
        session: clone(session),
        adapter: clone(adapter),
        provenance: clone(provenance),
      }))
    )
      fail('untrusted_training_provenance');
    this.authorize(scope);
    return this.store.update(scope, (state) => {
      const current = sessionFor(state, sessionId);
      assertCurrent(state, current);
      this.provider(scope, current);
      if (current.status !== 'frozen' || current.candidateDigest)
        fail('training_champion_already_claimed');
      if (!sameUsage(provenance.trainingUsage, stageUsage(state, current, 'training')))
        fail('training_usage_mismatch');
      if (
        state.candidates.some(
          (item) =>
            item.adapter.digest === adapter.digest ||
            (item.adapter.id === adapter.id && item.adapter.version === adapter.version)
        )
      )
        fail('adapter_version_conflict');
      state.candidates.push({
        adapter,
        createdAt: Date.now(),
        origin: 'learner',
        baseDigest: current.baselineDigest,
        caseIds: [...current.cases.training, ...current.cases.validation].map((item) => item.id),
        trainingSessionId: current.id,
        taskScope: clone(current.taskScope),
      });
      current.candidateDigest = adapter.digest;
      current.provenance = provenance;
      current.status = 'candidate-admitted';
      return clone(adapter);
    });
  }
  async confirm(scope: RsiScope, sessionId: string) {
    this.authorize(scope);
    const claim = this.store.update(scope, (state) => {
      const session = sessionFor(state, sessionId);
      assertCurrent(state, session);
      this.provider(scope, session);
      if (
        session.status !== 'candidate-admitted' ||
        !session.candidateDigest ||
        session.confirmationId
      )
        fail('confirmation_already_claimed');
      const claims = [
        ...new Set(fixtures(session, true).flatMap((item) => [item.fixtureClaim, item.groupClaim])),
      ];
      if (claims.some((d) => state.holdoutConsumptions.some((old) => old.digest === d)))
        fail('holdout_already_consumed');
      if (state.holdoutConsumptions.length + claims.length > 10000) fail('holdout_ledger_limit');
      const at = Date.now();
      state.holdoutConsumptions.push(...claims.map((digest) => ({ digest, at })));
      const record: RsiTrainingConfirmation = {
        schemaVersion: 1,
        id: randomUUID(),
        sessionId,
        sessionDigest: session.digest,
        candidateDigest: session.candidateDigest,
        baselineDigest: session.baselineDigest,
        createdAt: at,
        status: 'running',
        results: [],
      };
      session.confirmationId = record.id;
      session.status = 'confirming';
      state.trainingConfirmations!.push(record);
      return {
        session: clone(session),
        record: clone(record),
        baseline: this.adapterFor(state, session.baselineDigest),
        candidate: this.adapterFor(state, session.candidateDigest),
      };
    });
    try {
      const provider = this.provider(scope, claim.session);
      const output = clone(
        await provider.confirm({
          session: clone(claim.session),
          baseline: clone(claim.baseline),
          candidate: clone(claim.candidate),
        })
      );
      this.authorize(scope);
      return this.store.update(scope, (state) => {
        const session = sessionFor(state, sessionId);
        assertCurrent(state, session);
        this.provider(scope, session);
        if (session.status !== 'confirming') fail('training_session_cancelled');
        const result = checkedResults(session, claim.candidate, output.results);
        if (
          !sameUsage(result.total, output.usage) ||
          !sameUsage(output.usage, stageUsage(state, session, 'confirmation'))
        )
          fail('confirmation_usage_mismatch');
        const record = state.trainingConfirmations!.find((item) => item.id === claim.record.id)!;
        record.results = output.results;
        record.usage = output.usage;
        record.status = result.status;
        record.completedAt = Date.now();
        session.status = 'confirmed';
        return clone(record);
      });
    } catch (error) {
      return this.store.update(scope, (state) => {
        const session = sessionFor(state, sessionId),
          record = state.trainingConfirmations!.find((item) => item.id === claim.record.id)!;
        record.status = 'unavailable';
        record.completedAt = Date.now();
        record.errorCode =
          error instanceof RsiError ? error.rsiCode : 'external_confirmation_failed';
        if (session.status !== 'cancelled') session.status = 'confirmed';
        return clone(record);
      });
    }
  }
  promote(
    scope: RsiScope,
    sessionId: string,
    input: { confirmationId: string; expectedPolicyVersion: number }
  ) {
    this.authorize(scope);
    return this.store.update(scope, (state) => {
      const session = sessionFor(state, sessionId);
      const policy = trainingPolicyFor(state, session.taskScope);
      assertCurrent(state, session);
      this.provider(scope, session);
      const record = state.trainingConfirmations!.find((item) => item.id === input.confirmationId),
        candidate = state.candidates.find(
          (item) =>
            item.adapter.digest === session.candidateDigest && item.trainingSessionId === session.id
        );
      if (
        policy.version !== input.expectedPolicyVersion ||
        session.status !== 'confirmed' ||
        !record ||
        record.id !== session.confirmationId ||
        record.status !== 'passed' ||
        record.sessionId !== session.id ||
        record.sessionDigest !== session.digest ||
        record.baselineDigest !== session.baselineDigest ||
        record.candidateDigest !== session.candidateDigest ||
        !candidate ||
        !same(candidate.taskScope, session.taskScope) ||
        checkedResults(session, candidate.adapter, record.results).status !== 'passed' ||
        !sameUsage(stageUsage(state, session, 'training'), session.provenance!.trainingUsage) ||
        !sameUsage(stageUsage(state, session, 'confirmation'), record.usage!)
      )
        fail('passing_confirmation_required');
      const previous = policy.activeDigest;
      candidate.validation = { ...session.validationIdentity, evaluationId: record.id };
      const updated = {
        version: policy.version + 1,
        activeDigest: candidate.adapter.digest,
        previousDigest: previous,
        updatedAt: Date.now(),
      };
      const taskScopeDigest = rsiTaskScopeDigest(session.taskScope);
      state.trainingPolicies ??= {};
      state.trainingPolicies[taskScopeDigest] = updated;
      state.transitions.push({
        at: Date.now(),
        kind: 'promote',
        fromDigest: previous,
        toDigest: candidate.adapter.digest,
        policyVersion: updated.version,
        evaluationId: record.id,
        taskScopeDigest,
      });
      return clone(updated);
    });
  }
  policy(scope: RsiScope, taskScope: RsiTaskScope) {
    this.authorize(scope);
    return clone(trainingPolicyFor(this.store.read(scope), taskScope));
  }
  rollback(scope: RsiScope, taskScope: RsiTaskScope, expectedPolicyVersion: number) {
    this.authorize(scope);
    return this.store.update(scope, (state) => {
      const taskScopeDigest = rsiTaskScopeDigest(taskScope);
      const policy = trainingPolicyFor(state, taskScope);
      if (policy.version !== expectedPolicyVersion) fail('policy_version_conflict');
      if (!policy.previousDigest) fail('rollback_unavailable');
      if (policy.previousDigest !== RSI_BASELINE.digest) {
        const previous = state.candidates.find(
          (item) => item.adapter.digest === policy.previousDigest
        );
        if (
          !previous?.trainingSessionId ||
          !same(previous.taskScope, taskScope) ||
          !this.canCapture(scope, previous.trainingSessionId, previous.adapter.digest)
        )
          fail('rollback_unavailable');
      }
      const updated = {
        version: policy.version + 1,
        activeDigest: policy.previousDigest,
        previousDigest: null,
        updatedAt: Date.now(),
      };
      state.trainingPolicies ??= {};
      state.trainingPolicies[taskScopeDigest] = updated;
      state.transitions.push({
        at: Date.now(),
        kind: 'rollback',
        fromDigest: policy.activeDigest,
        toDigest: updated.activeDigest,
        policyVersion: updated.version,
        taskScopeDigest,
      });
      return clone(updated);
    });
  }
  cancel(scope: RsiScope, sessionId: string) {
    this.authorize(scope);
    return this.store.update(
      scope,
      (state) => {
        const session = sessionFor(state, sessionId);
        session.status = 'cancelled';
        return clone(session);
      },
      true
    );
  }
}
