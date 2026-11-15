/** Bounded RSI records contain metadata and explicitly enrolled instruction data only. */
export type RsiEnvironment = 'production' | 'staging' | 'development' | 'test';
export interface RsiScope {
  ownerKey: string;
  environment: RsiEnvironment;
}
export interface RsiAdapter {
  id: string;
  version: string;
  digest: string;
  instructions: string;
}
export interface RsiAdapterReceipt {
  id: string;
  version: string;
  digest: string;
  applicationMode: 'host-prompt-layer' | 'native-sdk' | 'baseline';
  policyVersion: number;
  taskScopeDigest?: string;
}
export interface RsiRunEvent {
  seq: number;
  at: number;
  type: string;
  toolCallId?: string;
  toolName?: string;
  outcome?: string;
  durationMs?: number;
  turn?: number;
}
export interface RsiRun {
  runId: string;
  source: 'native-moss-observer';
  runtime: 'moss';
  startedAt: number;
  endedAt?: number;
  outcome: 'running' | 'completed' | 'partial' | 'error' | 'cancelled' | 'interrupted';
  adapter: RsiAdapterReceipt;
  model?: string;
  events: RsiRunEvent[];
  toolCalls: number;
  toolFailures: number;
  retries: number;
  usage: { inputTokens: number; outputTokens: number; observed: boolean };
  coverage: {
    source: 'native-moss-observer';
    mode: 'bounded-metadata';
    observedEvents: number;
    firstRetainedSeq: number | null;
    lastSeq: number;
    truncated: boolean;
    gaps: string[];
  };
}
export type RsiCaseSplit = 'training' | 'validation' | 'holdout';
/** Frozen task input, not a claim that a native task has already executed. */
export interface RsiTaskFixtureEvidence {
  source: 'task-fixture';
  runtime: 'moss';
  sourceKey: string;
  fixtureDigest: string;
  oracleVersion: string;
  taskDefinitionDigest: string;
  /** Optional authentic terminal training observation; never a synthetic trace. */
  observation?: RsiRun;
}
export interface RsiCase {
  id: string;
  runId: string;
  createdAt: number;
  input: string;
  expectedOutcome: string;
  split: RsiCaseSplit;
  evidenceDigest: string;
  evidence: RsiRun | RsiTaskFixtureEvidence;
  /** Read projection only; consumed holdouts cannot be used for another adaptive evaluation. */
  holdoutConsumed?: boolean;
}
export interface RsiValidationIdentity {
  model: string;
  evaluatorVersion: string;
  providerIdentityDigest?: string;
  evaluationId: string;
  protocolId?: string;
  protocolDigest?: string;
}
/** Host declarations of effective execution settings; never browser-supplied oracle code. */
export interface RsiProtocolRuntimeConfig {
  runnerVersion: string;
  oracleVersion: string;
  modelConfigDigest: string;
  tools: string[];
  permissionsDigest: string;
}
/** Immutable plan persisted before its single learner proposal may start. */
export interface RsiProtocol {
  id: string;
  digest: string;
  createdAt: number;
  baselineDigest: string;
  policyVersion: number;
  caseDigests: RsiEvaluation['caseDigests'];
  criterion: RsiEvaluationCriterion;
  budget: RsiLearningBudget;
  perArmBudget: RsiLearningBudget;
  validationIdentity: {
    model: string;
    evaluatorVersion: string;
    providerIdentityDigest: string;
  };
  runtimeConfig: RsiProtocolRuntimeConfig;
}
export interface RsiCandidate {
  adapter: RsiAdapter;
  createdAt: number;
  origin: 'import' | 'learner';
  baseDigest: string;
  caseIds: string[];
  protocolId?: string;
  protocolDigest?: string;
  /** Minimal authorization retained independently of evaluation/case telemetry retention. */
  validation?: RsiValidationIdentity;
  trainingSessionId?: string;
  taskScope?: RsiTaskScope;
}

