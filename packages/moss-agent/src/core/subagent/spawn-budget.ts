/**
 * A normal parent run may start up to eight independent children. Fan-out
 * batches receive one additional bounded batch worth of starts so the parent
 * can retry failed angles once without disabling the global cost guard.
 */
export const DEFAULT_MAX_SUBAGENT_STARTS_PER_RUN = 8;
export const ABSOLUTE_MAX_SUBAGENT_STARTS_PER_RUN = 16;

export function expandSubagentStartBudget(
  currentBudget: number,
  mode: 'single' | 'fan-out' | 'pipeline' | undefined,
  batchTaskCount: number | undefined,
): number {
  if (mode !== 'fan-out' || !Number.isFinite(batchTaskCount) || Number(batchTaskCount) < 2) {
    return currentBudget;
  }

  const boundedBatchSize = Math.min(
    ABSOLUTE_MAX_SUBAGENT_STARTS_PER_RUN / 2,
    Math.max(2, Math.floor(Number(batchTaskCount))),
  );
  return Math.max(
    currentBudget,
    Math.min(ABSOLUTE_MAX_SUBAGENT_STARTS_PER_RUN, boundedBatchSize * 2),
  );
}
