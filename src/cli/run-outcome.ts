/**
 * O98 → O99 stable run-outcome surface.
 *
 * Tracker / claim detection stay in {@link ./run-completion.js}; this module
 * maps them to a single bilingual outcome O99 can read without re-deriving:
 *
 *   { status: 'completed' | 'incomplete' | 'unverified', reason, reasonZh, exitCode }
 *
 * - `completed` — honest finish
 * - `incomplete` — unfinished work (no edits when expected, run errors, …)
 * - `unverified` — final answer claimed checks passed without a real pass
 *   (kept distinct from `incomplete` so O99 / UX can treat false-green specially)
 */
import { ExitCode } from './exit-codes.js';
import {
  createRunCompletionTracker,
  findUnverifiedCheckClaims,
  noteRunCompletionEvent,
  requestExpectsFileChanges,
  type RunCompletionTracker,
  type VerificationCheck,
} from './run-completion.js';

export type { RunCompletionTracker, VerificationCheck };
export { createRunCompletionTracker, noteRunCompletionEvent };

export type RunOutcomeStatus = 'completed' | 'incomplete' | 'unverified';
export type OutcomeLang = 'zh' | 'en';

export interface RunOutcome {
  status: RunOutcomeStatus;
  /** English reason; empty when completed. */
  reason: string;
  /** Chinese reason; empty when completed. */
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

/** Resolve the stable O98/O99 outcome from a filled tracker + final answer. */
export function resolveRunOutcome(input: ResolveRunOutcomeInput): RunOutcome {
  const { tracker } = input;
  const unverifiedClaims = findUnverifiedCheckClaims(input.finalText, tracker);
  const reasonsEn: string[] = [];
  const reasonsZh: string[] = [];

  if (input.runError) {
    reasonsEn.push(input.runError);
    reasonsZh.push(input.runError);
  }
  if (unverifiedClaims.length > 0) {
    const labels = unverifiedClaims.map((c) => CHECK_LABEL[c]).join(', ');
    const failedRun = unverifiedClaims.some((c) => tracker.checks.get(c));
    reasonsEn.push(
      `final answer claims checks passed, but this run did not actually pass: ${labels}`
    );
    reasonsZh.push(
      `收尾声称检查已通过，但本次运行${failedRun ? '中这些检查未通过或' : ''}未实际跑过：${labels}`
    );
  }
  if (input.request && requestExpectsFileChanges(input.request) && !tracker.wroteFiles) {
    reasonsEn.push('the task needed file changes, but no file was modified');
    reasonsZh.push('任务需要改动文件，但本次运行没有修改任何文件');
  }

  if (reasonsEn.length === 0) {
    return { status: 'completed', reason: '', reasonZh: '', exitCode: ExitCode.SUCCESS };
  }

  // Prefer `unverified` when the distinctive O98 failure (false check claim) is
  // present; otherwise `incomplete` (no edits / prior run error / …).
  const status: RunOutcomeStatus = unverifiedClaims.length > 0 ? 'unverified' : 'incomplete';

  let stuckAt: string | undefined;
  let stuckAtZh: string | undefined;
  if (tracker.lastFailedStep) {
    stuckAt = tracker.lastFailedStep;
    stuckAtZh = tracker.lastFailedStep;
  } else if (unverifiedClaims.length > 0) {
    const labels = unverifiedClaims.map((c) => CHECK_LABEL[c]).join(', ');
    stuckAt = `verification (did not run ${labels})`;
    stuckAtZh = `验证（未运行 ${labels}）`;
  } else if (tracker.lastStep) {
    stuckAt = tracker.lastStep;
    stuckAtZh = tracker.lastStep;
  }

  const exitCode =
    input.errorExitCode && input.errorExitCode !== 0 ? input.errorExitCode : ExitCode.INCOMPLETE;

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
 * Mandatory last line for `-p` / O99 when the run is not honestly complete.
 * Returns '' for `completed`.
 */
export function formatOutcomeLine(outcome: RunOutcome, lang: OutcomeLang): string {
  if (outcome.status === 'completed') return '';
  const zh = lang === 'zh';
  const reason = (zh ? outcome.reasonZh : outcome.reason) || (zh ? '未知原因' : 'unknown reason');
  const stuck = (zh ? outcome.stuckAtZh : outcome.stuckAt) ?? (zh ? '未知' : 'unknown');
  if (outcome.status === 'unverified') {
    return zh ? `未核实：${reason}；卡在：${stuck}` : `Unverified: ${reason}; stuck at: ${stuck}`;
  }
  return zh ? `未完成：${reason}；卡在：${stuck}` : `Incomplete: ${reason}; stuck at: ${stuck}`;
}
