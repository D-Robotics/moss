/**
 * `moss task list` — the goal-run rollup table.
 *
 * One row per task run (run, resume, aborted), newest first, so a long-running
 * user can answer "what did I ask across sessions, what passed, what is still
 * unfinished" without reading `.moss/*.jsonl` by hand.
 *
 * A row that used independent review also carries the verdict that decided it
 * (projected from `.moss/review.jsonl`), so "failed on the acceptance command"
 * and "the reviewer found 2 critical issues" are no longer the same `fail`.
 *
 * Fail and blocked rows also explain themselves: the failure the agent recorded
 * in `.moss/task-failures.jsonl` (its symptom) is projected as a third `↳` line,
 * so the table answers "why" without `task status <id>` or reading
 * `.moss/task-failures.jsonl` by hand. Like the review verdict, the failure is
 * scoped to the row's own run window — a resumed task keeps its `taskId`, and
 * run B's symptom must never explain run A's row.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FailureRecord } from '../contracts/task-runtime.js';
import { REVIEW_WINDOW_SLACK_MS } from '../core/task-runtime/goal-runs.js';
import type {
  GoalRunOutcome,
  GoalRunRecord,
  GoalRunReview,
  GoalRunReviewVerdict,
  GoalRunRow,
} from '../core/task-runtime/goal-runs.js';

const OUTCOME_ZH: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  blocked: '阻塞',
  aborted: '已中止',
};

const REVIEW_VERDICT_ZH: Record<GoalRunReviewVerdict, string> = {
  PASS: '通过',
  FAIL: '失败',
  UNKNOWN: '未知',
};

const GOAL_PREVIEW = 64;
const COMMAND_PREVIEW = 48;
const REVIEW_ID_PREVIEW = 40;
const REASON_PREVIEW = 120;

const FAILURES_FILE = 'task-failures.jsonl';
/**
 * Failure records are small; the tail of the log covers every run a table can
 * show (`--limit` defaults to 20) without reading an unbounded history.
 */
const FAILURE_TAIL_BYTES = 256 * 1024;
const FAILURE_MAX_RECORDS = 2_000;

function clip(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The failure that explains a fail/blocked row, as projected onto its row. */
export interface GoalRunFailure {
  stage: string;
  symptom: string;
  resolved: boolean;
}

/** A goal-run row plus the failure record that explains it, when one exists. */
export type GoalRunListRow = GoalRunRow & { failure?: GoalRunFailure };

function projectFailureRecord(raw: unknown): FailureRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Partial<FailureRecord>;
  if (typeof record.taskId !== 'string' || record.taskId === '') return undefined;
  if (typeof record.symptom !== 'string' || record.symptom.trim() === '') return undefined;
  const timestamp =
    typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? record.timestamp
      : 0;
  return {
    failureId:
      typeof record.failureId === 'string' && record.failureId !== ''
        ? record.failureId
        : `${record.taskId}:${String(timestamp)}`,
    taskId: record.taskId,
    stage: (typeof record.stage === 'string' ? record.stage : 'unknown') as FailureRecord['stage'],
    symptom: record.symptom,
    attempt: typeof record.attempt === 'number' ? record.attempt : 0,
    resolved: record.resolved === true,
    timestamp,
  };
}

/**
 * Parseable failure records from the tail, append order; torn lines are skipped.
 *
 * The per-row window selection happens in `projectGoalRunFailures`, so the whole
 * bounded tail is read once and shared by every row of the table.
 */
