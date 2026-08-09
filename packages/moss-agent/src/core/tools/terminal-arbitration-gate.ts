import type {
  CodingCompletionGateRequest,
  CodingCompletionGateResult,
} from '../../cli/coding-completion-gate.js';
import type { ExperienceEntry, ExperienceLog } from '../../memory/experience-log.js';
import type { TrustedLearningCoordinator } from '../../memory/trusted-learning-coordinator.js';
import type { TrustedSkillExperimentCoordinator } from '../../memory/trusted-skill-experiment-coordinator.js';
import type { Plan } from '../../plan-execute/plan-execute-controller.js';
import type { DeviceReadonlyExecutor } from './device-readonly-executor.js';
import type {
  TerminalVerdictEntry,
  TerminalVerdictLog,
} from '../../acceptance/terminal-verdict-log.js';
import { arbitrateTaskTerminal } from '../../acceptance/task-terminal-verifier.js';
import { memoryWarn } from '../../memory/logger.js';
import type { CrossSignalLog } from '../../acceptance/cross-signal-log.js';
import { observationsFromTerminal } from '../../acceptance/cross-signal-log.js';

export interface TerminalArbitrationGateDeps {
  experienceLog: ExperienceLog;
  planProvider: { get(sessionKey: string): Plan | null };
  workspaceDir: string;
  deviceExecutor: { current: DeviceReadonlyExecutor | null };
  terminalVerdictLog?: Pick<TerminalVerdictLog, 'append' | 'readAll'>;
  trustedLearningCoordinator?: Pick<TrustedLearningCoordinator, 'observe'>;
  trustedSkillExperimentCoordinator?: Pick<TrustedSkillExperimentCoordinator, 'observeTerminal'>;
  crossSignalLog?: Pick<CrossSignalLog, 'appendMany'>;
}

function planSkills(plan: Plan): string[] {
  const skills = new Set<string>();
  for (const step of plan.steps ?? []) {
    for (const skill of step.expectedAccept ?? []) {
      if (typeof skill === 'string' && skill) skills.add(skill);
    }
  }
  return [...skills].sort();
}

function matchingEvidence(
  experiences: ExperienceEntry[],
  evidenceId: string | undefined
): ExperienceEntry | undefined {
  if (!evidenceId) return undefined;
  return experiences.find(
    (entry) => entry.evidenceId === evidenceId || entry.toolCallId === evidenceId
  );
}

function stepOwners(plan: Plan, stepId: string | undefined): string[] {
  if (!stepId) return [];
  const stepNumber = Number(/:step:(\d+)$/.exec(stepId)?.[1]);
  if (!Number.isFinite(stepNumber)) return [];
  const step = plan.steps.find((candidate) => candidate.step === stepNumber);
  return [...new Set(step?.expectedAccept ?? [])].filter(Boolean);
}

function resolveAttribution(input: {
  plan: Plan;
  skills: string[];
  verdict: 'pass' | 'fail' | 'unknown';
  experiences: ExperienceEntry[];
  currentExperience?: ExperienceEntry;
  previousFailure?: TerminalVerdictEntry;
}): {
  attribution: TerminalVerdictEntry['attribution'];
  skill: string;
  attributedStepIds?: string[];
} {
  if (input.skills.length === 0) return { attribution: 'none', skill: 'unknown' };
  if (input.skills.length === 1) return { attribution: 'single-skill', skill: input.skills[0]! };
  let relevant: ExperienceEntry[] = [];
  if (input.verdict === 'fail') {
    relevant = input.experiences.filter((entry) => entry.verdict === 'fail');
  } else if (
    input.verdict === 'pass' &&
    input.previousFailure?.attribution === 'single-owner-step'
  ) {
    const failedSteps = new Set(input.previousFailure.attributedStepIds ?? []);
    if (input.currentExperience?.stepId && failedSteps.has(input.currentExperience.stepId)) {
      relevant = [input.currentExperience];
    }
  }
  const owned = relevant.flatMap((entry) => {
    const owners = stepOwners(input.plan, entry.stepId);
    const contractSkill = entry.contractSkill;
    return owners.length === 1 && contractSkill === owners[0]
      ? [{ skill: owners[0]!, stepId: entry.stepId! }]
      : [];
  });
  const ownerSkills = [...new Set(owned.map((entry) => entry.skill))];
  const stepIds = [...new Set(owned.map((entry) => entry.stepId))];
  const relevantStepIds = [
    ...new Set(
      relevant.map((entry) => entry.stepId).filter((value): value is string => Boolean(value))
    ),
  ];
  if (ownerSkills.length === 1 && stepIds.length === 1 && relevantStepIds.length === 1) {
    return { attribution: 'single-owner-step', skill: ownerSkills[0]!, attributedStepIds: stepIds };
  }
  return { attribution: 'multi-skill', skill: 'unknown' };
}

