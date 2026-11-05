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
 */
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

function clip(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
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
  records: readonly GoalRunRow[],
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
  const rows = [...scoped].sort((left, right) => right.endedAt - left.endedAt).slice(0, limit);
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