export function readFailureRecords(workspaceDir: string): FailureRecord[] {
  const file = path.join(workspaceDir, '.moss', FAILURES_FILE);
  let handle: number;
  try {
    handle = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(handle).size;
    if (size === 0) return [];
    const readBytes = Math.min(size, FAILURE_TAIL_BYTES);
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(handle, buffer, 0, readBytes, size - readBytes);
    const records: FailureRecord[] = [];
    for (const raw of buffer.toString('utf8').split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      // A tail window can start mid-line; only full JSON objects are records.
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = projectFailureRecord(parsed);
      if (record) records.push(record);
    }
    return records.length > FAILURE_MAX_RECORDS ? records.slice(-FAILURE_MAX_RECORDS) : records;
  } catch {
    return [];
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Latest failure reason per task. The ledger is append-only and updating a
 * failure appends another version under the same `failureId`, so the newest
 * version wins first. Then an unresolved failure is preferred over a later
 * resolved one (a run that failed again should name the symptom it did not
 * fix); otherwise the latest record answers for the task.
 */
export function projectFailureReasons(
  records: readonly FailureRecord[]
): Map<string, GoalRunFailure> {
  const latestById = new Map<string, FailureRecord>();
  for (const record of records) {
    const previous = latestById.get(record.failureId);
    if (!previous || record.timestamp >= previous.timestamp)
      latestById.set(record.failureId, record);
  }
  const latestUnresolved = new Map<string, FailureRecord>();
  const latestAny = new Map<string, FailureRecord>();
  for (const record of latestById.values()) {
    const anySoFar = latestAny.get(record.taskId);
    if (!anySoFar || record.timestamp >= anySoFar.timestamp) latestAny.set(record.taskId, record);
    if (record.resolved) continue;
    const unresolvedSoFar = latestUnresolved.get(record.taskId);
    if (!unresolvedSoFar || record.timestamp >= unresolvedSoFar.timestamp) {
      latestUnresolved.set(record.taskId, record);
    }
  }
  const reasons = new Map<string, GoalRunFailure>();
  for (const [taskId, record] of latestAny) {
    const chosen = latestUnresolved.get(taskId) ?? record;
    reasons.set(taskId, {
      stage: chosen.stage,
      symptom: chosen.symptom,
      resolved: chosen.resolved,
    });
  }
  return reasons;
}

/**
 * The failure that explains one run, or `undefined` when its window holds none.
 *
 * A record belongs to a run when its `timestamp` is inside
 * `[startedAt, endedAt + REVIEW_WINDOW_SLACK_MS]` — the same window B108 uses for
 * reviews, because the agent records the failure that ended a run immediately
 * before the goal row is written. A resumed task shares the `taskId` but not the
 * window, so run B's record can no longer answer for run A.
 *
 * Records without a usable timestamp cannot be placed in any window at all
 * (hand-edited ledgers, pre-timestamp schemas). They are not silently dropped:
 * when a row has **no** in-window record they answer for the task instead, which
 * is the pre-B115 per-taskId behavior. A row that does have in-window records
 * ignores them, so the fallback can never shadow a record that provably belongs
 * to this run. Bounded: the caller already capped the tail read.
 */
function selectRunFailure(
  records: readonly FailureRecord[],
  row: Pick<GoalRunRecord, 'taskId' | 'startedAt' | 'endedAt'>
): GoalRunFailure | undefined {
  if (records.length === 0) return undefined;
  const windowEnd = row.endedAt + REVIEW_WINDOW_SLACK_MS;
  const inWindow: FailureRecord[] = [];
  const timeless: FailureRecord[] = [];
  for (const record of records) {
    if (record.taskId !== row.taskId) continue;
    if (!Number.isFinite(record.timestamp) || record.timestamp <= 0) {
      timeless.push(record);
      continue;
    }
    if (record.timestamp < row.startedAt) continue;
    if (record.timestamp > windowEnd) continue;
    inWindow.push(record);
  }
  const pool = inWindow.length > 0 ? inWindow : timeless;
  if (pool.length === 0) return undefined;
  // All survivors share the row's taskId, so the B113 rules (newest version of
  // a failureId, then latest unresolved, then latest overall) pick inside it.
  return projectFailureReasons(pool).get(row.taskId);
}

/** Attach each run's own failure reason to its fail/blocked row. */
export function projectGoalRunFailures(
  rows: readonly GoalRunRow[],
  records: readonly FailureRecord[]
): GoalRunListRow[] {
  return rows.map((row) => {
    if (row.outcome !== 'fail' && row.outcome !== 'blocked') return { ...row };
    const failure = selectRunFailure(records, row);
    return failure ? { ...row, failure } : { ...row };
  });
}

/**
 * `↳ <first line of the symptom>`, capped so one bad log line cannot wrap the
 * table. A symptom that only repeats the acceptance command adds nothing, so it
 * is skipped instead. zh labels the line with `原因：` because a bare Chinese
 * sentence after the acceptance line would read like another command.
 */
function formatFailureLine(row: GoalRunListRow, zh: boolean): string | undefined {
  if (!row.failure) return undefined;
  const first = row.failure.symptom.split(/\r?\n/).find((line) => line.trim() !== '');
  if (!first) return undefined;
  const command = row.acceptanceCommand ? normalizeLine(row.acceptanceCommand) : '';
  if (command !== '' && normalizeLine(first) === command) return undefined;
  const symptom = clip(first, REASON_PREVIEW);
  return zh ? `↳ 原因：${symptom}` : `↳ ${symptom}`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
}

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * `↳ review FAIL · 2 critical, 1 important (record rev_…)`, or
 * `↳ review PASS · 0 findings`. The id keeps a row traceable to
 * `.moss/review.jsonl` without dumping the whole record.
 */
function formatReviewLine(review: GoalRunReview, zh: boolean): string {
  const verdict = zh ? (REVIEW_VERDICT_ZH[review.verdict] ?? '未知') : review.verdict;
  const id = clip(review.id, REVIEW_ID_PREVIEW);
  const counts =
    review.total === 0
      ? zh
        ? '0 项发现'
        : '0 findings'
      : zh
        ? `${String(review.critical)} 个严重、${String(review.important)} 个重要${
            review.suggestion > 0 ? `、${String(review.suggestion)} 个建议` : ''
          }`
        : `${String(review.critical)} critical, ${String(review.important)} important${
            review.suggestion > 0 ? `, ${String(review.suggestion)} suggestion` : ''
          }`;
  return zh
    ? `↳ 评审 ${verdict} · ${counts}（记录 ${id}）`
    : `↳ review ${verdict} · ${counts} (record ${id})`;
}

/** Health of the whole ledger, not just the page shown (runs accumulate). */
export interface GoalRunCounts {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  aborted: number;
}

export function summarizeGoalRuns(records: readonly GoalRunRecord[]): GoalRunCounts {
  const counts: GoalRunCounts = { total: records.length, pass: 0, fail: 0, blocked: 0, aborted: 0 };
  for (const record of records) {
    if (record.outcome === 'pass') counts.pass += 1;
    else if (record.outcome === 'fail') counts.fail += 1;
    else if (record.outcome === 'blocked') counts.blocked += 1;
    else if (record.outcome === 'aborted') counts.aborted += 1;
  }
  return counts;
}

/**
 * Newest first. `limit` caps the rows; the caller decides the default.
 * The header counts the whole ledger even when `status` narrows the table, so
 * "how are the task runs doing" and "show me the failures" are one command.
 * With no rows the caller prints a "nothing yet" line, not an empty table.
 */
export function formatGoalRunRows(
  records: readonly GoalRunListRow[],
  options: { zh?: boolean; limit?: number; status?: GoalRunOutcome } = {}
): string[] {
  const zh = options.zh === true;
  const limit = options.limit && options.limit > 0 ? options.limit : records.length;
  if (records.length === 0) {
    return [
      zh
        ? '还没有目标运行记录（`.moss/goals.jsonl`）。先跑 `/goal <条件>` 或 `moss task run …`。'
        : 'no goal runs recorded yet (`.moss/goals.jsonl`). Start one with /goal <condition> or moss task run …',
    ];
  }
  const counts = summarizeGoalRuns(records);
  const scoped = options.status
    ? records.filter((row) => row.outcome === options.status)
    : [...records];
  const header = zh
    ? `目标运行记录（共 ${String(counts.total)} 次 · 通过 ${String(counts.pass)} · 失败 ${String(counts.fail)} · 阻塞 ${String(counts.blocked)} · 已中止 ${String(counts.aborted)}，最新在前）`
    : `task runs (${String(counts.total)} total · pass ${String(counts.pass)} · fail ${String(counts.fail)} · blocked ${String(counts.blocked)} · aborted ${String(counts.aborted)}, newest first)`;
  const statusLabel = options.status
    ? zh
      ? `（仅 ${String(scoped.length)} 条 status=${options.status}）`
      : ` — status ${options.status} (${String(scoped.length)})`
    : '';
  const lines: string[] = [`${header}${statusLabel}`];
  // Ties (two records written in the same millisecond) must still read newest
  // first: fall back to startedAt, then to the later ledger row. CI hit the
  // unstable order with two fixtures created in the same tick.
  const rows = scoped
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        right.row.endedAt - left.row.endedAt ||
        right.row.startedAt - left.row.startedAt ||
        right.index - left.index
    )
    .slice(0, limit)
    .map((entry) => entry.row);
  if (rows.length === 0) {
    lines.push(
      zh
        ? `  没有 status=${String(options.status)} 的任务运行记录`
        : `  no task runs with status ${String(options.status)}`
    );
    return lines;
  }
  const outcomeWidth = Math.max(
    ...rows.map((row) => (zh ? OUTCOME_ZH[row.outcome] : row.outcome).length)
  );
  const idWidth = Math.max(...rows.map((row) => row.taskId.length));
  // The continuation-line column: same width as the goal column in the row.
  const indent = ' '.repeat(8 + outcomeWidth + 2 + idWidth + 2 + 22 + 2 + 7);
  for (const row of rows) {
    const outcome = zh ? (OUTCOME_ZH[row.outcome] ?? row.outcome) : row.outcome;
    const counters = `att:${String(row.attempts)} rep:${String(row.repairs)} turns:${String(row.turns)}`;
    const line = [
      clockTime(row.endedAt).padEnd(8),
      outcome.padEnd(outcomeWidth),
      row.taskId.padEnd(idWidth),
      counters.padEnd(22),
      duration(row.durationMs).padStart(7),
      clip(row.goal, GOAL_PREVIEW),
    ].join('  ');
    lines.push(`  ${line}`);
    if (row.outcome === 'blocked' && row.blockedReason) {
      lines.push(`  ${indent}↳ ${clip(row.blockedReason, 96)}`);
    }
    if (row.acceptanceCommand && row.acceptanceCommand.trim() !== '') {
      lines.push(`  ${indent}↳ ${clip(row.acceptanceCommand, COMMAND_PREVIEW)}`);
    }
    const reason = formatFailureLine(row, zh);
    if (reason) {
      lines.push(`  ${indent}${reason}`);
    }
    if (row.review) {
      lines.push(`  ${indent}${formatReviewLine(row.review, zh)}`);
    }
  }
  if (scoped.length > rows.length) {
    lines.push(
      zh
        ? `  …还有 ${String(scoped.length - rows.length)} 条（--limit 调整）`
        : `  …${String(scoped.length - rows.length)} more (raise --limit)`
    );
  }
  return lines;
}
