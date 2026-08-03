import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TerminalVerdictEntry, TerminalVerdictLog } from '../acceptance/terminal-verdict-log.js';
import type { LLMUsageRecord } from '../observability/llm-usage.js';
import type { Plan } from '../plan-execute/plan-execute-controller.js';
import { SkillRegistry } from '../skills/registry.js';
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
} from './patch-experiment-log.js';
import { isRealEvidenceEligible, requiresRealDeviceEvidence, type ExecutionDomain } from './evidence-trust.js';

export interface PatchExperimentThresholds {
  minSamplesPerArm: number;
  wilsonZ: number;
  maxCostRatio: number;
  maxRetryIncrease: number;
}

export const DEFAULT_PATCH_EXPERIMENT_THRESHOLDS: PatchExperimentThresholds = {
  minSamplesPerArm: 20,
  wilsonZ: 1.96,
  maxCostRatio: 1.2,
  maxRetryIncrease: 0.25,
};

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
  const context = [input.digest, input.prepared.guidanceContext, observation].filter(Boolean).join('\n\n');
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
  return registry.list().filter((skill) => skill.enabled).filter((skill) => {
    const escaped = skill.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`, 'i').test(normalized);
  }).map((skill) => skill.name);
}

export function createPatchExperimentTaskSignature(input: {
  userMessage: string;
  skill: string;
  environmentFingerprint: string;
  plan?: Plan | null;
}): string {
  const machinePlan = input.plan ? {
    expectedTools: input.plan.steps.flatMap((step) => step.expectedTools ?? []).sort(),
    expectedAccept: input.plan.steps.flatMap((step) => step.expectedAccept ?? []).sort(),
    terminalAccept: input.plan.terminalAccept ?? [],
  } : undefined;
  return `sha256:${sha256(JSON.stringify({
    intent: normalizedIntent(input.userMessage),
    skill: input.skill,
    environmentFingerprint: input.environmentFingerprint,
    machinePlan,
  }))}`;
}

export function assignPatchExperimentVariant(input: {
  patchId: string;
  runId: string;
  taskSignature: string;
  environmentFingerprint: string;
}): PatchExperimentVariant {
  const digest = sha256(`${input.patchId}\0${input.runId}\0${input.taskSignature}\0${input.environmentFingerprint}`);
  return Number.parseInt(digest.slice(-2), 16) % 2 === 0 ? 'control' : 'treatment';
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
  const costs = eligible.flatMap((entry) => entry.estimatedCostUsd === undefined ? [] : [entry.estimatedCostUsd]);
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

function latestOutcomes(records: PatchExperimentOutcome[]): PatchExperimentOutcome[] {
  const latest = new Map<string, PatchExperimentOutcome>();
  for (const record of records) {
    const key = `${record.patchId}\0${record.taskId}\0${record.runId}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(record.timestamp) >= Date.parse(previous.timestamp)) latest.set(key, record);
  }
  return [...latest.values()];
}

