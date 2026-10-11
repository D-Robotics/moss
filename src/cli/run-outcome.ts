/**
 * O98 → O99 stable run-outcome surface.
 *
 * Tracker / claim detection stay in {@link ./run-completion.js}; this module
 * maps them to a single bilingual outcome O99 can read without re-deriving:
 *
 *   { status: 'completed' | 'incomplete' | 'verify_failed' | 'blocked' | 'unverified',
 *     reason, reasonZh, exitCode }
 *
 * - `completed` — honest finish (formatOutcomeLine always returns「完成：…」)
 * - `incomplete` — unfinished work (no edits when expected, run errors, …) → non-0
 * - `verify_failed` — MOSS_GOAL_VERIFY_CMD failed / timed out / would not start → non-0
 * - `blocked` — Stop hook blocked the run ending → non-0
 * - `unverified` — final answer claimed checks passed without a real pass, and no
 *   VERIFY_CMD hard failure (exit 0 so pure Q&A is not punished; last line「未验证」)
 */
import { ExitCode } from './exit-codes.js';
import {
  createRunCompletionTracker,
  findUnverifiedCheckClaims,
  noteGoalVerifyResult,
  noteRunCompletionEvent,
  requestExpectsFileChanges,
  type GoalVerifyResult,
  type RunCompletionTracker,
  type VerificationCheck,
} from './run-completion.js';
import { protectedPathModReason } from '../safety/protected-path-snapshot.js';

export type { GoalVerifyResult, RunCompletionTracker, VerificationCheck };
export { createRunCompletionTracker, noteGoalVerifyResult, noteRunCompletionEvent };

export type RunOutcomeStatus =
  | 'completed'
  | 'incomplete'
  | 'verify_failed'
  | 'blocked'
  | 'unverified';
export type OutcomeLang = 'zh' | 'en';

export interface RunOutcome {
  status: RunOutcomeStatus;
  /** English reason. */
  reason: string;
  /** Chinese reason. */
  reasonZh: string;
  exitCode: number;
  /** Where the run got stuck (English), when known. */
  stuckAt?: string;
  /** Where the run got stuck (Chinese), when known. */
  stuckAtZh?: string;
}

export interface ResolveRunOutcomeInput {
  tracker: RunCompletionTracker;
  finalText: string;
  request?: string;
  runError?: string;
  errorExitCode?: number;
  /** Stop hook blocked the run ending. */
  blocked?: boolean;
  blockedReason?: string;
}

const CHECK_LABEL: Record<VerificationCheck, string> = {
  check: 'npm run check',
  format: 'format:check',
  lint: 'lint',
  typecheck: 'typecheck',
  test: 'test',
};

function joinReasons(parts: string[], zh: boolean): string {
  return parts
    .filter(Boolean)
    .join(zh ? '；' : '; ')
    .replace(/\s+/g, ' ')
    .trim();
}

