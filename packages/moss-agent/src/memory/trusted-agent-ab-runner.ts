import type { TerminalVerdictEntry } from '../acceptance/terminal-verdict-log.js';
import type { ExperienceEntry } from './experience-log.js';
import type { ExecutionDomain } from './evidence-trust.js';
import type { PatchExperimentLog, PatchExperimentOutcome } from './patch-experiment-log.js';
import {
  buildTrustedPatchExperimentContext,
  type TrustedSkillExperimentCoordinator,
} from './trusted-skill-experiment-coordinator.js';

export interface TrustedAgentAbTask {
  id: string;
  sessionKey: string;
  runId: string;
  userMessage: string;
  skill: string;
  environmentFingerprint: string;
  executionDomain: ExecutionDomain;
  realEvidenceEligible: boolean;
}

export interface TrustedAgentAbExecutionInput {
  task: TrustedAgentAbTask;
  /** This exact context must be passed to the Agent turn by the host. */
  memoryContext: string;
  variant: 'control' | 'treatment';
  exposureId: string;
}

export interface TrustedAgentAbExecutionResult {
  terminalEntry: TerminalVerdictEntry;
  experiences: ExperienceEntry[];
}

export interface TrustedAgentAbRunSummary {
  requested: number;
  executed: number;
  resumed: number;
  excluded: number;
  control: number;
  treatment: number;
  outcomes: PatchExperimentOutcome[];
}

/**
 * Resumable host-side runner. It does not simulate model behavior: callers must
 * inject `memoryContext` into the real Agent turn and return its objective v2
 * terminal/experience records. Exposure receipts are written only after the
 * exact context has been constructed for that callback.
 */
export class TrustedAgentAbRunner {
  constructor(private readonly deps: {
    coordinator: Pick<TrustedSkillExperimentCoordinator, 'prepareRun' | 'observeTerminal'>;
    experimentLog: Pick<PatchExperimentLog, 'readAll'>;
    buildBaseDigest: (task: TrustedAgentAbTask) => Promise<string>;
    loadTrustedObservation?: (task: TrustedAgentAbTask) => Promise<string>;
    executeAgentTask: (input: TrustedAgentAbExecutionInput) => Promise<TrustedAgentAbExecutionResult>;
  }) {}

  async run(tasks: TrustedAgentAbTask[]): Promise<TrustedAgentAbRunSummary> {
    const ids = new Set<string>();
    const messages = new Set<string>();
    for (const task of tasks) {
      if (!task.id || ids.has(task.id)) throw new Error(`duplicate_ab_task_id:${task.id}`);
      ids.add(task.id);
      const normalized = task.userMessage.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!normalized || messages.has(normalized)) throw new Error(`duplicate_ab_task_message:${task.id}`);
      messages.add(normalized);
    }

    const summary: TrustedAgentAbRunSummary = {
      requested: tasks.length, executed: 0, resumed: 0, excluded: 0,
      control: 0, treatment: 0, outcomes: [],
    };
    for (const task of tasks) {
      const existing = (await this.deps.experimentLog.readAll()).find(
        (record): record is PatchExperimentOutcome => record.kind === 'outcome' && record.runId === task.runId,
      );
      if (existing) {
        summary.resumed += 1;
        summary.outcomes.push(existing);
        if (!existing.eligible) summary.excluded += 1;
        else summary[existing.variant] += 1;
        continue;
      }
      const prepared = await this.deps.coordinator.prepareRun({
        sessionKey: task.sessionKey,
        runId: task.runId,
        userMessage: task.userMessage,
        environmentFingerprint: task.environmentFingerprint,
        skill: task.skill,
        executionDomain: task.executionDomain,
        realEvidenceEligible: task.realEvidenceEligible,
      });
      if (!prepared) {
        summary.excluded += 1;
        continue;
      }
      const memoryContext = await buildTrustedPatchExperimentContext({
        digest: await this.deps.buildBaseDigest(task),
        prepared,
        loadTrustedObservation: () => this.deps.loadTrustedObservation?.(task) ?? Promise.resolve(''),
      });
      const execution = await this.deps.executeAgentTask({
        task,
        memoryContext,
        variant: prepared.assignment.variant,
        exposureId: prepared.assignment.exposureId,
      });
      const observed = await this.deps.coordinator.observeTerminal({
        terminalEntry: execution.terminalEntry,
        experiences: execution.experiences,
      });
      summary.executed += 1;
      if (!observed) {
        summary.excluded += 1;
        continue;
      }
      summary.outcomes.push(observed.outcome);
      if (!observed.outcome.eligible) summary.excluded += 1;
      else summary[observed.outcome.variant] += 1;
    }
    return summary;
  }
}
