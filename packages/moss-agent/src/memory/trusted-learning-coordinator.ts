import type { Plan } from '../plan-execute/plan-execute-controller.js';
import type { ExperienceEntry } from './experience-log.js';
import type { MemoryManager } from './memory-manager.js';
import type { TerminalVerdictEntry } from '../acceptance/terminal-verdict-log.js';
import type { TerminalArbitrationResult } from '../acceptance/terminal-arbitrator.js';
import {
  LearningEventLog,
  type LearningEvent,
  type LearningFailureClass,
} from './learning-event-log.js';
import { memoryWarn } from './logger.js';
import {
  compileRecoveryRecipe,
  recoveryRecipeId,
  type RecoveryRecipeLog,
} from './recovery-recipe-log.js';

export interface TrustedLearningInput {
  plan: Plan;
  terminalEntry: TerminalVerdictEntry;
  terminalReasonCode?: string;
  arbitration: TerminalArbitrationResult;
  experiences: ExperienceEntry[];
}

function classifyFailure(input: TrustedLearningInput, priorFailure?: LearningEvent): LearningFailureClass {
  const environments = new Set(
    input.experiences.map((entry) => entry.environmentFingerprint).filter((value) => value && value !== 'unknown'),
  );
  if (
    environments.size > 1
    || (priorFailure
      && priorFailure.environmentFingerprint !== 'unknown'
      && input.terminalEntry.environmentFingerprint !== 'unknown'
      && priorFailure.environmentFingerprint !== input.terminalEntry.environmentFingerprint)
  ) return 'environment_change';
  if (input.arbitration.auditFailed) return 'contract_drift';
  const failed = input.experiences.filter((entry) => entry.verdict === 'fail');
  if (failed.some((entry) => entry.signalSource === 'exit_code' || /exit|command|process/i.test(entry.reasonCode ?? ''))) {
    return 'execution_failure';
  }
  if (failed.length > 0 || input.terminalEntry.verdict === 'fail') return 'acceptance_failure';
  return 'insufficient_evidence';
}

function parseCounts(content: string): { failures: number; recoveries: number } {
  return {
    failures: Number(/failures=(\d+)/.exec(content)?.[1] ?? 0),
    recoveries: Number(/recoveries=(\d+)/.exec(content)?.[1] ?? 0),
  };
}

export class TrustedLearningCoordinator {
  constructor(
    private readonly deps: {
      eventLog: LearningEventLog;
      memoryManager: MemoryManager;
      patchCoordinator?: { observeLearningEvent(event: LearningEvent): Promise<unknown> };
      recipeLog?: RecoveryRecipeLog;
    },
  ) {}

  async observe(input: TrustedLearningInput): Promise<LearningEvent | null> {
    const terminal = input.terminalEntry;
    if (terminal.schemaVersion !== 2 || !terminal.taskId || !terminal.runId || terminal.turn === undefined) return null;
    const trustedExperiences = input.experiences.filter((entry) => entry.schemaVersion === 2);
    if (trustedExperiences.length === 0) return null;
    const existing = await this.deps.eventLog.readAll();
    const priorFailure = [...existing].reverse().find(
      (event) => event.taskId === terminal.taskId && event.runId === terminal.runId && event.outcome === 'failed',
    );
    const isRecovery = terminal.verdict === 'pass'
      && priorFailure
      && priorFailure.evidenceId !== terminal.evidenceId;
    const outcome = terminal.verdict === 'fail'
      ? 'failed'
      : terminal.verdict === 'pass'
        ? isRecovery ? 'recovered' : 'passed'
        : 'unknown';
    const failureClass = outcome === 'failed'
      ? classifyFailure(input, priorFailure)
      : outcome === 'recovered'
        ? priorFailure?.failureClass
        : outcome === 'unknown'
          ? 'insufficient_evidence'
          : undefined;
    const experienceIds = trustedExperiences.map((entry) => entry.id);
    const event: LearningEvent = {
      schemaVersion: 1,
      id: `learn:${terminal.taskId}:${terminal.runId}:${terminal.turn}:${terminal.evidenceId}:${terminal.verdict}`,
      sessionKey: terminal.sessionKey,
      taskId: terminal.taskId,
      runId: terminal.runId,
      turn: terminal.turn,
      planVersion: terminal.planVersion ?? input.plan.version,
      ...((terminal.attribution === 'single-skill' || terminal.attribution === 'single-owner-step') && terminal.skill !== 'unknown'
        ? { skill: terminal.skill }
        : {}),
      skills: terminal.skills ?? [],
      attribution: terminal.attribution ?? 'none',
      ...(terminal.attributedStepIds ? { attributedStepIds: terminal.attributedStepIds } : {}),
      environmentFingerprint: terminal.environmentFingerprint ?? 'unknown',
      ...(terminal.environmentIdentityVersion ? {
        environmentIdentityVersion: terminal.environmentIdentityVersion,
        environmentCompleteness: terminal.environmentCompleteness,
      } : {}),
      executionDomain: terminal.executionDomain,
      realEvidenceEligible: terminal.realEvidenceEligible,
      outcome,
      ...(failureClass ? { failureClass } : {}),
      evidenceId: terminal.evidenceId ?? `terminal:${terminal.taskId}:${terminal.runId}:${terminal.turn}`,
      experienceIds,
      ...(isRecovery && priorFailure ? { previousFailureId: priorFailure.id } : {}),
      reasonCode: input.terminalReasonCode ?? terminal.reason,
      toolSequence: trustedExperiences.map((entry) => entry.tool).filter(Boolean),
      timestamp: terminal.timestamp,
    };
    if (isRecovery && this.deps.recipeLog) {
      try {
        const recipeId = recoveryRecipeId(event);
        const previous = (await this.deps.recipeLog.latest(recipeId))[0];
        const relatedRecoveries = existing.filter((candidate) => (
          candidate.outcome === 'recovered'
          && candidate.skill === event.skill
          && candidate.environmentFingerprint === event.environmentFingerprint
          && candidate.failureClass === event.failureClass
        ));
        const recipe = compileRecoveryRecipe({ event, experiences: trustedExperiences, relatedRecoveries, previous });
        if (recipe) {
          await this.deps.recipeLog.append(recipe);
          event.recoveryRecipeId = recipe.id;
          event.recoveryOperations = recipe.steps.map((step) => step.operation);
        }
      } catch (error) {
        memoryWarn('recovery recipe compilation failed:', error);
      }
    }
    const appended = await this.deps.eventLog.append(event);
    if (!appended) return null;
    if (event.outcome === 'failed' || event.outcome === 'recovered') await this.projectObservation(event);
    if (this.deps.patchCoordinator) {
      try { await this.deps.patchCoordinator.observeLearningEvent(event); }
      catch (error) { memoryWarn('trusted patch coordinator failed:', error); }
    }
    return event;
  }

