/**
 * B129 follow-up: a `moss loop` run is also an autonomous run, so it writes the
 * same `.moss/runs/<runId>/goal.json` record the task engine writes. Formatting
 * lives here (not inside the 1.7k-line loop command) so the mapping can be
 * probed without a model or a PTY.
 */
import type { RunRecord, RunRecordStatus } from '../core/run-ledger.js';

/** Same union the loop ledger writes into its `summary` line. */
export type LoopFinishReason =
  | 'passed'
  | 'attempts_exhausted'
  | 'budget_exhausted'
  | 'watch_timeout'
  | 'check_timeout';

export interface LoopRunRecordInput {
  runId: string;
  passed: boolean;
  reason: LoopFinishReason;
  attempts: number;
  prompt: string;
  startedAt: number;
  endedAt: number;
  until: string;
  lastCheckExitCode: number;
  /** Workspace-relative ledger path, e.g. `.moss/loops/loop-x.jsonl`. */
  ledgerPath: string;
}

function statusFor(input: LoopRunRecordInput): RunRecordStatus {
  if (input.passed) return 'completed';
  // A hung or silent external signal is not a failed repair: the loop stopped
  // without burning the remaining attempts, so it reads as incomplete.
  if (input.reason === 'check_timeout' || input.reason === 'watch_timeout') return 'incomplete';
  return 'verify_failed';
}

function reasonFor(input: LoopRunRecordInput): string {
  switch (input.reason) {
    case 'attempts_exhausted':
      return `\`${input.until}\` still exited ${input.lastCheckExitCode} after ${input.attempts} attempt(s)`;
    case 'budget_exhausted':
      return `wall-clock budget exhausted after ${input.attempts} attempt(s)`;
    case 'check_timeout':
      return 'the check command hung and --until-timeout stopped the loop';
    case 'watch_timeout':
      return 'no change on the watched path within --watch-timeout';
    case 'passed':
      return 'the check command exited 0';
  }
}

/** Build (never write) the unified record for a finished loop run. */
export function buildLoopRunRecord(input: LoopRunRecordInput): RunRecord {
  const status = statusFor(input);
  return {
    version: 1,
    runId: input.runId,
    kind: 'loop',
    status,
    exitCode: input.passed ? 0 : 1,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    goal: input.prompt,
    attempts: input.attempts,
    ...(status === 'completed' ? {} : { reason: reasonFor(input) }),
    ...(status === 'completed' ? {} : { next: `moss loop show ${input.runId}` }),
    artifacts: { loopLedger: input.ledgerPath },
  };
}
