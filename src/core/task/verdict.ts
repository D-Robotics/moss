/**
 * Verdict providers (Task OS M3) — the merge of the two historical
 * "is it done?" mechanisms into one interface:
 *   command  — exit-code acceptance from the goal loop (external authority)
 *   contract — criteria × evidence acceptance (no evidence, no success)
 * Command verdicts outrank contract verdicts when both are configured, so a
 * failing external check always vetoes a criteria-only pass.
 */
import { uiText } from '../../utils/ui-language.js';
import type { AcceptanceVerdict, TaskContract } from '../../contracts/task.js';
import { evaluateAcceptance, formatAcceptanceVerdict } from '../../contracts/task.js';
import { runAcceptanceCommand } from './acceptance-command.js';
import { recordHarnessSuiteEvidence } from './suite-evidence.js';
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
 * Exit-code acceptance: pass = exit 0, fail detail = combined output tail.
 * Used as-is by the engine's VERIFYING phase.
 */
export function createCommandVerdictProvider(
  command: string,
  options: { timeoutMs?: number; workspaceDir?: string } = {}
): VerdictProvider {
  return {
    source: 'command',
    async evaluate(taskId, signal) {
      const result = await runAcceptanceCommand(
        {
          command,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
        },
        signal
      );
      if (options.workspaceDir) {
        await recordHarnessSuiteEvidence({
          workspaceDir: options.workspaceDir,
          taskId,
          source: 'acceptance_command',
          testsPassed: result.passed,
          output: result.tail,
        });
      }
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
/**
 * True when recorded evidence already meets the contract. Does not persist a
 * verdict — a planning turn can be checked before spending another model turn.
 */
export async function acceptanceAlreadySatisfied(
  workspaceDir: string,
  taskId: string
): Promise<boolean> {
  const tasks = await listTaskRecords(workspaceDir);
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  if (!task || task.acceptanceCriteria.length === 0) return false;
  const evidence = await listEvidenceRecords(workspaceDir, 1000);
  return evaluateAcceptance(task, evidence).verdict === 'pass';
}

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
          detail: uiText(
            'task has no acceptance criteria — define them with task_define (metric + expectation) before verification; a goal without a checkable definition of done cannot be accepted',
            '任务没有验收标准。请先用 task_define 写明指标和期望，再做验证。没有可检查的完成定义就不能验收。'
          ),
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

async function recordCommandVerdictRow(
  workspaceDir: string,
  taskId: string,
  passed: boolean,
  detail: string
): Promise<void> {
  await appendAcceptanceVerdict(workspaceDir, {
    taskId,
    verdict: passed ? 'pass' : 'fail',
    acceptedAt: Date.now(),
    criteriaResults: [
      {
        metric: 'acceptance_command',
        expected: 'exit 0',
        required: true,
        result: passed ? 'pass' : 'fail',
        explanation: detail.slice(0, 300),
      },
    ],
    unmetRequired: passed ? 0 : 1,
    evidenceConsidered: 0,
  });
}

/**
 * Command verdicts are authoritative when configured; the contract provider
 * covers tasks whose "done" is criteria-based. This is the single provider
 * the engine consults — command acceptance and robotics tasks share it.
 */
export function createTaskVerdictProvider(options: {
  workspaceDir: string;
  command?: string;
}): VerdictProvider {
  const contract = createContractVerdictProvider(options.workspaceDir);
  if (!options.command) return contract;
  const command = createCommandVerdictProvider(options.command, {
    workspaceDir: options.workspaceDir,
  });
  return {
    source: 'command',
    async evaluate(taskId, signal) {
      const commandVerdict = await command.evaluate(taskId, signal);
      if (commandVerdict.passed) {
        // Command passed — still record the contract evaluation for the trail.
        // The command row is written after that so it stays the latest verdict.
        await contract.evaluate(taskId).catch(() => undefined);
      }
      // A later command result replaces the previous row in acceptance.jsonl.
      // Scoring the contract on failure can rewrite a FAIL into PASS when older
      // evidence still matches criteria the command does not cover.
      await recordCommandVerdictRow(
        options.workspaceDir,
        taskId,
        commandVerdict.passed,
        commandVerdict.detail
      ).catch(() => undefined);
      return commandVerdict;
    },
  };
}
