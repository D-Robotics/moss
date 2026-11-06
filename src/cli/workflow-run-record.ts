/**
 * B129 follow-up: a `moss workflow run` is an autonomous run too, so it writes
 * the same `.moss/runs/<runId>/goal.json` record the task/loop/chat engines write.
 * The mapping lives here (pure) so it can be probed without spawning child
 * sessions; the workflow state file stays the source of truth for step details.
 */
import type { RunRecord, RunRecordStatus, RunRecordUsage } from '../core/run-ledger.js';
import type { WorkflowState } from '../core/workflow/workflow-runner.js';

export interface WorkflowRunRecordInput {
  state: WorkflowState;
  startedAt: number;
  endedAt: number;
}

/** All passed -> completed; a failure -> verify_failed; blocked -> blocked. */
export function workflowRunStatus(state: WorkflowState): RunRecordStatus {
  const statuses = state.steps.map((step) => step.status);
  if (statuses.every((status) => status === 'passed')) return 'completed';
  if (statuses.some((status) => status === 'failed')) return 'verify_failed';
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  return 'incomplete';
}

/** Sum step usage; steps without numbers contribute nothing (never guessed). */
export function aggregateWorkflowUsage(state: WorkflowState): RunRecordUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let withUsage = 0;
  let priced = 0;
  for (const step of state.steps) {
    const usage = step.usage;
    if (!usage) continue;
    withUsage += 1;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    if (typeof usage.costUsd === 'number') {
      costUsd += usage.costUsd;
      priced += 1;
    }
  }
  if (withUsage === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(priced > 0 ? { costUsd: Number(costUsd.toFixed(6)) } : {}),
  };
}

/**
 * The one model every step ran on. Undefined when any step did not report a
 * model (often a blocked/pending step) or the reported models disagree: a
 * partial answer would mis-attribute the workflow's usage in `--by model`.
 */
export function aggregateWorkflowModel(state: WorkflowState): string | undefined {
  const models = state.steps.map((step) => step.model);
  if (models.some((model) => !model)) return undefined;
  const unique = new Set(models as string[]);
  return unique.size === 1 ? [...unique][0] : undefined;
}

export function buildWorkflowRunRecord(input: WorkflowRunRecordInput): RunRecord {
  const { state } = input;
  const status = workflowRunStatus(state);
  const counts = new Map<string, number>();
  for (const step of state.steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  const summary = [...counts.entries()].map(([key, count]) => `${count} ${key}`).join(', ');
  return {
    version: 1,
    runId: state.runId,
    kind: 'workflow',
    status,
    exitCode: status === 'completed' ? 0 : 1,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    goal: `workflow "${state.name}" — ${state.steps.length} step(s)`,
    ...(status === 'completed'
      ? {}
      : { reason: `${summary} (${state.planFile})`, next: `moss workflow resume ${state.runId}` }),
    ...(() => {
      const model = aggregateWorkflowModel(state);
      return model ? { model } : {};
    })(),
    ...(() => {
      const usage = aggregateWorkflowUsage(state);
      return usage ? { usage } : {};
    })(),
    artifacts: { workflowState: `.moss/workflows/${state.runId}/state.json` },
  };
}