function goalVerifyFailReason(
  tracker: RunCompletionTracker
): { en: string; zh: string; stuckEn: string; stuckZh: string } | undefined {
  const gv = tracker.goalVerify;
  if (!gv || gv.passed) return undefined;
  const cmd = gv.command.replace(/\s+/g, ' ').trim().slice(0, 120);
  const detail = (gv.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (gv.timedOut) {
    const en = detail
      ? `verification command timed out: ${cmd} (${detail})`
      : `verification command timed out: ${cmd}`;
    const zh = detail ? `验证命令超时：${cmd}（${detail}）` : `验证命令超时：${cmd}`;
    return { en, zh, stuckEn: `VERIFY_CMD timeout: ${cmd}`, stuckZh: `VERIFY_CMD 超时：${cmd}` };
  }
  if (gv.spawnFailed) {
    const en = detail
      ? `verification command failed to start: ${cmd} (${detail})`
      : `verification command failed to start: ${cmd}`;
    const zh = detail ? `验证命令未能启动：${cmd}（${detail}）` : `验证命令未能启动：${cmd}`;
    return {
      en,
      zh,
      stuckEn: `VERIFY_CMD spawn failed: ${cmd}`,
      stuckZh: `VERIFY_CMD 启动失败：${cmd}`,
    };
  }
  const tail = detail ? ` — ${detail}` : '';
  const en = `model claimed checks passed, but verification failed: ${cmd} (exit ${gv.exitCode ?? 'non-zero'})${tail}`;
  const zh = `模型声称通过，但验证失败：${cmd}（退出码 ${gv.exitCode ?? '非 0'}）${tail}`;
  return {
    en,
    zh,
    stuckEn: `VERIFY_CMD: ${cmd}`,
    stuckZh: `VERIFY_CMD：${cmd}`,
  };
}

/** Resolve the stable O98/O99 outcome from a filled tracker + final answer. */
export function resolveRunOutcome(input: ResolveRunOutcomeInput): RunOutcome {
  const { tracker } = input;
  const unverifiedClaims = findUnverifiedCheckClaims(input.finalText, tracker);
  const reasonsEn: string[] = [];
  const reasonsZh: string[] = [];
  let status: RunOutcomeStatus | undefined;
  let stuckAt: string | undefined;
  let stuckAtZh: string | undefined;

  if (input.blocked) {
    status = 'blocked';
    const reason = input.blockedReason?.trim() || 'Stop hook blocked the run ending';
    reasonsEn.push(reason);
    reasonsZh.push(reason);
    stuckAt = 'Stop hook';
    stuckAtZh = 'Stop 钩子';
  }

  // O101 layer 3: protected-path post-run detection → incomplete (model
  // success claims must not override).
  if (tracker.protectedPathChanges && tracker.protectedPathChanges.length > 0) {
    status = status ?? 'incomplete';
    const mods = tracker.protectedPathChanges;
    const reason = protectedPathModReason(
      mods.map((m) => ({
        path: m.path,
        kind: (m.kind as 'added' | 'modified' | 'deleted') || 'modified',
      })),
      mods[0]?.command
    );
    reasonsEn.push(reason.en);
    reasonsZh.push(reason.zh);
    stuckAt = stuckAt ?? reason.stuckEn;
    stuckAtZh = stuckAtZh ?? reason.stuckZh;
  }

  // Authoritative VERIFY_CMD success: the accept loop is the completion signal.
  // Do not demote to incomplete just because the continuation turn itself
  // edited no files (the model may have fixed things in an earlier turn).
  if (!status && tracker.goalVerify?.passed === true && !input.runError) {
    return {
      status: 'completed',
      reason: 'verification passed',
      reasonZh: '验证已通过',
      exitCode: ExitCode.SUCCESS,
    };
  }

  const verifyFail = goalVerifyFailReason(tracker);
  if (verifyFail) {
    status = status ?? 'verify_failed';
    reasonsEn.push(verifyFail.en);
    reasonsZh.push(verifyFail.zh);
    stuckAt = stuckAt ?? verifyFail.stuckEn;
    stuckAtZh = stuckAtZh ?? verifyFail.stuckZh;
  }

  if (input.runError) {
    status = status ?? 'incomplete';
    reasonsEn.push(input.runError);
    reasonsZh.push(input.runError);
  }

  if (input.request && requestExpectsFileChanges(input.request) && !tracker.wroteFiles) {
    status = status ?? 'incomplete';
    reasonsEn.push('no files were modified');
    reasonsZh.push('没有改动任何文件');
  }

  if (unverifiedClaims.length > 0 && status !== 'verify_failed') {
    const labels = unverifiedClaims.map((c) => CHECK_LABEL[c]).join(', ');
    const failedRun = unverifiedClaims.some((c) => tracker.checks.get(c));
    // Soft: no VERIFY_CMD hard failure — show「未验证」, exit 0 unless another
    // hard failure already selected a non-completed status.
    if (!status) status = 'unverified';
    reasonsEn.push(
      failedRun
        ? `claimed checks passed, but they did not pass in this run: ${labels}`
        : `claimed checks passed, but no check was run: ${labels}`
    );
    reasonsZh.push(
      failedRun
        ? `声称检查已通过，但本次运行未通过：${labels}`
        : `声称检查已通过，但没有跑检查：${labels}`
    );
    if (!stuckAt) {
      stuckAt = `verification (did not run ${labels})`;
      stuckAtZh = `验证（未运行 ${labels}）`;
    }
  }

  if (!status) {
    const passedVerify = tracker.goalVerify?.passed === true;
    const reasonEn = passedVerify ? 'verification passed' : 'run finished';
    const reasonZh = passedVerify ? '验证已通过' : '运行结束';
    return {
      status: 'completed',
      reason: reasonEn,
      reasonZh,
      exitCode: ExitCode.SUCCESS,
    };
  }

  if (tracker.lastFailedStep && !stuckAt) {
    stuckAt = tracker.lastFailedStep;
    stuckAtZh = tracker.lastFailedStep;
  } else if (tracker.lastStep && !stuckAt) {
    stuckAt = tracker.lastStep;
    stuckAtZh = tracker.lastStep;
  }

  // Soft unverified alone stays exit 0; everything else is non-zero.
  let exitCode = ExitCode.SUCCESS;
  if (status === 'unverified' && !input.runError && !input.blocked && !verifyFail) {
    exitCode = ExitCode.SUCCESS;
  } else if (input.errorExitCode && input.errorExitCode !== 0) {
    exitCode = input.errorExitCode;
  } else {
    exitCode = ExitCode.INCOMPLETE;
  }

  return {
    status,
    reason: joinReasons(reasonsEn, false),
    reasonZh: joinReasons(reasonsZh, true),
    exitCode,
    ...(stuckAt ? { stuckAt } : {}),
    ...(stuckAtZh ? { stuckAtZh } : {}),
  };
}

/**
 * Mandatory last line for `-p` / TUI / O99.
 * Always non-empty: completed →「完成：…」; others → matching prefix.
 */
export function formatOutcomeLine(outcome: RunOutcome, lang: OutcomeLang): string {
  const zh = lang === 'zh';
  const reason = (zh ? outcome.reasonZh : outcome.reason) || (zh ? '未知原因' : 'unknown reason');
  const stuck = (zh ? outcome.stuckAtZh : outcome.stuckAt) ?? (zh ? '未知' : 'unknown');
  switch (outcome.status) {
    case 'completed':
      return zh ? `完成：${reason}` : `Completed: ${reason}`;
    case 'unverified':
      return zh ? `未验证：${reason}` : `Unverified: ${reason}`;
    case 'verify_failed':
      return zh
        ? `验证失败：${reason}；卡在：${stuck}`
        : `Verify failed: ${reason}; stuck at: ${stuck}`;
    case 'blocked':
      return zh ? `被拦：${reason}；卡在：${stuck}` : `Blocked: ${reason}; stuck at: ${stuck}`;
    case 'incomplete':
    default:
      return zh ? `未完成：${reason}；卡在：${stuck}` : `Incomplete: ${reason}; stuck at: ${stuck}`;
  }
}