function latestFailure(
  entries: readonly TerminalVerdictEntry[],
  taskId: string,
  runId: string
): TerminalVerdictEntry | undefined {
  return [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.schemaVersion === 2 &&
        entry.taskId === taskId &&
        entry.runId === runId &&
        entry.verdict === 'fail'
    );
}

/**
 * Adds objective terminal acceptance to the normal completion gate.
 * A decided terminal failure always blocks completion. After the first failure,
 * only fresh execution evidence belonging to the same v2 task/run can satisfy a retry.
 */
export function wrapWithTerminalArbitration(
  originalGate: (req: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult>,
  deps: TerminalArbitrationGateDeps
): (req: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult> {
  return async (req) => {
    try {
      const plan = deps.planProvider.get(req.sessionKey);
      if (plan && (plan.status === 'executing' || plan.status === 'completed')) {
        const allExperiences = await deps.experienceLog.readAll();
        const taskExperiences = allExperiences.filter(
          (entry) =>
            entry.schemaVersion === 2 && entry.taskId === plan.id && entry.runId === req.runId
        );
        const auditExperiences =
          taskExperiences.length > 0
            ? taskExperiences
            : allExperiences.filter(
                (entry) => entry.schemaVersion !== 2 && entry.sessionKey === req.sessionKey
              );
        const previousEntries = deps.terminalVerdictLog
          ? await deps.terminalVerdictLog.readAll()
          : [];
        const previousFailure = latestFailure(previousEntries, plan.id, req.runId);
        const previousFailureEvidence = new Set(
          previousEntries
            .filter(
              (entry) =>
                entry.schemaVersion === 2 &&
                entry.taskId === plan.id &&
                entry.runId === req.runId &&
                entry.verdict === 'fail'
            )
            .map((entry) => entry.evidenceId ?? entry.id)
        );

        const { terminal, arbitration } = await arbitrateTaskTerminal({
          plan,
          experiences: auditExperiences,
          workspaceDir: deps.workspaceDir,
          deviceExecutor: deps.deviceExecutor.current,
          finalResponse: req.response,
          executionEvidence: req.executionEvidence,
          terminalVerdictLog: deps.terminalVerdictLog,
        });

        const skills = planSkills(plan);
        const attemptId = `${plan.id}:${req.runId}:${req.turn}`;
        const requestedEvidenceId = req.executionEvidence?.toolUseId;
        const currentExperience = matchingEvidence(taskExperiences, requestedEvidenceId);
        const resolvedAttribution = resolveAttribution({
          plan,
          skills,
          verdict: terminal.verdict,
          experiences: taskExperiences,
          currentExperience,
          previousFailure,
        });
        const attribution = resolvedAttribution.attribution ?? 'none';
        const evidenceId = requestedEvidenceId ?? `terminal:${plan.id}:${req.runId}:${req.turn}`;
        const environmentFingerprint =
          currentExperience?.environmentFingerprint ??
          taskExperiences.find((entry) => entry.environmentFingerprint)?.environmentFingerprint ??
          'unknown';
        const terminalEntry: TerminalVerdictEntry = {
          id: `${attemptId}:${attribution === 'single-skill' ? skills[0] : 'unknown'}`,
          schemaVersion: 2,
          taskId: plan.id,
          runId: req.runId,
          turn: req.turn,
          planVersion: plan.version,
          attemptId,
          evidenceId,
          skill: resolvedAttribution.skill,
          skills,
          attribution,
          ...(resolvedAttribution.attributedStepIds
            ? { attributedStepIds: resolvedAttribution.attributedStepIds }
            : {}),
          environmentFingerprint,
          ...(currentExperience?.environmentIdentityVersion
            ? {
                environmentIdentityVersion: currentExperience.environmentIdentityVersion,
                environmentCompleteness: currentExperience.environmentCompleteness,
              }
            : {}),
          executionDomain:
            currentExperience?.executionDomain ??
            taskExperiences.find((entry) => entry.executionDomain)?.executionDomain,
          realEvidenceEligible:
            currentExperience?.realEvidenceEligible === true ||
            taskExperiences.some((entry) => entry.realEvidenceEligible === true),
          correctionCount: previousFailureEvidence.size + (terminal.verdict === 'fail' ? 1 : 0),
          ...(terminal.safetyFailed
            ? {
                safetyFailed: true,
                safetyReasonCode: terminal.safetyReasonCode,
              }
            : {}),
          verdict: terminal.verdict,
          reason: terminal.reason,
          sessionKey: req.sessionKey,
          timestamp: new Date().toISOString(),
        };

        const staleEvidence =
          Boolean(previousFailure) &&
          (!requestedEvidenceId ||
            !currentExperience ||
            requestedEvidenceId === previousFailure?.evidenceId);
        if (staleEvidence) {
          return {
            ok: false,
            reason: 'stale_terminal_evidence',
            correction:
              '[System] The previous terminal failure cannot be retried with old or untracked evidence. ' +
              'Run the relevant tool again, then resubmit only after its new toolUseId is recorded as a v2 Experience ' +
              `for task ${plan.id} and run ${req.runId}.`,
            retryLimit: 1,
          };
        }

        if (deps.terminalVerdictLog) {
          try {
            await deps.terminalVerdictLog.append(terminalEntry);
          } catch (error) {
            memoryWarn('terminal verdict log write failed:', error);
          }
        }

        if (deps.crossSignalLog && terminal.perPredicate?.length) {
          try {
            await deps.crossSignalLog.appendMany(
              observationsFromTerminal({
                terminal: terminalEntry,
                specs: plan.terminalAccept ?? [],
                results: terminal.perPredicate,
              })
            );
          } catch (error) {
            memoryWarn('cross-signal log write failed:', error);
          }
        }

        if (deps.trustedLearningCoordinator) {
          try {
            await deps.trustedLearningCoordinator.observe({
              plan,
              terminalEntry,
              terminalReasonCode: terminal.reason,
              arbitration,
              experiences: taskExperiences,
            });
          } catch (error) {
            memoryWarn('trusted learning coordinator failed:', error);
          }
        }

        if (deps.trustedSkillExperimentCoordinator) {
          try {
            await deps.trustedSkillExperimentCoordinator.observeTerminal({
              terminalEntry,
              experiences: taskExperiences,
              corrections: terminalEntry.correctionCount,
              safetyFailed: terminalEntry.safetyFailed,
            });
          } catch (error) {
            memoryWarn('trusted skill experiment coordinator failed:', error);
          }
        }

        if (terminal.verdict === 'fail') {
          if (arbitration.auditFailed) {
            const suspect = arbitration.suspectSkills.join(', ') || 'unknown';
            return {
              ok: false,
              reason: `terminal_contract_drift:${terminal.reason}`,
              correction:
                '[System] Terminal acceptance failed although every step predicate passed. ' +
                `The step contract is not trustworthy and is pending review (suspect Skills: ${suspect}). ` +
                `Re-run the terminal verification and produce new execution evidence. Terminal reason: ${terminal.reason}`,
              retryLimit: 1,
            };
          }
          const failedSteps = [
            ...new Set(
              taskExperiences
                .filter((entry) => entry.verdict === 'fail')
                .map((entry) => entry.stepId)
                .filter((value): value is string => Boolean(value))
            ),
          ];
          return {
            ok: false,
            reason: `terminal_acceptance_failed:${terminal.reason}`,
            correction:
              '[System] Objective terminal acceptance failed. ' +
              `${failedSteps.length ? `Failed steps: ${failedSteps.join(', ')}. ` : ''}` +
              `Re-execute the failed operation or verification and submit fresh tool evidence. Terminal reason: ${terminal.reason}`,
            retryLimit: 1,
          };
        }
      }
    } catch (error) {
      memoryWarn('terminal arbitration gate error:', error);
    }
    return originalGate(req);
  };
}