function readSkillBody(raw: string): string {
  return raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function latestTimestamp(entries: ExperienceEntry[]): number | undefined {
  const values = entries.map((entry) => Date.parse(entry.timestamp)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : undefined;
}

export class TrustedSkillExperimentCoordinator {
  private readonly thresholds: PatchExperimentThresholds;

  constructor(private readonly deps: {
    workspaceDir: string;
    patchLog: CandidatePatchLog;
    experimentLog: PatchExperimentLog;
    terminalVerdictLog?: Pick<TerminalVerdictLog, 'readAll'>;
    learningEventLog?: Pick<LearningEventLog, 'readAll'>;
    readUsage?: () => Promise<LLMUsageRecord[]>;
    rollback?: (patchId: string) => Promise<boolean>;
    skillRegistry?: SkillRegistry;
    thresholds?: Partial<PatchExperimentThresholds>;
  }) {
    this.thresholds = { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS, ...deps.thresholds };
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
    if (existing) return this.preparedFromAssignment(existing);

    const registry = this.deps.skillRegistry ?? new SkillRegistry({ workspaceDir: this.deps.workspaceDir });
    const exactReferences = input.skill ? [] : explicitlyNamedSkills(registry, input.userMessage);
    const matchedSkills = input.skill
      ? [input.skill]
      : exactReferences.length === 1
        ? exactReferences
        : [...new Set(registry.matchByText(input.userMessage).filter((skill) => skill.enabled).map((skill) => skill.name))];
    if (matchedSkills.length !== 1) return null;
    const latestPatches = await this.deps.patchLog.latest();
    const eligible = latestPatches.filter((patch) => (
      patch.kind === 'skill-guidance'
      && patch.state === 'published'
      && patch.skill === matchedSkills[0]
      && patch.environmentFingerprint === input.environmentFingerprint
      && Boolean(patch.artifactPath)
    ));
    if (eligible.length !== 1) return null;
    const patch = eligible[0]!;
    const executionDomain = input.executionDomain ?? 'local';
    if (requiresRealDeviceEvidence(patch.skill) && (
      executionDomain !== 'real'
      || input.realEvidenceEligible !== true
      || !isRealEvidenceEligible(patch)
    )) return null;
    const decision = await this.deps.experimentLog.latestDecision(patch.id);
    if (decision?.state === 'demoted') return null;
    const taskSignature = createPatchExperimentTaskSignature({
      userMessage: input.userMessage,
      skill: patch.skill,
      environmentFingerprint: input.environmentFingerprint,
      ...(patch.environmentIdentityVersion ? {
        environmentIdentityVersion: patch.environmentIdentityVersion,
        environmentCompleteness: patch.environmentCompleteness,
      } : {}),
      plan: input.plan,
    });
    const variant = decision?.state === 'active'
      ? 'treatment'
      : assignPatchExperimentVariant({
          patchId: patch.id,
          runId: input.runId,
          taskSignature,
          environmentFingerprint: input.environmentFingerprint,
        });
    const guidanceContext = variant === 'treatment' ? await this.guidanceContext(patch) : '';
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
      ...(patch.environmentIdentityVersion ? {
        environmentIdentityVersion: patch.environmentIdentityVersion,
        environmentCompleteness: patch.environmentCompleteness,
      } : {}),
      sessionKey: input.sessionKey,
      runId: input.runId,
      taskSignature,
      variant,
      exposed: variant === 'treatment' && Boolean(guidanceContext),
      exposureId,
      ...(guidanceHash ? { guidanceHash } : {}),
      executionDomain,
      realEvidenceEligible: input.realEvidenceEligible === true,
      timestamp: new Date().toISOString(),
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
    if (!assignment || assignment.skill !== terminal.skill
      || (terminal.attribution !== 'single-skill' && terminal.attribution !== 'single-owner-step')) return null;
    const trustedExperiences = input.experiences.filter((entry) => (
      entry.schemaVersion === 2 && entry.taskId === terminal.taskId && entry.runId === terminal.runId
    ));
    if (!trustedExperiences.length) return null;
    const evidenceId = terminal.evidenceId ?? terminal.id;
    const outcomeId = `experiment-outcome:${assignment.patchId}:${terminal.taskId}:${terminal.runId}:${evidenceId}`;
    const existing = (await this.deps.experimentLog.readAll()).find(
      (record): record is PatchExperimentOutcome => record.kind === 'outcome' && record.id === outcomeId,
    );
    if (existing) {
      const decision = await this.deps.experimentLog.latestDecision(assignment.patchId);
      return decision ? { outcome: existing, decision } : null;
    }

    const terminalEntries = await this.deps.terminalVerdictLog?.readAll() ?? [];
    const failedEvidence = new Set(terminalEntries.filter((entry) => (
      entry.schemaVersion === 2
      && entry.taskId === terminal.taskId
      && entry.runId === terminal.runId
      && entry.verdict === 'fail'
      && entry.evidenceId
    )).map((entry) => entry.evidenceId!));
    const retries = Math.max(0, failedEvidence.size - (terminal.verdict === 'fail' && failedEvidence.has(evidenceId) ? 1 : 0));
    const usage = await this.readRunUsage(terminal.runId);
    const learningEvents = await this.deps.learningEventLog?.readAll() ?? [];
    const failureClasses = [...new Set(learningEvents.filter((entry) => (
      entry.taskId === terminal.taskId && entry.runId === terminal.runId && entry.failureClass
    )).map((entry) => entry.failureClass!))];
    const startedAt = latestTimestamp(trustedExperiences);
    const terminalAt = Date.parse(terminal.timestamp);
    const durationMs = startedAt !== undefined && Number.isFinite(terminalAt)
      ? Math.max(0, terminalAt - startedAt)
      : trustedExperiences.reduce((sum, entry) => sum + Math.max(0, entry.durationMs), 0);
    const safetyFailed = terminal.safetyFailed === true
      || input.safetyFailed === true
      || (terminal.safetyFailed === undefined && /(?:^|[_:\s-])(?:safety|unsafe)(?:$|[_:\s-])/i.test(terminal.reason));
    const exposure = await this.deps.experimentLog.exposureForRun(terminal.runId);
    const exposureValid = Boolean(exposure
      && exposure.assignmentId === assignment.id
      && exposure.exposureId === assignment.exposureId
      && exposure.variant === assignment.variant
      && (assignment.variant === 'treatment'
        ? exposure.injected === true
          && Boolean(assignment.guidanceHash)
          && exposure.guidanceHash === assignment.guidanceHash
        : exposure.injected === false && !exposure.guidanceHash));
    const domainEligible = !requiresRealDeviceEvidence(assignment.skill) || (
      isRealEvidenceEligible(assignment)
      && isRealEvidenceEligible(terminal)
      && trustedExperiences.every((entry) => isRealEvidenceEligible(entry))
    );
    const eligibleOutcome = exposureValid && domainEligible;
    const exclusionReason = !exposureValid
      ? (assignment.variant === 'control' ? 'control_contaminated_or_receipt_missing' : 'treatment_exposure_unproven')
      : !domainEligible ? 'real_evidence_ineligible' : undefined;
    const outcome: PatchExperimentOutcome = {
      schemaVersion: 1,
      kind: 'outcome',
      id: outcomeId,
      patchId: assignment.patchId,
      patchRevision: assignment.patchRevision,
      skill: assignment.skill,
      environmentFingerprint: assignment.environmentFingerprint,
      ...(assignment.environmentIdentityVersion ? {
        environmentIdentityVersion: assignment.environmentIdentityVersion,
        environmentCompleteness: assignment.environmentCompleteness,
      } : {}),
      assignmentId: assignment.id,
      sessionKey: terminal.sessionKey,
      taskId: terminal.taskId,
      runId: terminal.runId,
      evidenceId,
      variant: assignment.variant,
      terminalVerdict: terminal.verdict,
      success: terminal.verdict === 'pass',
      retries,
      toolCalls: new Set(trustedExperiences.map((entry) => entry.evidenceId ?? entry.toolCallId ?? entry.id)).size,
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
    const outcomes = latestOutcomes(records.filter(
      (record): record is PatchExperimentOutcome => record.kind === 'outcome' && record.patchId === patchId,
    ));
    const control = summarizeArm(outcomes.filter((entry) => entry.variant === 'control'), this.thresholds.wilsonZ);
    const treatment = summarizeArm(outcomes.filter((entry) => entry.variant === 'treatment'), this.thresholds.wilsonZ);
    const newFailureClasses = Object.keys(treatment.failureClasses)
      .filter((failureClass) => !(failureClass in control.failureClasses))
      .sort();
    treatment.newFailureClasses = newFailureClasses;
    let state: PatchExperimentLifecycle = 'shadow';
    let reasonCode = 'insufficient_samples';
    const safetyRegression = treatment.safetyFailures > 0;
    const enoughSamples = control.total >= this.thresholds.minSamplesPerArm
      && treatment.total >= this.thresholds.minSamplesPerArm;
    const costPassed = control.averageCostUsd === undefined || treatment.averageCostUsd === undefined
      || (control.averageCostUsd === 0
        ? treatment.averageCostUsd === 0
        : treatment.averageCostUsd <= control.averageCostUsd * this.thresholds.maxCostRatio);
    const retryPassed = treatment.averageRetries <= control.averageRetries + this.thresholds.maxRetryIncrease;
    if (safetyRegression) {
      state = 'demoted';
      reasonCode = 'treatment_safety_failure';
    } else if (newFailureClasses.length > 0) {
      state = 'demoted';
      reasonCode = 'treatment_new_failure_class';
    } else if (enoughSamples && treatment.wilsonHigh < control.wilsonLow) {
      state = 'demoted';
      reasonCode = 'credible_success_regression';
    } else if (enoughSamples && treatment.wilsonLow > control.wilsonHigh && costPassed && retryPassed) {
      state = 'active';
      reasonCode = 'credible_benefit';
    } else if (enoughSamples && !costPassed) {
      reasonCode = 'cost_guardrail_failed';
    } else if (enoughSamples && !retryPassed) {
      reasonCode = 'retry_guardrail_failed';
    } else if (enoughSamples) {
      reasonCode = 'effect_inconclusive';
    }

    let rollbackApplied: boolean | undefined;
    if (state === 'demoted') {
      try { rollbackApplied = await this.deps.rollback?.(patchId) ?? false; }
      catch { rollbackApplied = false; }
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
      environmentFingerprint: patch?.environmentFingerprint ?? previous?.environmentFingerprint ?? 'unknown',
      ...(patch?.environmentIdentityVersion ?? previous?.environmentIdentityVersion ? {
        environmentIdentityVersion: (patch?.environmentIdentityVersion ?? previous?.environmentIdentityVersion)!,
        environmentCompleteness: patch?.environmentCompleteness ?? previous?.environmentCompleteness,
      } : {}),
      executionDomain: patch?.executionDomain ?? previous?.executionDomain,
      realEvidenceEligible: patch?.realEvidenceEligible ?? previous?.realEvidenceEligible,
      revision,
      state,
      reasonCode,
      control,
      treatment,
      sourceOutcomeIds,
      ...(rollbackApplied === undefined ? {} : { rollbackApplied }),
      timestamp: new Date().toISOString(),
    };
    const appended = await this.deps.experimentLog.append(decision);
    return appended ? decision : (await this.deps.experimentLog.latestDecision(patchId)) ?? decision;
  }

  async formatReport(patchId: string): Promise<string> {
    const decision = await this.deps.experimentLog.latestDecision(patchId) ?? await this.evaluatePatch(patchId);
    const arm = (label: string, value: PatchExperimentArmSummary) =>
      `${label}: n=${value.total}, success=${(value.successRate * 100).toFixed(1)}%, retries=${value.averageRetries.toFixed(2)}, tools=${value.averageToolCalls.toFixed(2)}, safety=${value.safetyFailures}`;
    return [
      `Patch experiment ${patchId}: ${decision.state} (${decision.reasonCode})`,
      arm('control', decision.control),
      arm('treatment', decision.treatment),
    ].join('\n');
  }

  private async preparedFromAssignment(assignment: PatchExperimentAssignment): Promise<PreparedPatchExperiment> {
    const patch = (await this.deps.patchLog.latest(assignment.patchId))[0];
    const guidanceContext = assignment.variant === 'treatment' && patch ? await this.guidanceContext(patch) : '';
    return this.preparedWithReceipt(assignment, guidanceContext);
  }

  private preparedWithReceipt(
    assignment: PatchExperimentAssignment,
    guidanceContext: string,
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
          ...(assignment.environmentIdentityVersion ? {
            environmentIdentityVersion: assignment.environmentIdentityVersion,
            environmentCompleteness: assignment.environmentCompleteness,
          } : {}),
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

  private async guidanceContext(patch: CandidatePatchRecord): Promise<string> {
    if (!patch.artifactPath) return '';
    const learnedRoot = `${path.resolve(getMossWorkspacePaths(this.deps.workspaceDir).learnedSkillsDir)}${path.sep}`;
    const artifactPath = path.resolve(patch.artifactPath);
    if (!artifactPath.startsWith(learnedRoot) || path.basename(artifactPath).toUpperCase() !== 'SKILL.MD') return '';
    try {
      const body = readSkillBody(await fs.readFile(artifactPath, 'utf8'));
      if (!body) return '';
      return [
        '<moss_patch_experiment>',
        `Treatment guidance for patch ${patch.id}; this is guidance, not proof.`,
        body,
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
    try { records = await this.deps.readUsage?.() ?? []; } catch { records = []; }
    const matched = records.filter((entry) => (
      entry.runId === runId || entry.runId.startsWith(`${runId}/`) || entry.runId.startsWith(`${runId}:`)
    ));
    const costs = matched.flatMap((entry) => entry.estimatedCostUsd === undefined ? [] : [entry.estimatedCostUsd]);
    return {
      inputTokens: matched.reduce((sum, entry) => sum + entry.inputTokens + (entry.cacheReadTokens ?? 0) + (entry.cacheCreationTokens ?? 0), 0),
      outputTokens: matched.reduce((sum, entry) => sum + entry.outputTokens, 0),
      ...(costs.length === matched.length && costs.length
        ? { estimatedCostUsd: costs.reduce((sum, value) => sum + value, 0) }
        : {}),
    };
  }
}
