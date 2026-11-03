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
}
export interface RsiCandidate {
  adapter: RsiAdapter;
  createdAt: number;
  origin: 'import' | 'learner';
  baseDigest: string;
  caseIds: string[];
  /** Minimal authorization retained independently of evaluation/case telemetry retention. */
  validation?: RsiValidationIdentity;
}
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
