/**
 * B165: a superagent ticket runs its work in a **separate worktree** (a fresh
 * Moss process writes its own run ledger there). The ticket row lives in the
 * parent workspace, so it used to have no usage even when the native task did.
 *
 * This pure mapper picks the usage of the native task run that belongs to the
 * dispatch: same task id when known, otherwise the newest task row started
 * after the dispatch, and never a row older than the dispatch window.
 */
import type { RunRecord, RunRecordUsage } from '../run-ledger.js';

export interface SuperagentUsageLookup {
  /** Native task id when the worker reported one. */
  taskId?: string;
  /** Epoch ms when the dispatch started; older rows are a previous dispatch. */
  since: number;
}

export function usageFromTaskRun(
  records: readonly RunRecord[],
  lookup: SuperagentUsageLookup
): RunRecordUsage | undefined {
  const cutoff = lookup.since - 1_000;
  const candidates = records
    .filter((record) => record.kind === 'task' && record.endedAt >= cutoff && record.usage)
    .filter((record) => !lookup.taskId || record.taskId === lookup.taskId)
    .sort((left, right) => right.endedAt - left.endedAt);
  return candidates[0]?.usage;
}
