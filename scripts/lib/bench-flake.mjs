export const HARNESS_FLAKE_RETRY_LIMIT = 2;
export const MINIMUM_GATED_SAMPLES = 3;

/**
 * A zero-turn model/harness transport failure: the run produced an error
 * result before any model usage or tool call, so the check inspected an
 * untouched workspace. Such a sample says nothing about agent capability.
 */
export function isHarnessFlakeSample(row) {
  if (!row || row.pass !== false || row.timedOut === true) return false;
  if (row.subtype !== 'error_during_execution') return false;
  if (!Number.isFinite(row.numTurns) || row.numTurns === null || row.numTurns > 1) return false;
  if (row.toolCalls !== 0 || row.tokensIn !== 0 || row.tokensOut !== 0) return false;
  return true;
}

/** Rows used by capability/release scores; exhausted harness flakes are reported separately. */
export function scoredBenchmarkRows(rows) {
  return (rows ?? []).filter((row) => row?.excludedAsHarnessFlake !== true);
}

export function benchmarkPassRate(rows) {
  const scored = scoredBenchmarkRows(rows);
  return scored.length === 0 ? null : scored.filter((row) => row.pass).length / scored.length;
}
