import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  TerminalVerdictEntry,
  TerminalVerdictLog,
} from '../acceptance/terminal-verdict-log.js';
import type { LLMUsageRecord } from '../observability/llm-usage.js';
import type { Plan } from '../plan-execute/plan-execute-controller.js';
import { SkillRegistry } from '../skills/registry.js';
import { parseSkillDocument } from '../skills/skill-document.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import type { CandidatePatchLog, CandidatePatchRecord } from './candidate-patch-log.js';
import type { ExperienceEntry } from './experience-log.js';
import type { LearningEventLog } from './learning-event-log.js';
import {
  PatchExperimentLog,
  type PatchExperimentArmSummary,
  type PatchExperimentAssignment,
  type PatchExperimentDecision,
  type PatchExperimentExposure,
  type PatchExperimentLifecycle,
  type PatchExperimentOutcome,
  type PatchExperimentVariant,
  type PatchExperimentHypothesis,
  type PatchExperimentCostMetric,
} from './patch-experiment-log.js';
import {
  isRealEvidenceEligible,
  requiresRealDeviceEvidence,
  type ExecutionDomain,
} from './evidence-trust.js';

export interface PatchExperimentThresholds {
  minSamplesPerArm: number;
  wilsonZ: number;
  maxCostRatio: number;
  maxRetryIncrease: number;
  successNoninferiorityMargin: number;
  minCostImprovementRatio: number;
  minCostMetricsImproved: number;
}

export const DEFAULT_PATCH_EXPERIMENT_THRESHOLDS: PatchExperimentThresholds = {
  minSamplesPerArm: 20,
  wilsonZ: 1.96,
  maxCostRatio: 1.2,
  maxRetryIncrease: 0.25,
  successNoninferiorityMargin: 0.05,
  minCostImprovementRatio: 0.1,
  minCostMetricsImproved: 2,
};

function resolveThresholds(
  overrides?: Partial<PatchExperimentThresholds>
): PatchExperimentThresholds {
  const thresholds = { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS, ...overrides };
  if (!Number.isInteger(thresholds.minSamplesPerArm) || thresholds.minSamplesPerArm < 1) {
    throw new RangeError('minSamplesPerArm must be a positive integer');
  }
  if (!Number.isFinite(thresholds.wilsonZ) || thresholds.wilsonZ <= 0) {
    throw new RangeError('wilsonZ must be a finite number greater than 0');
  }
  if (!Number.isFinite(thresholds.maxCostRatio) || thresholds.maxCostRatio <= 0) {
    throw new RangeError('maxCostRatio must be a finite number greater than 0');
  }
  if (!Number.isFinite(thresholds.maxRetryIncrease) || thresholds.maxRetryIncrease < 0) {
    throw new RangeError('maxRetryIncrease must be a finite number greater than or equal to 0');
  }
  return thresholds;
}

export interface PreparedPatchExperiment {
  assignment: PatchExperimentAssignment;
  guidanceContext: string;
  includeTrustedObservation: boolean;
  confirmExposure?: () => Promise<void>;
}

export async function buildTrustedPatchExperimentContext(input: {
  digest: string;
  prepared: PreparedPatchExperiment | null;
  loadTrustedObservation: () => Promise<string>;
}): Promise<string> {
  if (!input.prepared) return input.digest;
  const observation = input.prepared.includeTrustedObservation
    ? await input.loadTrustedObservation()
    : '';
  const context = [input.digest, input.prepared.guidanceContext, observation]
    .filter(Boolean)
    .join('\n\n');
  await input.prepared.confirmExposure?.();
  return context;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedIntent(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 4_000);
}