  private async projectObservation(event: LearningEvent): Promise<void> {
    if (!event.failureClass) return;
    const subject = (event.attribution === 'single-skill' || event.attribution === 'single-owner-step') && event.skill
      ? event.skill
      : `task-${event.taskId}`;
    const topic = `learning:v2:${subject}:${event.environmentFingerprint}:${event.failureClass}`;
    try {
      const memories = await this.deps.memoryManager.getAll();
      const existing = memories.find((entry) => entry.trust === 'observation' && entry.topic === topic);
      const counts = parseCounts(existing?.content ?? '');
      const failures = counts.failures + (event.outcome === 'failed' ? 1 : 0);
      const recoveries = counts.recoveries + (event.outcome === 'recovered' ? 1 : 0);
      const status = event.outcome === 'recovered'
        ? 'Recovered with fresh objective evidence; reuse the verified tool sequence.'
        : event.failureClass === 'contract_drift'
          ? 'Contract pending review: step predicates passed but terminal acceptance failed.'
          : 'This approach was rejected by terminal evidence; do not claim success without new evidence.';
      const content = [
        'Trusted learning observation',
        `subject=${subject}`,
        `environment=${event.environmentFingerprint}`,
        `failureClass=${event.failureClass}`,
        `failures=${failures}`,
        `recoveries=${recoveries}`,
        `status=${status}`,
        `lastEvidence=${event.evidenceId}`,
        `lastReason=${event.reasonCode}`,
        event.recoveryRecipeId ? `recoveryRecipe=${event.recoveryRecipeId}` : undefined,
        event.recoveryOperations?.length ? `recoveryOperations=${event.recoveryOperations.join(' -> ')}` : undefined,
        !event.recoveryRecipeId && event.toolSequence?.length ? `toolSequence=${event.toolSequence.join(' -> ')}` : undefined,
      ].filter(Boolean).join(' | ');
      if (existing) await this.deps.memoryManager.update(existing.id, { content, trust: 'observation' });
      else await this.deps.memoryManager.add(content, 'memory', undefined, { trust: 'observation', scope: 'workspace', topic });
    } catch (error) {
      memoryWarn('trusted learning observation projection failed:', error);
    }
  }
}

export async function recallTrustedLearningObservations(
  memoryManager: MemoryManager,
  input: { skill: string; environmentFingerprint: string; maxEntries?: number; maxChars?: number },
): Promise<string> {
  if (!input.skill || input.environmentFingerprint === 'unknown') return '';
  const prefix = `learning:v2:${input.skill}:${input.environmentFingerprint}:`;
  const entries = (await memoryManager.getAll())
    .filter((entry) => entry.trust === 'observation' && !entry.stale && entry.topic?.startsWith(prefix))
    .sort((a, b) => (b.accessedAt ?? b.createdAt) - (a.accessedAt ?? a.createdAt))
    .slice(0, input.maxEntries ?? 3);
  if (entries.length === 0) return '';
  const maxChars = input.maxChars ?? 1200;
  const lines = ['<moss_trusted_learning>', 'Objective lessons for this Skill and environment; verify current state before relying on them.'];
  let length = lines.join('\n').length;
  for (const entry of entries) {
    const line = `- ${entry.content.replace(/\s+/g, ' ').slice(0, 420)}`;
    if (length + line.length + 1 > maxChars) break;
    lines.push(line);
    length += line.length + 1;
  }
  lines.push('</moss_trusted_learning>');
  return lines.length > 3 ? lines.join('\n') : '';
}
