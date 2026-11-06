/**
 * B129 follow-up: a headless `moss -p` run is an autonomous run too, so it
 * writes the same `.moss/runs/<runId>/run.json` record the task and loop
 * engines write. The status vocabulary comes from the completion gate
 * (`resolveRunOutcome`), so "completed / incomplete / verify_failed / blocked /
 * unverified" mean exactly what the printed last line means.
 *
 * Interactive REPL turns deliberately do not write records: a conversation is
 * not an auditable run, and one row per chat turn would drown `moss runs`.
 */
import type { RunOutcomeStatus } from './run-outcome.js';
import type { RunRecord, RunRecordStatus, RunRecordUsage } from '../core/run-ledger.js';

/** Progress hint for a non-completed one-shot run (printed AND recorded). */
export function nextStepForChatOutcome(status: RunOutcomeStatus): string | undefined {
  switch (status) {
    case 'unverified':
      return 'make the run actually perform the check it claims, then re-run';
    case 'verify_failed':
      return 'fix the failing verification, then re-run';
    case 'incomplete':
      return 'finish the work, then re-run';
    case 'blocked':
      return 'fix what the hook checks, then re-run';
    case 'completed':
      return undefined;
  }
}

export interface ChatRunRecordInput {
  runId: string;
  status: RunOutcomeStatus;
  exitCode: number;
  reason: string;
  prompt: string;
  sessionKey: string;
  startedAt: number;
  endedAt: number;
  usage?: RunRecordUsage;
}

export function buildChatRunRecord(input: ChatRunRecordInput): RunRecord {
  const status = input.status as RunRecordStatus;
  const next = nextStepForChatOutcome(input.status);
  return {
    version: 1,
    runId: input.runId,
    kind: 'chat',
    status,
    exitCode: input.exitCode,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    goal: input.prompt,
    sessionKey: input.sessionKey,
    ...(status === 'completed' ? {} : { reason: input.reason }),
    ...(next ? { next } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    artifacts: { session: `.moss/sessions/${input.sessionKey}.jsonl` },
  };
}
