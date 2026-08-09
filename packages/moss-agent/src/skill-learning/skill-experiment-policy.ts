import { createHash } from 'node:crypto';

export type SkillExperimentVariant = 'control' | 'treatment';
export type SkillExperimentVerdict = 'passed' | 'failed' | 'inconclusive';
export type SkillExperimentDecision = 'hold' | 'promote' | 'rollback';
export type SkillRolloutStatus = 'canary' | 'promoted' | 'paused' | 'rolled_back';

export interface SkillExperimentObservation {
  schemaVersion: number;
  experimentKey: string;
  environmentFingerprint: string;
  runId: string;
  variant: SkillExperimentVariant;
  attribution: 'single-skill' | 'multi-skill' | 'none';
  evidenceBacked: boolean;
  verdict: SkillExperimentVerdict;
  occurredAt: string;
  retryCount: number;
  durationMs: number;
  totalTokens: number;
  toolCallCount: number;
  failureSignature?: string | null;
}

export interface SkillExperimentThresholds {
  version: string;
  evaluatorVersion: string;
  minimumSamplePerVariant: number;
  minimumWindowDurationMs: number;
  minimumAbsoluteSuccessLift: number;
  confidenceZScore: number;
  maximumCostRegressionRatio: number;
  rolloutStages: number[];
  criticalFailureSignatures: string[];
}

export const DEFAULT_SKILL_EXPERIMENT_THRESHOLDS: Readonly<SkillExperimentThresholds> =
  Object.freeze({
    version: 'l4-thresholds-v1',
    evaluatorVersion: 'moss-skill-experiment-v1',
    minimumSamplePerVariant: 100,
    minimumWindowDurationMs: 7 * 24 * 60 * 60 * 1_000,
    minimumAbsoluteSuccessLift: 0.05,
    confidenceZScore: 1.959963984540054,
    maximumCostRegressionRatio: 0.1,
    rolloutStages: [5, 25, 50, 100],
    criticalFailureSignatures: [],
  });

export interface FrozenSkillExperimentWindow {
  experimentKey: string;
  skillId: string;
  environmentFingerprint: string;
  windowStartedAt: string;
  windowEndedAt: string;
  currentRolloutPercent: number;
  observations: SkillExperimentObservation[];
  thresholds?: SkillExperimentThresholds;
}

export interface VariantMetrics {
  sampleSize: number;
  passed: number;
  failed: number;
  successRate: number | null;
  averageRetryCount: number | null;
  averageDurationMs: number | null;
  averageTotalTokens: number | null;
  averageToolCallCount: number | null;
  failureSignatures: string[];
}

export interface SkillExperimentExclusions {
  wrongSchema: number;
  wrongExperiment: number;
  wrongEnvironment: number;
  unknownEnvironment: number;
  nonSingleSkill: number;
  notEvidenceBacked: number;
  inconclusive: number;
  outsideWindow: number;
  duplicateRun: number;
}

export interface EvaluatedSkillExperimentDecision {
  schemaVersion: 1;
  decisionKey: string;
  decision: SkillExperimentDecision;
  reasonCode: string;
  evaluatorVersion: string;
  thresholdVersion: string;
  recommendedRolloutPercent: number;
  control: VariantMetrics;
  treatment: VariantMetrics;
  exclusions: SkillExperimentExclusions;
  successLift: number | null;
  confidenceInterval: { lower: number; upper: number } | null;
  costRegressions: string[];
}

export interface SkillRolloutPolicy {
  schemaVersion: 1;
  skillId: string;
  experimentKey: string;
  environmentFingerprint: string;
  status: SkillRolloutStatus;
  rolloutPercent: number;
  policyVersion: number;
  decisionKey: string;
  updatedAt: string;
}

export interface SkillPolicyProvider {
  getEffectivePolicy(input: {
    skillId: string;
    experimentKey: string;
    environmentFingerprint: string;
  }): Promise<SkillRolloutPolicy | null>;
}

export interface EffectiveSkillPolicyInput {
  policy: SkillRolloutPolicy | null;
  stableSubjectKey: string;
  globalKillSwitch?: boolean;
  centralPolicyRequired?: boolean;
  localEligible?: boolean;
}

export interface EffectiveSkillPolicyResult {
  allowed: boolean;
  reason:
    | 'global_kill_switch'
    | 'central_disabled'
    | 'central_rollout'
    | 'central_policy_missing'
    | 'local_ineligible';
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, canonical(item)])
  );
}

export function canonicalSkillExperimentJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function skillExperimentDecisionKey(value: unknown): string {
  return createHash('sha256').update(canonicalSkillExperimentJson(value)).digest('hex');
}

