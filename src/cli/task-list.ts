/**
 * `moss task list` — the goal-run rollup table.
 *
 * One row per task run (run, resume, aborted), newest first, so a long-running
 * user can answer "what did I ask across sessions, what passed, what is still
 * unfinished" without reading `.moss/*.jsonl` by hand.
 */
import type { GoalRunRecord } from '../core/task-runtime/goal-runs.js';

const OUTCOME_ZH: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  blocked: '阻塞',
  aborted: '已中止',
};

const GOAL_PREVIEW = 64;
const COMMAND_PREVIEW = 48;

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
 * Newest first. `limit` caps the rows; the caller decides the default.
 * With no rows the caller prints a "nothing yet" line, not an empty table.
 */
export function formatGoalRunRows(
  records: readonly GoalRunRecord[],
  options: { zh?: boolean; limit?: number } = {}
): string[] {
  const zh = options.zh === true;
  const limit = options.limit && options.limit > 0 ? options.limit : records.length;
  const rows = [...records].sort((left, right) => right.endedAt - left.endedAt).slice(0, limit);
  if (rows.length === 0) {
    return [
      zh
        ? '还没有目标运行记录（`.moss/goals.jsonl`）。先跑 `/goal <条件>` 或 `moss task run …`。'
        : 'no goal runs recorded yet (`.moss/goals.jsonl`). Start one with /goal <condition> or moss task run …',
    ];
  }
  const outcomeWidth = Math.max(
    ...rows.map((row) => (zh ? OUTCOME_ZH[row.outcome] : row.outcome).length)
  );
  const idWidth = Math.max(...rows.map((row) => row.taskId.length));
  const lines: string[] = [
    zh
      ? `目标运行记录（${String(rows.length)} 条，最新在前）`
      : `goal runs (${String(rows.length)}, newest first)`,
  ];
  for (const row of rows) {
    const outcome = zh ? (OUTCOME_ZH[row.outcome] ?? row.outcome) : row.outcome;
    const counts = `att:${String(row.attempts)} rep:${String(row.repairs)} turns:${String(row.turns)}`;
    const line = [
      clockTime(row.endedAt).padEnd(8),
      outcome.padEnd(outcomeWidth),
      row.taskId.padEnd(idWidth),
      counts.padEnd(22),
      duration(row.durationMs).padStart(7),
      clip(row.goal, GOAL_PREVIEW),
    ].join('  ');
    lines.push(`  ${line}`);
    if (row.acceptanceCommand && row.acceptanceCommand.trim() !== '') {
      lines.push(
        `  ${' '.repeat(8 + outcomeWidth + 2 + idWidth + 2 + 22 + 2 + 7)}↳ ${clip(row.acceptanceCommand, COMMAND_PREVIEW)}`
      );
    }
  }
  return lines;
}
