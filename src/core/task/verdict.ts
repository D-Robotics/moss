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
import { runAcceptanceCommandInWorkspace } from './acceptance-command.js';
import {
  appendAcceptanceVerdict,
  appendTaskRecord,
  listEvidenceRecords,
  listTaskRecords,
} from '../task-runtime/artifacts.js';
import {
  noteCommittedAcceptance,
  inNativeAcceptanceSettlement,
} from './acceptance-commit-scope.js';
import { appendTaskEvent, emitAcceptanceLifecycle, getTaskStateSnapshot } from './task-store.js';

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

// Only a successful durable append can attest acceptance, never a caller's
// source label. Identity is preserved through host wrappers returning verdicts.
const committedVerdicts = new WeakSet<TaskVerdict>();
export function isCommittedTaskVerdict(verdict: TaskVerdict): boolean {
  return committedVerdicts.has(verdict);
}

/**
 * Exit-code acceptance: pass = exit 0, fail detail = combined output tail.
 * Used as-is by the engine's VERIFYING phase.
 */
export function createCommandVerdictProvider(
  command: string,
  options: { timeoutMs?: number } = {}
): VerdictProvider {
  return commandVerdictProvider(command, options);
}

function commandVerdictProvider(
  command: string,
  options: { timeoutMs?: number },
  workspaceDir?: string
): VerdictProvider {
  return {
    source: 'command',
    async evaluate(taskId, signal) {
      const result = await runAcceptanceCommandInWorkspace(
        { command, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
        signal,
        workspaceDir
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
  taskId?: string,
  signal?: AbortSignal
): Promise<{ verdict: AcceptanceVerdict; task: TaskContract } | null> {
  return evaluateContractWithAuthority(workspaceDir, taskId, signal, false);
}

async function evaluateContractWithAuthority(
  workspaceDir: string,
  taskId: string | undefined,
  signal: AbortSignal | undefined,
  commandPassed: boolean
): Promise<{ verdict: AcceptanceVerdict; task: TaskContract } | null> {
  signal?.throwIfAborted();
  const tasks = await listTaskRecords(workspaceDir);
  signal?.throwIfAborted();
  if (tasks.length === 0) return null;
  const task = taskId
    ? tasks.find((candidate) => candidate.taskId === taskId)
    : tasks.reduce((latest, candidate) =>
        candidate.updatedAt >= latest.updatedAt ? candidate : latest
      );
  if (!task) return null;

  const evidence = await listEvidenceRecords(workspaceDir, 1000);
  signal?.throwIfAborted();
  const verdict = evaluateAcceptance(task, evidence);
  // The last abort check is at append dispatch. Once the PASS commit starts,
  // finish its ledger despite later cancellation. Failed IO never attests PASS.
  await appendAcceptanceVerdict(workspaceDir, verdict, signal);

  if ((verdict.verdict === 'pass' || commandPassed) && task.status !== 'accepted') {
    await appendTaskRecord(workspaceDir, { ...task, status: 'accepted', updatedAt: Date.now() });
  } else if (verdict.verdict === 'fail' && task.status === 'active') {
    await appendTaskRecord(
      workspaceDir,
      { ...task, status: 'failed', updatedAt: Date.now() },
      signal
    );
  }
  return { verdict, task };
}

async function settleAcceptedContract(
  workspaceDir: string,
  result: { verdict: AcceptanceVerdict; task: TaskContract },
  source: VerdictSource,
  detail: string
): Promise<void> {
  try {
    const before = await getTaskStateSnapshot(workspaceDir, result.task.taskId);
    // A planning turn can already implement and measure the goal. Complete the
    // existing legal phase path before publishing its acceptance barrier.
    if (before && ['draft', 'understanding', 'planning'].includes(before.phase)) {
      await appendTaskEvent(workspaceDir, result.task.taskId, 'plan_ready');
      await appendTaskEvent(workspaceDir, result.task.taskId, 'execution_started');
    } else if (before && ['failed', 'abandoned', 'blocked'].includes(before.phase)) {
      await appendTaskEvent(workspaceDir, result.task.taskId, 'task_resumed', {
        reason: 'acceptance re-evaluation',
      });
    }
    await emitAcceptanceLifecycle(workspaceDir, result.task.taskId, true, detail, source);
    const after = await getTaskStateSnapshot(workspaceDir, result.task.taskId);
    if (after && after.phase !== 'accepted') {
      throw new Error(`task ${result.task.taskId} cannot accept from ${after.phase}`);
    }
  } catch (error) {
    // These are separate durable appends, not a transaction. Retain the audit
    // trail, but compensate only this incomplete settlement; a prior completed
    // lifecycle acceptance must never be undone.
    const current = await getTaskStateSnapshot(workspaceDir, result.task.taskId).catch(() => null);
    if (current?.phase !== 'accepted') {
      await appendTaskRecord(workspaceDir, {
        ...result.task,
        status: result.task.status === 'accepted' ? 'active' : result.task.status,
        updatedAt: Date.now(),
      }).catch(() => {});
    }
    throw error;
  }
}

export function createContractVerdictProvider(workspaceDir: string): VerdictProvider {
  return {
    source: 'contract',
    async evaluate(taskId, signal) {
      return inNativeAcceptanceSettlement(workspaceDir, async () => {
        signal?.throwIfAborted();
        // Guard: a draft contract with no criteria would trivially "pass"
        // (nothing to fail). No criteria = no defined done = not accepted.
        const tasks = await listTaskRecords(workspaceDir);
        signal?.throwIfAborted();
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
        const result = await evaluateContractAcceptance(workspaceDir, taskId, signal);
        if (!result) {
          return {
            taskId,
            passed: false,
            source: 'contract',
            detail: 'no task contract found — define one with task_define first',
          };
        }
        const evaluated: TaskVerdict = {
          taskId,
          passed: result.verdict.verdict === 'pass',
          source: 'contract',
          detail: formatAcceptanceVerdict(result.verdict, result.task),
          verdict: result.verdict,
        };
        if (evaluated.passed) {
          await settleAcceptedContract(workspaceDir, result, 'contract', evaluated.detail);
          committedVerdicts.add(evaluated);
          noteCommittedAcceptance(workspaceDir, evaluated);
        } else signal?.throwIfAborted();
        return evaluated;
      });
    },
  };
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
  const command = commandVerdictProvider(options.command, {}, options.workspaceDir);
  return {
    source: 'command',
    async evaluate(taskId, signal) {
      return inNativeAcceptanceSettlement(options.workspaceDir, async () => {
        const commandVerdict = await command.evaluate(taskId, signal);
        signal?.throwIfAborted();
        if (commandVerdict.passed) {
          // Command passed — still record the contract evaluation for the trail.
          const recorded = await evaluateContractWithAuthority(
            options.workspaceDir,
            taskId,
            signal,
            true
          );
          if (recorded) {
            await settleAcceptedContract(
              options.workspaceDir,
              recorded,
              'command',
              commandVerdict.detail
            );
            committedVerdicts.add(commandVerdict);
            noteCommittedAcceptance(options.workspaceDir, commandVerdict);
          } else signal?.throwIfAborted();
          return commandVerdict;
        }
        return commandVerdict;
      });
    },
  };
}