export function stableSkillRolloutBucket(experimentKey: string, stableSubjectKey: string): number {
  return (
    Number.parseInt(
      createHash('sha256')
        .update(`rdk-skill-cohort-v1\0${experimentKey}\0${stableSubjectKey}`)
        .digest('hex')
        .slice(0, 8),
      16
    ) % 100
  );
}

export function resolveEffectiveSkillPolicy(
  input: EffectiveSkillPolicyInput
): EffectiveSkillPolicyResult {
  if (input.globalKillSwitch) return { allowed: false, reason: 'global_kill_switch' };
  if (input.policy?.status === 'paused' || input.policy?.status === 'rolled_back') {
    return { allowed: false, reason: 'central_disabled' };
  }
  if (input.policy) {
    const allowed =
      stableSkillRolloutBucket(input.policy.experimentKey, input.stableSubjectKey) <
      Math.min(100, Math.max(0, input.policy.rolloutPercent));
    return { allowed, reason: 'central_rollout' };
  }
  if (input.centralPolicyRequired) return { allowed: false, reason: 'central_policy_missing' };
  return { allowed: input.localEligible !== false, reason: 'local_ineligible' };
}

function emptyExclusions(): SkillExperimentExclusions {
  return {
    wrongSchema: 0,
    wrongExperiment: 0,
    wrongEnvironment: 0,
    unknownEnvironment: 0,
    nonSingleSkill: 0,
    notEvidenceBacked: 0,
    inconclusive: 0,
    outsideWindow: 0,
    duplicateRun: 0,
  };
}

function eligibleObservations(window: FrozenSkillExperimentWindow): {
  observations: SkillExperimentObservation[];
  exclusions: SkillExperimentExclusions;
} {
  const exclusions = emptyExclusions();
  const start = Date.parse(window.windowStartedAt);
  const end = Date.parse(window.windowEndedAt);
  const seenRuns = new Set<string>();
  const accepted: SkillExperimentObservation[] = [];
  for (const observation of window.observations) {
    if (observation.schemaVersion !== 1) exclusions.wrongSchema += 1;
    else if (observation.experimentKey !== window.experimentKey) exclusions.wrongExperiment += 1;
    else if (observation.environmentFingerprint === 'unknown') exclusions.unknownEnvironment += 1;
    else if (observation.environmentFingerprint !== window.environmentFingerprint)
      exclusions.wrongEnvironment += 1;
    else if (observation.attribution !== 'single-skill') exclusions.nonSingleSkill += 1;
    else if (!observation.evidenceBacked) exclusions.notEvidenceBacked += 1;
    else if (observation.verdict === 'inconclusive') exclusions.inconclusive += 1;
    else if (
      !Number.isFinite(Date.parse(observation.occurredAt)) ||
      Date.parse(observation.occurredAt) < start ||
      Date.parse(observation.occurredAt) > end
    )
      exclusions.outsideWindow += 1;
    else if (seenRuns.has(observation.runId)) exclusions.duplicateRun += 1;
    else {
      seenRuns.add(observation.runId);
      accepted.push(observation);
    }
  }
  return { observations: accepted, exclusions };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + finiteNonNegative(value), 0) / values.length, 4);
}

function metrics(
  observations: SkillExperimentObservation[],
  variant: SkillExperimentVariant
): VariantMetrics {
  const selected = observations.filter((item) => item.variant === variant);
  const passed = selected.filter((item) => item.verdict === 'passed').length;
  const failed = selected.filter((item) => item.verdict === 'failed').length;
  return {
    sampleSize: selected.length,
    passed,
    failed,
    successRate: selected.length ? round(passed / selected.length) : null,
    averageRetryCount: average(selected.map((item) => item.retryCount)),
    averageDurationMs: average(selected.map((item) => item.durationMs)),
    averageTotalTokens: average(selected.map((item) => item.totalTokens)),
    averageToolCallCount: average(selected.map((item) => item.toolCallCount)),
    failureSignatures: [
      ...new Set(
        selected
          .map((item) => item.failureSignature)
          .filter((item): item is string => Boolean(item))
      ),
    ].sort(),
  };
}

function wilson(
  successes: number,
  total: number,
  z: number
): { lower: number; upper: number } | null {
  if (total <= 0) return null;
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total)) / denominator;
  return { lower: round(Math.max(0, center - margin)), upper: round(Math.min(1, center + margin)) };
}

function differenceInterval(
  control: VariantMetrics,
  treatment: VariantMetrics,
  z: number
): { lower: number; upper: number } | null {
  const controlInterval = wilson(control.passed, control.sampleSize, z);
  const treatmentInterval = wilson(treatment.passed, treatment.sampleSize, z);
  if (!controlInterval || !treatmentInterval) return null;
  return {
    lower: round(treatmentInterval.lower - controlInterval.upper),
    upper: round(treatmentInterval.upper - controlInterval.lower),
  };
}