function explicitlyNamedSkills(registry: SkillRegistry, userMessage: string): string[] {
  const normalized = userMessage.toLowerCase();
  return registry
    .list()
    .filter((skill) => skill.enabled)
    .filter((skill) => {
      const escaped = skill.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`, 'i').test(normalized);
    })
    .map((skill) => skill.name);
}

export function createPatchExperimentTaskSignature(input: {
  userMessage: string;
  skill: string;
  environmentFingerprint: string;
  plan?: Plan | null;
}): string {
  const machinePlan = input.plan
    ? {
        expectedTools: input.plan.steps.flatMap((step) => step.expectedTools ?? []).sort(),
        expectedAccept: input.plan.steps.flatMap((step) => step.expectedAccept ?? []).sort(),
        terminalAccept: input.plan.terminalAccept ?? [],
      }
    : undefined;
  return `sha256:${sha256(
    JSON.stringify({
      intent: normalizedIntent(input.userMessage),
      skill: input.skill,
      environmentFingerprint: input.environmentFingerprint,
      machinePlan,
    })
  )}`;
}

export function assignPatchExperimentVariant(input: {
  patchId: string;
  runId: string;
  taskSignature: string;
  environmentFingerprint: string;
}): PatchExperimentVariant {
  const digest = createHash('sha256')
    .update(
      `${input.patchId}\0${input.runId}\0${input.taskSignature}\0${input.environmentFingerprint}`
    )
    .digest();
  // Consume a full 32-bit sample so future allocation ratios do not inherit an
  // avoidable one-byte bottleneck. The split stays stable for identical inputs.
  return digest.readUInt32BE(0) < 0x8000_0000 ? 'control' : 'treatment';
}

function wilson(successes: number, total: number, z: number): [number, number] {
  if (total <= 0) return [0, 1];
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function summarizeArm(outcomes: PatchExperimentOutcome[], z: number): PatchExperimentArmSummary {
  const eligible = outcomes.filter((entry) => entry.eligible !== false);
  const passed = eligible.filter((entry) => entry.terminalVerdict === 'pass').length;
  const failed = eligible.filter((entry) => entry.terminalVerdict === 'fail').length;
  const unknown = eligible.filter((entry) => entry.terminalVerdict === 'unknown').length;
  const [wilsonLow, wilsonHigh] = wilson(passed, eligible.length, z);
  const costs = eligible.flatMap((entry) =>
    entry.estimatedCostUsd === undefined ? [] : [entry.estimatedCostUsd]
  );
  const failureClasses: Record<string, number> = {};
  for (const entry of eligible) {
    for (const failureClass of entry.failureClasses) {
      failureClasses[failureClass] = (failureClasses[failureClass] ?? 0) + 1;
    }
  }
  return {
    total: eligible.length,
    passed,
    failed,
    unknown,
    successRate: eligible.length ? passed / eligible.length : 0,
    wilsonLow,
    wilsonHigh,
    averageRetries: average(eligible.map((entry) => entry.retries)),
    averageCorrections: average(eligible.map((entry) => entry.corrections)),
    averageToolCalls: average(eligible.map((entry) => entry.toolCalls)),
    averageDurationMs: average(eligible.map((entry) => entry.durationMs)),
    averageInputTokens: average(eligible.map((entry) => entry.inputTokens)),
    averageOutputTokens: average(eligible.map((entry) => entry.outputTokens)),
    ...(costs.length === eligible.length && costs.length ? { averageCostUsd: average(costs) } : {}),
    safetyFailures: eligible.filter((entry) => entry.safetyFailed).length,
    failureClasses,
    excluded: outcomes.length - eligible.length,
  };
}

function sampleVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

function costMetricSuperior(
  control: number[],
  treatment: number[],
  z: number,
  minImprovementRatio: number
): boolean {
  if (control.length < 2 || treatment.length < 2) return false;
  const controlMean = average(control);
  const treatmentMean = average(treatment);
  if (controlMean <= 0 || treatmentMean > controlMean * (1 - minImprovementRatio)) return false;
  const standardError = Math.sqrt(
    sampleVariance(control) / control.length + sampleVariance(treatment) / treatment.length
  );
  const upperDifference = treatmentMean - controlMean + z * standardError;
  return upperDifference < 0;
}

function latestOutcomes(records: PatchExperimentOutcome[]): PatchExperimentOutcome[] {
  const latest = new Map<string, PatchExperimentOutcome>();
  for (const record of records) {
    const key = `${record.patchId}\0${record.taskId}\0${record.runId}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(record.timestamp) >= Date.parse(previous.timestamp))
      latest.set(key, record);
  }
  return [...latest.values()];
}

