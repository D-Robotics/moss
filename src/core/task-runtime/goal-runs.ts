/**
 * Goal-run rollup (`.moss/goals.jsonl`).
 *
 * A long-running Moss session accumulates `/goal`, `moss task run` and
 * `moss loop` runs, but the raw `.moss/` JSONL files answer "what is this
 * task's state" — not "what did I ask for across sessions, which runs passed,
 * how long did they take". Cursor keeps a per-agent run history and Claude
 * keeps task directories; this is the one-line-per-run ledger that lets a
 * single `moss task list` answer the second question.
 *
 * Written by the CLI task command (run and resume) so the REPL, TUI and
 * headless entry points all produce identical rows; read by `moss task list`.
 * A record is appended even for aborted or failed runs — that is the point of
 * a rollup.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import type { ReviewLedgerSummary } from '../loop/review-ledger.js';
import { readJsonlFile } from './artifacts.js';

export const GOAL_RUNS_FILE = 'goals.jsonl';
export const GOAL_RUNS_VERSION = 1;

export type GoalRunOutcome = 'pass' | 'fail' | 'blocked' | 'aborted';

export interface GoalRunRecord {
  version: number;
  runId: string;
  taskId: string;
  goal: string;
  phase: string;
  outcome: GoalRunOutcome;
  /** 1-based acceptance attempt the run ended on. */
  attempts: number;
  repairs: number;
  turns: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** The command that decided the verdict, when the caller supplied one. */
  acceptanceCommand?: string;
  /** Why the task needs the user (only for `outcome: 'blocked'`). */
  blockedReason?: string;
  /** Session that ran it, so a row can be traced back to its transcript. */
  sessionKey?: string;
}

export interface GoalRunInput {
  taskId: string;
  goal: string;
  phase: string;
  outcome: GoalRunOutcome;
  attempts?: number;
  repairs?: number;
  turns?: number;
  startedAt: number;
  endedAt?: number;
  acceptanceCommand?: string;
  blockedReason?: string;
  sessionKey?: string;
}

function goalRunsPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.moss', GOAL_RUNS_FILE);
}

function newRunId(now: number): string {
  return `goal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append one row. Best-effort callers may swallow the error; the CLI does not. */
export async function recordGoalRun(
  workspaceDir: string,
  input: GoalRunInput
): Promise<GoalRunRecord> {
  const endedAt = input.endedAt ?? Date.now();
  const record: GoalRunRecord = {
    version: GOAL_RUNS_VERSION,
    runId: newRunId(endedAt),
    taskId: input.taskId,
    goal: input.goal,
    phase: input.phase,
    outcome: input.outcome,
    attempts: input.attempts ?? 0,
    repairs: input.repairs ?? 0,
    turns: input.turns ?? 0,
    startedAt: input.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - input.startedAt),
    ...(input.acceptanceCommand ? { acceptanceCommand: input.acceptanceCommand } : {}),
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  };
  const dir = path.join(workspaceDir, '.moss');
  await fs.mkdir(dir, { recursive: true });
  ensureMossRuntimeGitignore(workspaceDir);
  await fs.appendFile(goalRunsPath(workspaceDir), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/** Oldest first; a torn line is skipped by the shared JSONL reader. */
export async function listGoalRuns(workspaceDir: string): Promise<GoalRunRecord[]> {
  const rows = await readJsonlFile<GoalRunRecord>(goalRunsPath(workspaceDir));
  return rows.filter(
    (row) =>
      row &&
      typeof row.runId === 'string' &&
      typeof row.taskId === 'string' &&
      typeof row.goal === 'string' &&
      typeof row.outcome === 'string'
  );
}

/**
 * Slack for the review window's upper bound: `review_changes` appends its
 * record just before the run's final accounting, and `recordGoalRun` stamps
 * `endedAt` at the same moment, so a record a few seconds "late" still belongs
 * to the run. The completion gate applies the same economics to the start
 * (`createdAtMs >= runStart - 5s`).
 */
export const REVIEW_WINDOW_SLACK_MS = 5_000;

export type GoalRunReviewVerdict = 'PASS' | 'FAIL' | 'UNKNOWN';

/** The `.moss/review.jsonl` record projected onto a goal row. */
export interface GoalRunReview {
  id: string;
  verdict: GoalRunReviewVerdict;
  critical: number;
  important: number;
  suggestion: number;
  total: number;
}

/** A goal-run row with the independent review that decided it, when one fell inside the run window. */
export type GoalRunRow = GoalRunRecord & { review?: GoalRunReview };

function reviewVerdict(verdict: ReviewLedgerSummary['verdict']): GoalRunReviewVerdict {
  if (verdict === 'pass') return 'PASS';
  if (verdict === 'fail') return 'FAIL';
  return 'UNKNOWN';
}

/**
 * Project review records onto goal rows. A record belongs to a run when its
 * `createdAtMs` is inside `[startedAt, endedAt + REVIEW_WINDOW_SLACK_MS]`; the
 * latest in-window record wins, so a repair review replaces the FAIL it fixed.
 * Records from before or after the window never appear on that row, and rows
 * without one keep no `review` key at all.
 */
export function projectGoalRunReviews(
  records: readonly GoalRunRecord[],
  reviews: readonly ReviewLedgerSummary[]
): GoalRunRow[] {
  if (reviews.length === 0) return records.map((record) => ({ ...record }));
  return records.map((record) => {
    const end = record.endedAt + REVIEW_WINDOW_SLACK_MS;
    let latest: ReviewLedgerSummary | undefined;
    for (const review of reviews) {
      if (review.createdAtMs < record.startedAt) continue;
      if (review.createdAtMs > end) continue;
      // `>=` keeps the later append when two records carry the same timestamp.
      if (!latest || review.createdAtMs >= latest.createdAtMs) latest = review;
    }
    if (!latest) return { ...record };
    return {
      ...record,
      review: {
        id: latest.id,
        verdict: reviewVerdict(latest.verdict),
        critical: latest.findings.critical,
        important: latest.findings.important,
        suggestion: latest.findings.suggestion,
        total: latest.findings.total,
      },
    };
  });
}