function nextRolloutStage(current: number, stages: number[]): number {
  const normalized = [...new Set(stages.map((item) => Math.min(100, Math.max(0, item))))].sort(
    (left, right) => left - right
  );
  return normalized.find((item) => item > current) ?? Math.max(current, normalized.at(-1) ?? 100);
}

function costRegressions(
  control: VariantMetrics,
  treatment: VariantMetrics,
  maximumRatio: number
): string[] {
  const pairs: Array<[string, number | null, number | null]> = [
    ['retry_count', control.averageRetryCount, treatment.averageRetryCount],
    ['duration_ms', control.averageDurationMs, treatment.averageDurationMs],
    ['total_tokens', control.averageTotalTokens, treatment.averageTotalTokens],
    ['tool_call_count', control.averageToolCallCount, treatment.averageToolCallCount],
  ];
  return pairs
    .filter(([, baseline, candidate]) => {
      if (baseline == null || candidate == null) return true;
      if (baseline === 0) return candidate > 0;
      return (candidate - baseline) / baseline > maximumRatio;
    })
    .map(([name]) => name);
}

export function evaluateSkillExperimentWindow(
  window: FrozenSkillExperimentWindow
): EvaluatedSkillExperimentDecision {
  const thresholds = window.thresholds ?? DEFAULT_SKILL_EXPERIMENT_THRESHOLDS;
  const eligible = eligibleObservations(window);
  const control = metrics(eligible.observations, 'control');
  const treatment = metrics(eligible.observations, 'treatment');
  const successLift =
    control.successRate == null || treatment.successRate == null
      ? null
      : round(treatment.successRate - control.successRate);
  const confidenceInterval = differenceInterval(control, treatment, thresholds.confidenceZScore);
  const regressions = costRegressions(control, treatment, thresholds.maximumCostRegressionRatio);
  const controlFailures = new Set(control.failureSignatures);
  const criticalTreatmentOnly = treatment.failureSignatures.filter(
    (signature) =>
      thresholds.criticalFailureSignatures.includes(signature) && !controlFailures.has(signature)
  );
  const durationMs = Date.parse(window.windowEndedAt) - Date.parse(window.windowStartedAt);

  let decision: SkillExperimentDecision = 'hold';
  let reasonCode = 'insufficient_evidence';
  let recommendedRolloutPercent = window.currentRolloutPercent;
  if (criticalTreatmentOnly.length > 0) {
    decision = 'rollback';
    reasonCode = 'critical_treatment_failure';
    recommendedRolloutPercent = 0;
  } else if (confidenceInterval && confidenceInterval.upper < 0) {
    decision = 'rollback';
    reasonCode = 'significant_outcome_harm';
    recommendedRolloutPercent = 0;
  } else if (
    control.sampleSize < thresholds.minimumSamplePerVariant ||
    treatment.sampleSize < thresholds.minimumSamplePerVariant ||
    !Number.isFinite(durationMs) ||
    durationMs < thresholds.minimumWindowDurationMs
  ) {
    reasonCode = 'insufficient_evidence';
  } else if (regressions.length > 0) {
    reasonCode = 'cost_regression';
  } else if (
    successLift != null &&
    successLift >= thresholds.minimumAbsoluteSuccessLift &&
    confidenceInterval &&
    confidenceInterval.lower > 0
  ) {
    decision = 'promote';
    reasonCode = 'promotion_gates_passed';
    recommendedRolloutPercent = nextRolloutStage(
      window.currentRolloutPercent,
      thresholds.rolloutStages
    );
  } else {
    reasonCode = 'no_significant_benefit';
  }

  const decisionInput = {
    experimentKey: window.experimentKey,
    skillId: window.skillId,
    environmentFingerprint: window.environmentFingerprint,
    windowStartedAt: window.windowStartedAt,
    windowEndedAt: window.windowEndedAt,
    currentRolloutPercent: window.currentRolloutPercent,
    evaluatorVersion: thresholds.evaluatorVersion,
    thresholdVersion: thresholds.version,
    control,
    treatment,
    exclusions: eligible.exclusions,
    successLift,
    confidenceInterval,
    costRegressions: regressions,
    decision,
    reasonCode,
    recommendedRolloutPercent,
  };
  return {
    schemaVersion: 1,
    decisionKey: skillExperimentDecisionKey(decisionInput),
    decision,
    reasonCode,
    evaluatorVersion: thresholds.evaluatorVersion,
    thresholdVersion: thresholds.version,
    recommendedRolloutPercent,
    control,
    treatment,
    exclusions: eligible.exclusions,
    successLift,
    confidenceInterval,
    costRegressions: regressions,
  };
}
