/**
 * B129 follow-up: a `moss workflow run` is an autonomous run too, so it writes
 * the same `.moss/runs/<runId>/goal.json` record the task/loop/chat engines write.
 * The mapping lives here (pure) so it can be probed without spawning child
 * sessions; the workflow state file stays the source of truth for step details.
 */
import type { RunRecord, RunRecordStatus } from '../core/run-ledger.js';
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
    artifacts: { workflowState: `.moss/workflows/${state.runId}/state.json` },
  };
}
