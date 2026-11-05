/**
 * B125: carry the last autonomous run into the next chat turn.
 *
 * A `/goal` or `/task` run writes its own session (`taskSessionKey`), so the
 * conversation that follows starts blind: the user has to paste the task id or
 * the agent re-reads `.moss/`. Cursor/Claude Code keep the interrupted run in
 * context. This builds a compact, factual `<turn-context>` note (task id, goal,
 * counts, acceptance authority, last failure, resume command) that the REPL
 * hands to exactly the next user turn and then drops.
 */
import type { TaskStatusJson } from './task-run.js';

const GOAL_LIMIT = 160;
const SYMPTOM_LIMIT = 120;

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

/**
 * One compact note for the model, in the CLI locale. Returns an empty string
 * when there is nothing worth carrying (no task at all).
 */
export function formatRunContextNote(status: TaskStatusJson, zh = false): string {
  if (!status.taskId) return '';
  const lines: string[] = [];
  const outcome = status.phase;
  if (zh) {
    lines.push(`[任务状态] 本次会话最近一次自主运行：${status.taskId} — 阶段 ${outcome}。`);
    lines.push(`目标：${truncate(status.goal, GOAL_LIMIT)}`);
    lines.push(
      `尝试 ${status.attempt} · 修复 ${status.repairs} · 失败 ${status.failures} · 证据 ${status.evidence}`
    );
    if (status.acceptanceCommand) lines.push(`验收命令：${status.acceptanceCommand}`);
    if (status.lastFailure) {
      lines.push(
        `最近失败：${status.lastFailure.stage} — ${truncate(status.lastFailure.symptom, SYMPTOM_LIMIT)}${
          status.lastFailure.resolved ? '（已解决）' : ''
        }`
      );
    }
    if (status.engineFailure) lines.push(`引擎记录：${status.engineFailure}`);
    if (status.blockedReason)
      lines.push(`阻塞原因：${truncate(status.blockedReason, SYMPTOM_LIMIT)}`);
    lines.push(
      status.resumable
        ? `可续跑：moss task resume ${status.taskId}（REPL 里 /goal resume ${status.taskId}）`
        : '该任务已结束，不能 resume。'
    );
    lines.push(`详情：moss task status ${status.taskId} --json（账本 .moss/task-events.jsonl）`);
  } else {
    lines.push(
      `[task-state] Latest autonomous run in this session: ${status.taskId} — phase ${outcome}.`
    );
    lines.push(`goal: ${truncate(status.goal, GOAL_LIMIT)}`);
    lines.push(
      `attempts ${status.attempt} · repairs ${status.repairs} · failures ${status.failures} · evidence ${status.evidence}`
    );
    if (status.acceptanceCommand) lines.push(`acceptance: ${status.acceptanceCommand}`);
    if (status.lastFailure) {
      lines.push(
        `last failure: ${status.lastFailure.stage} — ${truncate(status.lastFailure.symptom, SYMPTOM_LIMIT)}${
          status.lastFailure.resolved ? ' (resolved)' : ''
        }`
      );
    }
    if (status.engineFailure) lines.push(`engine record: ${status.engineFailure}`);
    if (status.blockedReason)
      lines.push(`blocked: ${truncate(status.blockedReason, SYMPTOM_LIMIT)}`);
    lines.push(
      status.resumable
        ? `resume: moss task resume ${status.taskId} (REPL: /goal resume ${status.taskId})`
        : 'this task is settled and cannot be resumed.'
    );
    lines.push(
      `details: moss task status ${status.taskId} --json (ledger .moss/task-events.jsonl)`
    );
  }
  return lines.join('\n');
}
