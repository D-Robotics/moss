/**
 * Ctrl+C during a `/goal`/`/task` run pauses the task instead of failing it.
 *
 * Cursor's `/goal` pauses on Ctrl+C and can be continued; Claude resumes a
 * session whose turn was interrupted. Moss already persists the task state, so
 * the missing piece was telling the user what happened and how to continue —
 * the run used to end with a bare "interrupted" line and no task id.
 */
import { isZhLocale } from './cli-locale.js';

export interface PausedGoalCandidate {
  taskId: string;
  goal: string;
  phase: string;
}

const GOAL_PREVIEW_CHARS = 80;

export function renderPausedGoalLines(
  candidate: PausedGoalCandidate | null,
  locale?: string
): string[] {
  const zh = isZhLocale(locale);
  if (!candidate) {
    return [
      zh
        ? '[goal] 本次运行被中断；没有找到可恢复的任务状态（可能还没建立任务）。'
        : '[goal] the run was interrupted; no resumable task state was found (none may exist yet).',
      zh ? '[goal] 重新开始：/goal <条件>。' : '[goal] start again with /goal <condition>.',
    ];
  }
  const goal =
    candidate.goal.length > GOAL_PREVIEW_CHARS
      ? `${candidate.goal.slice(0, GOAL_PREVIEW_CHARS)}…`
      : candidate.goal;
  return [
    zh
      ? '[goal] 已暂停（不是失败）：任务状态已落盘，没有丢失进度。'
      : '[goal] paused by user (not a failure): the task state is on disk, no progress was lost.',
    zh
      ? `[goal] 任务 ${candidate.taskId}（${candidate.phase}）：${goal}`
      : `[goal] task ${candidate.taskId} (${candidate.phase}): ${goal}`,
    zh
      ? `[goal] 继续：/goal resume（或 /task resume ${candidate.taskId}）；放弃：/goal clear。`
      : `[goal] continue with /goal resume (or /task resume ${candidate.taskId}); abandon with /goal clear.`,
  ];
}
