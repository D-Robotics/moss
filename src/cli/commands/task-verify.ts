/**
 * `/task verify` — one verdict from the existing provider, no model turn.
 * PASS is only the provider's `passed` flag, written through the lifecycle.
 */
import { createTaskVerdictProvider, type VerdictProvider } from '../../core/task/verdict.js';
import {
  appendTaskEvent,
  emitAcceptanceLifecycle,
  getTaskStateSnapshot,
  listTaskEvents,
  listTaskStateSnapshots,
} from '../../core/task/task-store.js';
import { appendTaskRecord, listTaskRecords } from '../../core/task-runtime/artifacts.js';
import { acceptanceCommandFromEvents } from '../../core/task/acceptance-authority.js';

export interface TaskVerifyResult {
  exitCode: number;
  summary: string;
}

export async function verifyTaskOnce(
  workspace: string,
  options: {
    taskId?: string;
    command?: string;
    /** Test hook: a throwing evaluate must not move an accepted task. */
    verdictProvider?: Pick<VerdictProvider, 'evaluate'>;
  } = {}
): Promise<TaskVerifyResult> {
  const snapshot = options.taskId
    ? await getTaskStateSnapshot(workspace, options.taskId)
    : (await listTaskStateSnapshots(workspace)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!snapshot) {
    return { exitCode: 2, summary: 'No task to verify. Start one with /goal <condition>.' };
  }
  const wasAccepted = snapshot.phase === 'accepted';
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
  // Evaluate before any lifecycle write. A throw must leave an accepted task
  // accepted — verification_started is not rolled back.
  const provider =
    options.verdictProvider ??
    createTaskVerdictProvider({
      workspaceDir: workspace,
      ...(command ? { command } : {}),
    });
  const verdict = await provider.evaluate(snapshot.taskId);
  const alreadySettled =
    !wasAccepted && (await getTaskStateSnapshot(workspace, snapshot.taskId))?.phase === 'accepted';
  // acceptance_* is illegal from failed/abandoned (only task_resumed leaves
  // those phases). Resume into executing, then let verification open.
  if (wasAccepted) {
    // Append-only reopen. The earlier acceptance_pass stays in the timeline.
    await appendTaskEvent(workspace, snapshot.taskId, 'verification_started', {
      reason: '/task verify',
    });
  } else if (!alreadySettled && (snapshot.phase === 'failed' || snapshot.phase === 'abandoned')) {
    await appendTaskEvent(workspace, snapshot.taskId, 'task_resumed', {
      reason: '/task verify',
    });
  } else if (
    !alreadySettled &&
    ['draft', 'understanding', 'planning', 'blocked'].includes(snapshot.phase)
  ) {
    // acceptance_* is only valid from a verification phase. A draft has to
    // enter execution first; emitAcceptanceLifecycle opens verification.
    await appendTaskEvent(workspace, snapshot.taskId, 'execution_started');
  }
  if (!alreadySettled)
    await emitAcceptanceLifecycle(
      workspace,
      snapshot.taskId,
      verdict.passed,
      verdict.detail,
      verdict.source
    );
  if (verdict.passed) {
    return {
      exitCode: 0,
      summary: wasAccepted
        ? `Task ${snapshot.taskId} re-verified — PASS from the ${verdict.source} verdict.\n${verdict.detail}`
        : `Task ${snapshot.taskId} accepted — PASS from the ${verdict.source} verdict.\n${verdict.detail}`,
    };
  }
  if (wasAccepted) {
    const tasks = await listTaskRecords(workspace);
    const contract = tasks.find((task) => task.taskId === snapshot.taskId);
    if (contract && contract.status === 'accepted') {
      await appendTaskRecord(workspace, {
        ...contract,
        status: 'active',
        updatedAt: Date.now(),
      });
    }
    await appendTaskEvent(workspace, snapshot.taskId, 'note', {
      kind: 'regression',
      detail: 'previously PASS, now FAIL',
    });
    return {
      exitCode: 1,
      summary: [
        `Regression: task ${snapshot.taskId} previously PASS, now FAIL from the ${verdict.source} verdict.`,
        verdict.detail,
        'Reopened for repair. The previous acceptance stays in the timeline.',
        `Continue with /goal <condition> (or /task resume ${snapshot.taskId}).`,
      ].join('\n'),
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