/** Trusted host admission, never inferred from the assistant's claim of relevance. */
export interface RsiTaskScope {
  projectId: string;
  repositoryRevision: string;
  taskFamily: string;
  taskFamilyVersion: string;
  capabilitiesDigest: string;
}
export interface RsiHermitIdentity {
  version: string;
  commit: string;
  method: 'prompt-only' | 'gepa';
  configDigest: string;
  templateDigest: string;
}
export interface RsiTrainingCase {
  id: string;
  groupDigest: string;
  fixtureDigest: string;
}
export interface RsiTrainingStageBudget {
  maxModelCalls: number;
  maxTokens: number;
  maxWallMs: number;
}
export interface RsiTrainingBudget {
  totalTokens: number;
  training: RsiTrainingStageBudget;
  confirmation: RsiTrainingStageBudget;
  adoptionRollback: RsiTrainingStageBudget;
  maxTaskModelCalls: number;
  maxTaskToolCalls: number;
  maxTaskWallMs: number;
  maxOutputTokens: number;
}
export interface RsiTrainingUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** A subset of inputTokens, not an additional token charge. */
  cacheReadTokens?: number;
}
export type RsiTrainingStage = 'training' | 'confirmation' | 'adoptionRollback';
export interface RsiTrainingReservation {
  id: string;
  sessionId: string;
  stage: RsiTrainingStage;
  createdAt: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  status: 'reserved' | 'settled' | 'unknown';
  usage?: Omit<RsiTrainingUsage, 'modelCalls'>;
  /** Valid provider usage can still violate the frozen reservation or deadline. */
  budgetViolations?: Array<'input_tokens' | 'output_tokens' | 'stage_wall_time'>;
}
export interface RsiTrainingPlan {
  taskScope: RsiTaskScope;
  cases: Record<'training' | 'validation' | 'holdout' | 'regression', RsiTrainingCase[]>;
  budget: RsiTrainingBudget;
  seed: number;
}
export interface RsiTrainingProvenance {
  runId: string;
  adapterCommit: string;
  instructionsDigest: string;
  steps: Array<{ step: number; adapterCommit: string; instructionsDigest: string }>;
  trainingUsage: RsiTrainingUsage;
}
export interface RsiTrainingSession extends RsiTrainingPlan {
  schemaVersion: 1;
  id: string;
  digest: string;
  createdAt: number;
  baselineDigest: string;
  policyVersion: number;
  hermit: RsiHermitIdentity;
  scopeDigest: string;
  /** Active policy and effective scoped baseline may differ. */
  policyActiveDigest: string;
  validationIdentity: { model: string; evaluatorVersion: string; providerIdentityDigest: string };
  runtimeConfig: RsiProtocolRuntimeConfig;
  status: 'frozen' | 'candidate-admitted' | 'confirming' | 'confirmed' | 'cancelled';
  candidateDigest?: string;
  provenance?: RsiTrainingProvenance;
  confirmationId?: string;
}
export interface RsiFunctionalAttempt {
  runId: string;
  adapterDigest: string;
  taskScopeDigest: string;
  evidenceDigest: string;
  status: 'completed' | 'failed' | 'unavailable';
  functionalPassed: boolean;
  formatPassed?: boolean;
  durationMs: number;
  usage: RsiTrainingUsage;
  toolCalls: number;
}
export interface RsiFunctionalResult {
  caseId: string;
  split: 'holdout' | 'regression';
  repetition: 0 | 1;
  baseline: RsiFunctionalAttempt;
  candidate: RsiFunctionalAttempt;
}
export interface RsiTrainingConfirmation {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sessionDigest: string;
  candidateDigest: string;
  baselineDigest: string;
  createdAt: number;
  completedAt?: number;
  status: 'running' | 'passed' | 'failed' | 'unavailable';
  results: RsiFunctionalResult[];
  usage?: RsiTrainingUsage;
  errorCode?: string;
}
/** Callbacks are configured by the trusted host, not deserialized from a client request. */
export interface RsiExternalTrainingProvider {
  hermit: RsiHermitIdentity;
  model: string;
  evaluatorVersion: string;
  providerIdentityDigest: string;
  runtimeConfig: RsiProtocolRuntimeConfig;
  verifyCandidate(input: {
    session: RsiTrainingSession;
    adapter: RsiAdapter;
    provenance: RsiTrainingProvenance;
  }): Promise<boolean>;
  confirm(input: {
    session: RsiTrainingSession;
    baseline: RsiAdapter;
    candidate: RsiAdapter;
  }): Promise<{ results: RsiFunctionalResult[]; usage: RsiTrainingUsage }>;
}
export type RsiExternalTrainingProviderFactory = (
  scope: RsiScope,
  taskScope: RsiTaskScope
) => RsiExternalTrainingProvider | null;
export interface RsiLearningBudget {
  maxModelCalls: number;
  maxOutputTokens: number;
}
export interface RsiEvaluationCaseResult {
  caseId: string;
  split: RsiCaseSplit;
  baselinePassed: boolean;
  candidatePassed: boolean;
  baselineMetrics?: RsiMetrics;
  candidateMetrics?: RsiMetrics;
  reason: string;
}
export interface RsiEvaluation {
  id: string;
  candidateDigest: string;
  baselineDigest: string;
  caseDigests: Array<{ id: string; digest: string; split: RsiCaseSplit }>;
  evaluatorVersion: string;
  model: string;
  providerIdentityDigest?: string;
  protocolId?: string;
  protocolDigest?: string;
  budget: RsiLearningBudget;
  criterion?: RsiEvaluationCriterion;
  createdAt: number;
  completedAt?: number;
  status: 'running' | 'passed' | 'failed' | 'unavailable';
  results: RsiEvaluationCaseResult[];
  errorCode?: string;
  spend?: { modelCalls: number; inputTokens?: number; outputTokens?: number };
}
export interface RsiPolicy {
  version: number;
  activeDigest: string;
  previousDigest: string | null;
  updatedAt: number;
}
export interface RsiPolicyTransition {
  at: number;
  kind: 'promote' | 'rollback';
  fromDigest: string;
  toDigest: string;
  policyVersion: number;
  evaluationId?: string;
  taskScopeDigest?: string;
}
export interface RsiEngineStatus {
  learningAvailable: boolean;
  policy: RsiPolicy;
  activeAdapter: RsiAdapterReceipt;
  retention: { days: number; maxRuns: number; maxEventsPerRun: number };
  coverage: { source: 'native-moss-observer'; mode: 'bounded-metadata'; historicalBackfill: false };
}
export type RsiEvaluationCriterion =
  | { kind: 'correctness' }
  | {
      kind: 'efficiency';
      metric: 'toolCalls' | 'modelCalls' | 'sshExecCalls';
      minimumAbsoluteGain: number;
    };
export type RsiMetrics = Partial<Record<'toolCalls' | 'modelCalls' | 'sshExecCalls', number>>;
