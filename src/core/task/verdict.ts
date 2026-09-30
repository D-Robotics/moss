/**
 * Verdict providers (Task OS M3) — the merge of the two historical
 * "is it done?" mechanisms into one interface:
 *   command  — exit-code acceptance from the goal loop (external authority)
 *   contract — criteria × evidence acceptance (no evidence, no success)
 * Command verdicts outrank contract verdicts when both are configured, so a
 * failing external check always vetoes a criteria-only pass.
 */
import type { AcceptanceVerdict, TaskContract } from '../../contracts/task.js';
import { evaluateAcceptance, formatAcceptanceVerdict } from '../../contracts/task.js';
import { runAcceptanceCommand } from '../loop/goal-loop.js';
import {
  appendAcceptanceVerdict,
  appendTaskRecord,
  listEvidenceRecords,
  listTaskRecords,
} from '../task-runtime/artifacts.js';

export type VerdictSource = 'command' | 'contract';

export interface TaskVerdict {
  taskId: string;
  passed: boolean;
  source: VerdictSource;
  /** Human-readable verdict / failure evidence for the next agent turn. */
  detail: string;
  /** Present when source is 'contract'. */
  verdict?: AcceptanceVerdict;
}

export interface VerdictProvider {
  readonly source: VerdictSource;
  evaluate(taskId: string, signal?: AbortSignal): Promise<TaskVerdict>;
}

/**
 * Exit-code acceptance (the goal-loop mechanism): pass = exit 0, fail detail
 * = combined output tail. Used as-is by the engine's VERIFYING phase.
 */
export function createCommandVerdictProvider(
  command: string,
  options: { timeoutMs?: number } = {}
): VerdictProvider {
  return {
    source: 'command',
    async evaluate(taskId, signal) {
      const result = await runAcceptanceCommand(
        { command, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
        signal
      );
      return {
        taskId,
        passed: result.passed,
        source: 'command',
        detail: result.passed
          ? `acceptance command exited 0`
          : `acceptance command failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})\n${result.tail}`,
      };
    },
  };
}

/**
 * Criteria × evidence acceptance (the task-contract mechanism): latest
 * evidence per metric wins; required criteria without evidence block. The
 * verdict is persisted (acceptance.jsonl) and the contract status updated,
 * exactly like the task_acceptance tool — one implementation, two callers.
 */
export async function evaluateContractAcceptance(
  workspaceDir: string,
  taskId?: string
): Promise<{ verdict: AcceptanceVerdict; task: TaskContract } | null> {
  const tasks = await listTaskRecords(workspaceDir);
  if (tasks.length === 0) return null;
  const task = taskId
    ? tasks.find((candidate) => candidate.taskId === taskId)
    : tasks.reduce((latest, candidate) =>
        candidate.updatedAt >= latest.updatedAt ? candidate : latest
      );
  if (!task) return null;

  const evidence = await listEvidenceRecords(workspaceDir, 1000);
  const verdict = evaluateAcceptance(task, evidence);
  await appendAcceptanceVerdict(workspaceDir, verdict);

  if (verdict.verdict === 'pass' && task.status !== 'accepted') {
    await appendTaskRecord(workspaceDir, { ...task, status: 'accepted', updatedAt: Date.now() });
  } else if (verdict.verdict === 'fail' && task.status === 'active') {
    await appendTaskRecord(workspaceDir, { ...task, status: 'failed', updatedAt: Date.now() });
  }
  return { verdict, task };
}

export function createContractVerdictProvider(workspaceDir: string): VerdictProvider {
  return {
    source: 'contract',
    async evaluate(taskId) {
      // Guard: a draft contract with no criteria would trivially "pass"
      // (nothing to fail). No criteria = no defined done = not accepted.
      const tasks = await listTaskRecords(workspaceDir);
      const task = tasks.find((candidate) => candidate.taskId === taskId);
      if (task && task.acceptanceCriteria.length === 0) {
        return {
          taskId,
          passed: false,
          source: 'contract',
          detail:
            'task has no acceptance criteria — define them with task_define (metric + expectation) before verification; a goal without a checkable definition of done cannot be accepted',
        };
      }
      const result = await evaluateContractAcceptance(workspaceDir, taskId);
      if (!result) {
        return {
          taskId,
          passed: false,
          source: 'contract',
          detail: 'no task contract found — define one with task_define first',
        };
      }
      return {
        taskId,
        passed: result.verdict.verdict === 'pass',
        source: 'contract',
        detail: formatAcceptanceVerdict(result.verdict, result.task),
        verdict: result.verdict,
      };
    },
  };
}

/**
 * Command verdicts are authoritative when configured; the contract provider
 * covers tasks whose "done" is criteria-based. This is the single provider
 * the engine consults — goal-loop and robotics tasks stop being two systems.
 */
export function createTaskVerdictProvider(options: {
  workspaceDir: string;
  command?: string;
}): VerdictProvider {
  const contract = createContractVerdictProvider(options.workspaceDir);
  if (!options.command) return contract;
  const command = createCommandVerdictProvider(options.command);
  return {
    source: 'command',
    async evaluate(taskId, signal) {
      const commandVerdict = await command.evaluate(taskId, signal);
      if (commandVerdict.passed) {
        // Command passed — still record the contract evaluation for the trail.
        await contract.evaluate(taskId).catch(() => undefined);
        return commandVerdict;
      }
      return commandVerdict;
    },
  };
}