function earliestTimestamp(entries: ExperienceEntry[]): number | undefined {
  const values = entries.map((entry) => Date.parse(entry.timestamp)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : undefined;
}

export class TrustedSkillExperimentCoordinator {
  private readonly thresholds: PatchExperimentThresholds;
  private readonly skillRegistry: SkillRegistry;

  constructor(
    private readonly deps: {
      workspaceDir: string;
      patchLog: CandidatePatchLog;
      experimentLog: PatchExperimentLog;
      terminalVerdictLog?: Pick<TerminalVerdictLog, 'readAll'>;
      learningEventLog?: Pick<LearningEventLog, 'readAll'>;
      readUsage?: () => Promise<LLMUsageRecord[]>;
      rollback?: (patchId: string) => Promise<boolean>;
      skillRegistry?: SkillRegistry;
      thresholds?: Partial<PatchExperimentThresholds>;
      hypothesis?: PatchExperimentHypothesis;
      costMetrics?: PatchExperimentCostMetric[];
    }
  ) {
    this.thresholds = resolveThresholds(deps.thresholds);
    this.skillRegistry =
      deps.skillRegistry ?? new SkillRegistry({ workspaceDir: deps.workspaceDir });
  }

  async prepareRun(input: {
    sessionKey: string;
    runId: string;
    userMessage: string;
    environmentFingerprint: string;
    skill?: string;
    plan?: Plan | null;
    executionDomain?: ExecutionDomain;
    realEvidenceEligible?: boolean;
  }): Promise<PreparedPatchExperiment | null> {
    if (!input.runId || input.environmentFingerprint === 'unknown') return null;
    const existing = await this.deps.experimentLog.assignmentForRun(input.runId);
    if (existing) {
      const expectedSignature = createPatchExperimentTaskSignature({
        userMessage: input.userMessage,
        skill: input.skill ?? existing.skill,
        environmentFingerprint: input.environmentFingerprint,
        plan: input.plan,
      });
      if (
        existing.sessionKey !== input.sessionKey ||
        existing.environmentFingerprint !== input.environmentFingerprint ||
        (input.skill !== undefined && existing.skill !== input.skill) ||
        existing.taskSignature !== expectedSignature ||
        existing.executionDomain !== (input.executionDomain ?? 'local')
      )
        return null;
      return this.preparedFromAssignment(existing);
    }

    const exactReferences = input.skill
      ? []
      : explicitlyNamedSkills(this.skillRegistry, input.userMessage);
    const matchedSkills = input.skill
      ? [input.skill]
      : exactReferences.length === 1
        ? exactReferences
        : [
            ...new Set(
              this.skillRegistry
                .matchByText(input.userMessage)
                .filter((skill) => skill.enabled)
                .map((skill) => skill.name)
            ),
          ];
    if (matchedSkills.length !== 1) return null;
    const latestPatches = await this.deps.patchLog.latest();
    const eligible = latestPatches.filter(
      (patch) =>
        patch.kind === 'skill-guidance' &&
        patch.state === 'published' &&
        patch.skill === matchedSkills[0] &&
        patch.environmentFingerprint === input.environmentFingerprint &&
        Boolean(patch.artifactPath)
    );
    if (eligible.length !== 1) return null;
    const patch = eligible[0]!;
    const executionDomain = input.executionDomain ?? 'local';
    if (
      requiresRealDeviceEvidence(patch.skill) &&
      (executionDomain !== 'real' ||
        input.realEvidenceEligible !== true ||
        !isRealEvidenceEligible(patch))
    )
      return null;
    const decision = await this.deps.experimentLog.latestDecision(patch.id);
    if (decision?.state === 'demoted') return null;
    const taskSignature = createPatchExperimentTaskSignature({
      userMessage: input.userMessage,
      skill: patch.skill,
      environmentFingerprint: input.environmentFingerprint,
      ...(patch.environmentIdentityVersion
        ? {
            environmentIdentityVersion: patch.environmentIdentityVersion,
            environmentCompleteness: patch.environmentCompleteness,
          }
        : {}),
      plan: input.plan,
    });
    const variant =
      decision?.state === 'active'
        ? 'treatment'
        : assignPatchExperimentVariant({
            patchId: patch.id,
            runId: input.runId,
            taskSignature,
            environmentFingerprint: input.environmentFingerprint,
          });
    const terminalAcceptNames = [
      ...new Set((input.plan?.terminalAccept ?? []).map((spec) => spec.name)),
    ].sort();
    const guidanceContext =
      variant === 'treatment' ? await this.guidanceContext(patch, terminalAcceptNames) : '';
    const exposureId = `experiment-exposure:${patch.id}:${patch.revision}:${input.runId}`;
    const guidanceHash = guidanceContext ? `sha256:${sha256(guidanceContext)}` : undefined;
    const assignment: PatchExperimentAssignment = {
      schemaVersion: 1,
      kind: 'assignment',
      id: `experiment-assignment:${patch.id}:${input.runId}`,
      patchId: patch.id,
      patchRevision: patch.revision,
      skill: patch.skill,
      environmentFingerprint: input.environmentFingerprint,
      ...(patch.environmentIdentityVersion
        ? {
            environmentIdentityVersion: patch.environmentIdentityVersion,
            environmentCompleteness: patch.environmentCompleteness,
          }
        : {}),
      sessionKey: input.sessionKey,
      runId: input.runId,
      taskSignature,
      variant,
      exposed: variant === 'treatment' && Boolean(guidanceContext),
      exposureId,
      ...(guidanceHash ? { guidanceHash } : {}),
      terminalAcceptNames,
      executionDomain,
      realEvidenceEligible: input.realEvidenceEligible === true,
      timestamp: new Date().toISOString(),
      hypothesis: this.deps.hypothesis ?? 'success_superiority',
      costMetrics: this.deps.costMetrics ?? ['retries', 'toolCalls', 'durationMs', 'tokens'],
      experimentConfigHash: `sha256:${sha256(
        JSON.stringify({
          hypothesis: this.deps.hypothesis ?? 'success_superiority',
          costMetrics: this.deps.costMetrics ?? ['retries', 'toolCalls', 'durationMs', 'tokens'],
          thresholds: this.thresholds,
        })
      )}`,
    };
    await this.deps.experimentLog.append(assignment);
    return this.preparedWithReceipt(assignment, guidanceContext);
  }

  async observeTerminal(input: {
    terminalEntry: TerminalVerdictEntry;
    experiences: ExperienceEntry[];
    corrections?: number;
    safetyFailed?: boolean;
  }): Promise<{ outcome: PatchExperimentOutcome; decision: PatchExperimentDecision } | null> {
    const terminal = input.terminalEntry;
    if (terminal.schemaVersion !== 2 || !terminal.taskId || !terminal.runId) return null;
    const assignment = await this.deps.experimentLog.assignmentForRun(terminal.runId);
    if (
      !assignment ||
      assignment.skill !== terminal.skill ||
      (terminal.attribution !== 'single-skill' && terminal.attribution !== 'single-owner-step')
    )
      return null;
    const trustedExperiences = input.experiences.filter(
      (entry) =>
        entry.schemaVersion === 2 &&
        entry.taskId === terminal.taskId &&
        entry.runId === terminal.runId
    );
    if (!trustedExperiences.length) return null;
    const evidenceId = terminal.evidenceId ?? terminal.id;
    const outcomeId = `experiment-outcome:${assignment.patchId}:${terminal.taskId}:${terminal.runId}:${evidenceId}`;
    const existing = (await this.deps.experimentLog.readAll()).find(
      (record): record is PatchExperimentOutcome =>
        record.kind === 'outcome' && record.id === outcomeId
    );
    if (existing) {
      const decision = await this.deps.experimentLog.latestDecision(assignment.patchId);
      return decision ? { outcome: existing, decision } : null;
    }

    const terminalEntries = (await this.deps.terminalVerdictLog?.readAll()) ?? [];
    const failedEvidence = new Set(
      terminalEntries
        .filter(
          (entry) =>
            entry.schemaVersion === 2 &&
            entry.taskId === terminal.taskId &&
            entry.runId === terminal.runId &&
            entry.verdict === 'fail' &&
            entry.evidenceId
        )
        .map((entry) => entry.evidenceId!)
    );
    const retries = Math.max(
      0,
      failedEvidence.size - (terminal.verdict === 'fail' && failedEvidence.has(evidenceId) ? 1 : 0)
    );
    const usage = await this.readRunUsage(terminal.runId);
    const learningEvents = (await this.deps.learningEventLog?.readAll()) ?? [];
    const failureClasses = [
      ...new Set(
        learningEvents
          .filter(
            (entry) =>
              entry.taskId === terminal.taskId &&
              entry.runId === terminal.runId &&
              entry.failureClass
          )
          .map((entry) => entry.failureClass!)
      ),
    ];
    const startedAt = earliestTimestamp(trustedExperiences);
    const terminalAt = Date.parse(terminal.timestamp);
    const durationMs =
      startedAt !== undefined && Number.isFinite(terminalAt)
        ? Math.max(0, terminalAt - startedAt)
        : trustedExperiences.reduce((sum, entry) => sum + Math.max(0, entry.durationMs), 0);
    const safetyFailed =
      terminal.safetyFailed === true ||
      input.safetyFailed === true ||
      (terminal.safetyFailed === undefined &&
        /(?:^|[_:\s-])(?:safety|unsafe)(?:$|[_:\s-])/i.test(terminal.reason));
    const exposure = await this.deps.experimentLog.exposureForRun(terminal.runId);
    const exposureValid = Boolean(
      exposure &&
      exposure.assignmentId === assignment.id &&
      exposure.exposureId === assignment.exposureId &&
      exposure.variant === assignment.variant &&
      (assignment.variant === 'treatment'
        ? exposure.injected === true &&
          Boolean(assignment.guidanceHash) &&
          exposure.guidanceHash === assignment.guidanceHash
        : exposure.injected === false && !exposure.guidanceHash)
    );
    const domainEligible =
      !requiresRealDeviceEvidence(assignment.skill) ||
      (isRealEvidenceEligible(assignment) &&
        isRealEvidenceEligible(terminal) &&
        trustedExperiences.every((entry) => isRealEvidenceEligible(entry)));
    const eligibleOutcome = exposureValid && domainEligible;
    const exclusionReason = !exposureValid
      ? assignment.variant === 'control'
        ? 'control_contaminated_or_receipt_missing'
        : 'treatment_exposure_unproven'
      : !domainEligible
        ? 'real_evidence_ineligible'
        : undefined;
    const outcome: PatchExperimentOutcome = {
      schemaVersion: 1,
      kind: 'outcome',
      outcomeSource: 'terminal-v2',
      id: outcomeId,
      patchId: assignment.patchId,
      patchRevision: assignment.patchRevision,
      skill: assignment.skill,
      environmentFingerprint: assignment.environmentFingerprint,
      ...(assignment.environmentIdentityVersion
        ? {
            environmentIdentityVersion: assignment.environmentIdentityVersion,
            environmentCompleteness: assignment.environmentCompleteness,
          }
        : {}),
      assignmentId: assignment.id,
      sessionKey: terminal.sessionKey,
      taskId: terminal.taskId,
      runId: terminal.runId,
      evidenceId,
      variant: assignment.variant,
      terminalVerdict: terminal.verdict,
      success: terminal.verdict === 'pass',
      retries,
      toolCalls: new Set(
        trustedExperiences.map((entry) => entry.evidenceId ?? entry.toolCallId ?? entry.id)
      ).size,
      corrections: terminal.correctionCount ?? input.corrections ?? retries,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: usage.estimatedCostUsd }),
      failureClasses,
      safetyFailed,
      eligible: eligibleOutcome,
      ...(exclusionReason ? { exclusionReason } : {}),
      ...(exposure ? { exposureReceiptId: exposure.id } : {}),
      executionDomain: terminal.executionDomain,
      realEvidenceEligible: terminal.realEvidenceEligible,
      timestamp: terminal.timestamp,
    };
    await this.deps.experimentLog.append(outcome);
    const decision = await this.evaluatePatch(assignment.patchId);
    return { outcome, decision };
  }

  async evaluatePatch(patchId: string): Promise<PatchExperimentDecision> {
    const records = await this.deps.experimentLog.readAll();
    const outcomes = latestOutcomes(
      records.filter(
        (record): record is PatchExperimentOutcome =>
          record.kind === 'outcome' && record.patchId === patchId
      )
    );
    const control = summarizeArm(
      outcomes.filter((entry) => entry.variant === 'control'),
      this.thresholds.wilsonZ
    );
    const treatment = summarizeArm(
      outcomes.filter((entry) => entry.variant === 'treatment'),
      this.thresholds.wilsonZ
    );
    const newFailureClasses = Object.keys(treatment.failureClasses)
      .filter((failureClass) => !(failureClass in control.failureClasses))
      .sort();
    treatment.newFailureClasses = newFailureClasses;
    let state: PatchExperimentLifecycle = 'shadow';
    let reasonCode = 'insufficient_samples';
    const safetyRegression = treatment.safetyFailures > 0;
    const enoughSamples =
      control.total >= this.thresholds.minSamplesPerArm &&
      treatment.total >= this.thresholds.minSamplesPerArm;
    const costPassed =
      control.averageCostUsd === undefined ||
      treatment.averageCostUsd === undefined ||
      (control.averageCostUsd === 0
        ? treatment.averageCostUsd === 0
        : treatment.averageCostUsd <= control.averageCostUsd * this.thresholds.maxCostRatio);
    const retryPassed =
      treatment.averageRetries <= control.averageRetries + this.thresholds.maxRetryIncrease;
    const assignments = records.filter(
      (record): record is PatchExperimentAssignment =>
        record.kind === 'assignment' && record.patchId === patchId
    );
    const frozenHypotheses = new Set(
      assignments.map((entry) => entry.hypothesis ?? 'success_superiority')
    );
    const frozenConfigHashes = new Set(
      assignments.map((entry) => entry.experimentConfigHash ?? 'legacy')
    );
    const hypothesis = [...frozenHypotheses][0] ?? 'success_superiority';
    const selectedCostMetrics = assignments[0]?.costMetrics ?? [
      'retries',
      'toolCalls',
      'durationMs',
      'tokens',
    ];
    const frozenCostMetricSets = new Set(
      assignments.map((entry) =>
        JSON.stringify(entry.costMetrics ?? ['retries', 'toolCalls', 'durationMs', 'tokens'])
      )
    );
    const configFrozen =
      frozenHypotheses.size <= 1 && frozenConfigHashes.size <= 1 && frozenCostMetricSets.size <= 1;
    const controlOutcomes = outcomes.filter(
      (entry) => entry.variant === 'control' && entry.eligible !== false
    );
    const treatmentOutcomes = outcomes.filter(
      (entry) => entry.variant === 'treatment' && entry.eligible !== false
    );
    const metricPairs: Array<[string, (entry: PatchExperimentOutcome) => number]> = [
      ['retries', (entry) => entry.retries],
      ['toolCalls', (entry) => entry.toolCalls],
      ['durationMs', (entry) => entry.durationMs],
      ['tokens', (entry) => entry.inputTokens + entry.outputTokens],
    ];
    const improvedCostMetrics = metricPairs
      .filter(
        ([name, select]) =>
          selectedCostMetrics.includes(name as PatchExperimentCostMetric) &&
          costMetricSuperior(
            controlOutcomes.map(select),
            treatmentOutcomes.map(select),
            this.thresholds.wilsonZ,
            this.thresholds.minCostImprovementRatio
          )
      )
      .map(([name]) => name);
    const resourceGuardPassed = metricPairs.every(([, select]) => {
      const baseline = average(controlOutcomes.map(select));
      const candidate = average(treatmentOutcomes.map(select));
      return baseline === 0
        ? candidate === 0
        : candidate <= baseline * this.thresholds.maxCostRatio;
    });
    const successNoninferior =
      treatment.wilsonLow + this.thresholds.successNoninferiorityMargin >= control.wilsonLow;
    if (!configFrozen) {
      reasonCode = 'experiment_configuration_changed';
    } else if (safetyRegression) {
      state = 'demoted';
      reasonCode = 'treatment_safety_failure';
    } else if (newFailureClasses.length > 0) {
      state = 'demoted';
      reasonCode = 'treatment_new_failure_class';
    } else if (enoughSamples && treatment.wilsonHigh < control.wilsonLow) {
      state = 'demoted';
      reasonCode = 'credible_success_regression';
    } else if (
      enoughSamples &&
      hypothesis === 'success_noninferiority_cost_superiority' &&
      successNoninferior &&
      improvedCostMetrics.length >= this.thresholds.minCostMetricsImproved &&
      costPassed &&
      retryPassed &&
      resourceGuardPassed
    ) {
      state = 'active';
      reasonCode = 'credible_cost_benefit_under_success_noninferiority';
    } else if (
      enoughSamples &&
      hypothesis === 'success_superiority' &&
      treatment.wilsonLow > control.wilsonHigh &&
      costPassed &&
      retryPassed
    ) {
      state = 'active';
      reasonCode = 'credible_benefit';
    } else if (enoughSamples && !costPassed) {
      reasonCode = 'cost_guardrail_failed';
    } else if (enoughSamples && !retryPassed) {
      reasonCode = 'retry_guardrail_failed';
    } else if (enoughSamples && !resourceGuardPassed) {
      reasonCode = 'resource_guardrail_failed';
    } else if (enoughSamples) {
      reasonCode = 'effect_inconclusive';
    }

    let rollbackApplied: boolean | undefined;
    if (state === 'demoted') {
      try {
        rollbackApplied = (await this.deps.rollback?.(patchId)) ?? false;
      } catch {
        rollbackApplied = false;
      }
      if (!rollbackApplied) {
        state = 'shadow';
        reasonCode = 'rollback_failed';
      }
    }
    const previous = await this.deps.experimentLog.latestDecision(patchId);
    const patch = (await this.deps.patchLog.latest(patchId))[0];
    const sourceOutcomeIds = outcomes.map((entry) => entry.id).sort();
    const revision = (previous?.revision ?? 0) + 1;
    const decision: PatchExperimentDecision = {
      schemaVersion: 1,
      kind: 'decision',
      id: `experiment-decision:${patchId}:${sha256(`${state}\0${reasonCode}\0${sourceOutcomeIds.join('\0')}`).slice(0, 20)}`,
      patchId,
      patchRevision: patch?.revision ?? previous?.patchRevision ?? 0,
      skill: patch?.skill ?? previous?.skill ?? 'unknown',
      environmentFingerprint:
        patch?.environmentFingerprint ?? previous?.environmentFingerprint ?? 'unknown',
      ...((patch?.environmentIdentityVersion ?? previous?.environmentIdentityVersion)
        ? {
            environmentIdentityVersion: (patch?.environmentIdentityVersion ??
              previous?.environmentIdentityVersion)!,
            environmentCompleteness:
              patch?.environmentCompleteness ?? previous?.environmentCompleteness,
          }
        : {}),
      executionDomain: patch?.executionDomain ?? previous?.executionDomain,
      realEvidenceEligible: patch?.realEvidenceEligible ?? previous?.realEvidenceEligible,
      revision,
      state,
      reasonCode,
      control,
      treatment,
      sourceOutcomeIds,
      hypothesis,
      experimentConfigHash: [...frozenConfigHashes][0],
      costMetrics: selectedCostMetrics,
      improvedCostMetrics,
      ...(rollbackApplied === undefined ? {} : { rollbackApplied }),
      timestamp: new Date().toISOString(),
    };
    const appended = await this.deps.experimentLog.append(decision);
    return appended
      ? decision
      : ((await this.deps.experimentLog.latestDecision(patchId)) ?? decision);
  }

  /** Record an assigned agent-process failure using trusted v2 run evidence. */
  async recordRunProcessFailure(input: {
    patchId: string;
    runId: string;
    experiences: ExperienceEntry[];
    reasonCode?: string;
    finishedAt?: string;
  }): Promise<{ outcome: PatchExperimentOutcome; decision: PatchExperimentDecision } | null> {
    const reasonCode = input.reasonCode ?? 'agent_process_exit_nonzero';
    const records = await this.deps.experimentLog.readAll();
    const runOutcomes = records
      .filter(
        (record): record is PatchExperimentOutcome =>
          record.kind === 'outcome' && record.patchId === input.patchId
      )
      .filter((record) => record.runId === input.runId);
    const processFinishedAt = input.finishedAt ?? new Date().toISOString();
    const existingProcessOutcome = runOutcomes.find(
      (record) =>
        record.outcomeSource === 'agent-process' &&
        record.failureClasses.includes(reasonCode) &&
        record.processFinishedAt === processFinishedAt &&
        Boolean(record.exposureReceiptId)
    );
    if (existingProcessOutcome) {
      return { outcome: existingProcessOutcome, decision: await this.evaluatePatch(input.patchId) };
    }
    const terminalOutcome = runOutcomes
      .filter(
        (record) =>
          record.outcomeSource !== 'agent-process' &&
          !record.id.startsWith('experiment-outcome-exclusion:')
      )
      .at(-1);
    const assignment = records.find(
      (record): record is PatchExperimentAssignment =>
        record.kind === 'assignment' &&
        record.patchId === input.patchId &&
        record.runId === input.runId
    );
    const exposure = records.find((record): record is PatchExperimentExposure =>
      Boolean(
        record.kind === 'exposure' &&
        assignment &&
        record.assignmentId === assignment.id &&
        record.runId === input.runId
      )
    );
    if (!assignment || !exposure) return null;
    const trustedExperiences = input.experiences.filter(
      (entry) =>
        entry.schemaVersion === 2 &&
        entry.runId === input.runId &&
        entry.taskId &&
        isRealEvidenceEligible(entry)
    );
    const taskId = terminalOutcome?.taskId ?? trustedExperiences.at(-1)?.taskId;
    const sessionKey = terminalOutcome?.sessionKey ?? trustedExperiences.at(-1)?.sessionKey;
    if (!taskId || !sessionKey || trustedExperiences.length === 0) return null;
    const exposureValid = Boolean(
      exposure.assignmentId === assignment.id &&
      exposure.exposureId === assignment.exposureId &&
      exposure.variant === assignment.variant &&
      (assignment.variant === 'treatment'
        ? exposure.injected === true &&
          Boolean(assignment.guidanceHash) &&
          exposure.guidanceHash === assignment.guidanceHash
        : exposure.injected === false && !exposure.guidanceHash)
    );
    const domainEligible =
      !requiresRealDeviceEvidence(assignment.skill) ||
      (isRealEvidenceEligible(assignment) &&
        trustedExperiences.every((entry) => isRealEvidenceEligible(entry)));
    const usage = await this.readRunUsage(input.runId);
    const startedAt = earliestTimestamp(trustedExperiences);
    const parsedFinishedAt = Date.parse(processFinishedAt);
    const finishedAt = Number.isFinite(parsedFinishedAt) ? parsedFinishedAt : Date.now();
    const outcome: PatchExperimentOutcome = {
      ...(terminalOutcome ?? {
        schemaVersion: 1,
        kind: 'outcome',
        patchId: assignment.patchId,
        patchRevision: assignment.patchRevision,
        skill: assignment.skill,
        environmentFingerprint: assignment.environmentFingerprint,
        environmentIdentityVersion: assignment.environmentIdentityVersion,
        environmentCompleteness: assignment.environmentCompleteness,
        assignmentId: assignment.id,
        sessionKey,
        taskId,
        runId: input.runId,
        evidenceId: `agent-process:${input.runId}`,
        variant: assignment.variant,
        retries: 0,
        toolCalls: new Set(
          trustedExperiences.map((entry) => entry.evidenceId ?? entry.toolCallId ?? entry.id)
        ).size,
        corrections: 0,
        durationMs: startedAt === undefined ? 0 : Math.max(0, finishedAt - startedAt),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.estimatedCostUsd === undefined
          ? {}
          : { estimatedCostUsd: usage.estimatedCostUsd }),
        safetyFailed: false,
        exposureReceiptId: exposure.id,
        executionDomain: assignment.executionDomain,
        realEvidenceEligible: assignment.realEvidenceEligible,
      }),
      id: `experiment-outcome-process-failure:${input.patchId}:${input.runId}:${sha256(`${reasonCode}\0${processFinishedAt}\0${exposure.id}`).slice(0, 16)}`,
      outcomeSource: 'agent-process',
      processFinishedAt,
      terminalVerdict: 'fail',
      success: false,
      failureClasses: [...new Set([...(terminalOutcome?.failureClasses ?? []), reasonCode])].sort(),
      eligible: exposureValid && domainEligible,
      ...(!(exposureValid && domainEligible)
        ? {
            exclusionReason: !exposureValid
              ? 'experiment_exposure_invalid'
              : 'real_evidence_ineligible',
          }
        : {}),
      timestamp: new Date().toISOString(),
    };
    await this.deps.experimentLog.append(outcome);
    return { outcome, decision: await this.evaluatePatch(input.patchId) };
  }

  async formatReport(patchId: string): Promise<string> {
    const decision =
      (await this.deps.experimentLog.latestDecision(patchId)) ??
      (await this.evaluatePatch(patchId));
    const arm = (label: string, value: PatchExperimentArmSummary) =>
      `${label}: n=${value.total}, success=${(value.successRate * 100).toFixed(1)}%, retries=${value.averageRetries.toFixed(2)}, tools=${value.averageToolCalls.toFixed(2)}, safety=${value.safetyFailures}`;
    return [
      `Patch experiment ${patchId}: ${decision.state} (${decision.reasonCode})`,
      arm('control', decision.control),
      arm('treatment', decision.treatment),
    ].join('\n');
  }

  private async preparedFromAssignment(
    assignment: PatchExperimentAssignment
  ): Promise<PreparedPatchExperiment> {
    const patch = (await this.deps.patchLog.latest(assignment.patchId))[0];
    const guidanceContext =
      assignment.variant === 'treatment' && patch
        ? await this.guidanceContext(patch, assignment.terminalAcceptNames ?? [])
        : '';
    return this.preparedWithReceipt(assignment, guidanceContext);
  }

  private preparedWithReceipt(
    assignment: PatchExperimentAssignment,
    guidanceContext: string
  ): PreparedPatchExperiment {
    return {
      assignment,
      guidanceContext,
      includeTrustedObservation: assignment.exposed && Boolean(guidanceContext),
      confirmExposure: async () => {
        const injected = assignment.variant === 'treatment' && Boolean(guidanceContext);
        const receipt: PatchExperimentExposure = {
          schemaVersion: 1,
          kind: 'exposure',
          id: `experiment-exposure-receipt:${assignment.patchId}:${assignment.runId}`,
          patchId: assignment.patchId,
          patchRevision: assignment.patchRevision,
          skill: assignment.skill,
          environmentFingerprint: assignment.environmentFingerprint,
          ...(assignment.environmentIdentityVersion
            ? {
                environmentIdentityVersion: assignment.environmentIdentityVersion,
                environmentCompleteness: assignment.environmentCompleteness,
              }
            : {}),
          executionDomain: assignment.executionDomain,
          realEvidenceEligible: assignment.realEvidenceEligible,
          assignmentId: assignment.id,
          sessionKey: assignment.sessionKey,
          runId: assignment.runId,
          exposureId: assignment.exposureId,
          variant: assignment.variant,
          injected,
          location: 'memory-context',
          ...(injected && assignment.guidanceHash ? { guidanceHash: assignment.guidanceHash } : {}),
          timestamp: new Date().toISOString(),
        };
        await this.deps.experimentLog.append(receipt);
      },
    };
  }

  private async guidanceContext(
    patch: CandidatePatchRecord,
    terminalAcceptNames: string[]
  ): Promise<string> {
    if (!patch.artifactPath) return '';
    const learnedRoot = `${path.resolve(getMossWorkspacePaths(this.deps.workspaceDir).learnedSkillsDir)}${path.sep}`;
    const artifactPath = path.resolve(patch.artifactPath);
    if (
      !artifactPath.startsWith(learnedRoot) ||
      path.basename(artifactPath).toUpperCase() !== 'SKILL.MD'
    )
      return '';
    try {
      const body = parseSkillDocument(await fs.readFile(artifactPath, 'utf8')).body;
      if (!body) return '';
      const scopedChecks = terminalAcceptNames.length
        ? terminalAcceptNames.map((name) => `\`${name}\``).join(', ')
        : '(none declared)';
      const scopedBody = body.replace(
        /^Available recovery checks:.*$/m,
        `Plan-scoped terminal checks: ${scopedChecks}. Recipe-only checks were removed from this Treatment context.`
      );
      return [
        '<moss_patch_experiment>',
        `Treatment guidance for patch ${patch.id}; this is guidance, not proof.`,
        'Composition rule: preserve the base Skill safety invariants and terminal verification, but execute this validated environment-specific recovery fast path instead of repeating any parameter-discovery steps it explicitly supersedes.',
        'If an objective command rejects a verified binding, stop the fast path and fall back to the full base Skill discovery flow.',
        `Current Plan terminalAccept is the complete machine-check boundary: ${scopedChecks}. Do not execute or claim recipe-only terminal checks.`,
        scopedBody,
        '</moss_patch_experiment>',
      ].join('\n');
    } catch {
      return '';
    }
  }

  private async readRunUsage(runId: string): Promise<{
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  }> {
    let records: LLMUsageRecord[] = [];
    try {
      records = (await this.deps.readUsage?.()) ?? [];
    } catch {
      records = [];
    }
    const matched = records.filter(
      (entry) =>
        entry.runId === runId ||
        entry.runId.startsWith(`${runId}/`) ||
        entry.runId.startsWith(`${runId}:`)
    );
    const costs = matched.flatMap((entry) =>
      entry.estimatedCostUsd === undefined ? [] : [entry.estimatedCostUsd]
    );
    return {
      inputTokens: matched.reduce(
        (sum, entry) =>
          sum + entry.inputTokens + (entry.cacheReadTokens ?? 0) + (entry.cacheCreationTokens ?? 0),
        0
      ),
      outputTokens: matched.reduce((sum, entry) => sum + entry.outputTokens, 0),
      ...(costs.length === matched.length && costs.length
        ? { estimatedCostUsd: costs.reduce((sum, value) => sum + value, 0) }
        : {}),
    };
  }
}
