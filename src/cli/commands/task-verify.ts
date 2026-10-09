/**
 * `/task verify` — one verdict from the existing provider, no model turn.
 * PASS is only the provider's `passed` flag, written through the lifecycle.
 */
import { createTaskVerdictProvider } from '../../core/task/verdict.js';
import {
  appendTaskEvent,
  emitAcceptanceLifecycle,
  getTaskStateSnapshot,
  listTaskEvents,
  listTaskStateSnapshots,
} from '../../core/task/task-store.js';
import { isTerminalTaskPhase } from '../../contracts/task-runtime.js';

export interface TaskVerifyResult {
  exitCode: number;
  summary: string;
}

function acceptanceCommandFromEvents(
  events: readonly { data?: Record<string, unknown> }[]
): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const command = events[i]?.data?.acceptanceCommand;
    if (typeof command === 'string' && command.trim()) return command.trim();
  }
  return undefined;
}

export async function verifyTaskOnce(
  workspace: string,
  options: { taskId?: string; command?: string } = {}
): Promise<TaskVerifyResult> {
  const snapshot = options.taskId
    ? await getTaskStateSnapshot(workspace, options.taskId)
    : (await listTaskStateSnapshots(workspace)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!snapshot) {
    return { exitCode: 2, summary: 'No task to verify. Start one with /goal <condition>.' };
  }
  if (isTerminalTaskPhase(snapshot.phase) && snapshot.phase === 'accepted') {
    return {
      exitCode: 0,
      summary: `Task ${snapshot.taskId} is already accepted.`,
    };
  }
  const events = await listTaskEvents(workspace, snapshot.taskId);
  const explicit = options.command?.trim();
  const command = explicit || acceptanceCommandFromEvents(events);
  // A contract with criteria is the other verdict source. With neither, there
  // is nothing to evaluate — do not open execution or record a fake failure.
  if (!command && snapshot.acceptanceCriteria.length === 0) {
    return {
      exitCode: 2,
      summary: [
        `Task ${snapshot.taskId} has no acceptance command and no acceptance criteria, so there is nothing to verify.`,
        'Pass --command "<cmd>", or define criteria with task_define, then run /task verify again.',
      ].join('\n'),
    };
  }
  // acceptance_* is only valid from a verification phase. A draft (or a task
  // that never started) has to enter execution first; emitAcceptanceLifecycle
  // then opens verification itself. Only do this once a verdict will be produced.
  if (['draft', 'understanding', 'planning', 'blocked'].includes(snapshot.phase)) {
    await appendTaskEvent(workspace, snapshot.taskId, 'execution_started');
  }
  const provider = createTaskVerdictProvider({
    workspaceDir: workspace,
    ...(command ? { command } : {}),
  });
  const verdict = await provider.evaluate(snapshot.taskId);
  await emitAcceptanceLifecycle(workspace, snapshot.taskId, verdict.passed, verdict.detail);
  if (verdict.passed) {
    return {
      exitCode: 0,
      summary: `Task ${snapshot.taskId} accepted — PASS from the ${verdict.source} verdict.\n${verdict.detail}`,
    };
  }
  return {
    exitCode: 1,
    summary: [
      `Task ${snapshot.taskId} — FAIL from the ${verdict.source} verdict.`,
      verdict.detail,
      `Continue with /goal <condition> (or /task resume ${snapshot.taskId}).`,
    ].join('\n'),
  };
}
