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
 *   VERIFY_CMD hard failure (exit ExitCode.INCOMPLETE=9 so scripts can tell
 *   it from success; last line still「未验证」/ Unverified — not Completed / verify_failed)
 */
import { ExitCode } from './exit-codes.js';
import {
  createRunCompletionTracker,
  findUnverifiedCheckClaims,
  noteBackgroundProtectedPathMods,
  noteGoalVerifyResult,
  noteRunCompletionEvent,
  requestExpectsFileChanges,
  type GoalVerifyResult,
  type RunCompletionTracker,
  type SafetyBlock,
  type VerificationCheck,
} from './run-completion.js';
import {
  protectedPathModReason,
  type GitConfigChangeReason,
} from '../safety/protected-path-snapshot.js';
import { hookEventZhName } from './hook-event-names.js';

export type { GoalVerifyResult, RunCompletionTracker, VerificationCheck };
export {
  createRunCompletionTracker,
  noteBackgroundProtectedPathMods,
  noteGoalVerifyResult,
  noteRunCompletionEvent,
};

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
  /**
   * O113: when true, the stuck half uses 「被拦：…」 / `Blocked by: …`
   * (safety/approval block). Otherwise 「卡在：…」 / `stuck at: …`.
   */
  stuckWasBlocked?: boolean;
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
  /**
   * O165: an input guardrail (UserPromptSubmit hook) rejected the prompt —
   * a 「被拦」 outcome with this reason, not a rethrown run error.
   */
  inputBlocked?: string;
  inputBlockedZh?: string;
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

/** O128: last-line reason for an unresolved resolvable gate block (never 「被拦」). */
function unresolvedGateReason(block: SafetyBlock): { en: string; zh: string } {
  const path = block.path?.trim() || block.step;
  if (block.kind === 'truncated-write') {
    return {
      en: `\`${path}\` not changed (truncated when read; use edit)`,
      zh: `\`${path}\` 还没改（读取被截断，请改用 edit）`,
    };
  }
  return {
    en: `\`${path}\` not changed (read in full first, then edit)`,
    zh: `\`${path}\` 还没改（先完整读取再编辑）`,
  };
}

/** Resolve the stable O98/O99 outcome from a filled tracker + final answer. */
export function resolveRunOutcome(input: ResolveRunOutcomeInput): RunOutcome {
  const { tracker } = input;
  // O108: fold L3 hits from finished exec_background processes (late exits
  // after the tool returned a job id) before deciding incompleteness.
  noteBackgroundProtectedPathMods(tracker);
  const unverifiedClaims = findUnverifiedCheckClaims(input.finalText, tracker);
  const reasonsEn: string[] = [];
  const reasonsZh: string[] = [];
  let status: RunOutcomeStatus | undefined;
  let stuckAt: string | undefined;
  let stuckAtZh: string | undefined;

  if (input.blocked) {
    status = 'blocked';
    const reason = input.blockedReason?.trim();
    reasonsEn.push(reason || 'Stop hook blocked the run ending');
    // O91: the zh outcome line names the Stop hook with its Chinese display
    // name instead of the bare English event id.
    reasonsZh.push(reason || `${hookEventZhName('Stop')}钩子拦住了本次运行的结束`);
    stuckAt = 'Stop hook';
    stuckAtZh = `${hookEventZhName('Stop')}钩子`;
  }

  // O165: the prompt itself was rejected before the model ran — a stable
  // 「被拦」 outcome line (exit 9), like every other blocked safety outcome.
  if (input.inputBlocked) {
    status = 'blocked';
    reasonsEn.push(input.inputBlocked);
    reasonsZh.push(input.inputBlockedZh ?? input.inputBlocked);
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
        ...(m.keys ? { keys: m.keys } : {}),
        ...(m.reason ? { reason: m.reason as GitConfigChangeReason } : {}),
        ...(m.restoreOutcome
          ? {
              restoreOutcome: m.restoreOutcome as
                | 'restored'
                | 'skipped-oversize'
                | 'skipped-symlink-git'
                | 'skipped-no-snapshot'
                | 'skipped-approved'
                | 'failed',
            }
          : {}),
      })),
      mods[0]?.command
    );
    reasonsEn.push(reason.en);
    reasonsZh.push(reason.zh);
    stuckAt = stuckAt ?? reason.stuckEn;
    stuckAtZh = stuckAtZh ?? reason.stuckZh;
  }

  // O103: a protected-path write refused before it ran → incomplete, driven by
  // the block record (not by claim detection). If the model then wrote the
  // file another way, the L3 "modified" stuck half above stays authoritative.
  let protectedBlockStuck = false;
  // O121: every safety / approval refusal (block record) → incomplete. One
  // main cause on the last line, the rest as「（另有 N 处）」/`(+N more)`.
  // O128 (PM/UX): unresolved *resolvable* gate blocks (partial-read,
  // truncated-write) do NOT use 「被拦」 — they use「还没改（…）」. Safety-type
  // refusals keep 「被拦」. When both remain, safety wins.
  let skipBlockedHalf = false;
  const blocks: SafetyBlock[] =
    tracker.safetyBlocks && tracker.safetyBlocks.length > 0
      ? tracker.safetyBlocks
      : (tracker.protectedPathBlocks ?? []).map((b) => ({
          kind: 'protected' as const,
          step: b.step,
          en: b.what,
          zh: b.what,
        }));
  if (blocks.length > 0) {
    status = status ?? 'incomplete';
    const safety = blocks.filter((b) => !b.resolvable);
    const gates = blocks.filter((b) => b.resolvable);
    if (safety.length > 0) {
      const main = safety[0]!;
      const more = safety.length - 1 + gates.length;
      const moreEn = more ? ` (+${more} more)` : '';
      const moreZh = more ? `（另有 ${more} 处）` : '';
      if (main.kind === 'protected') {
        reasonsEn.push(`a protected-path write was blocked: ${main.en}${moreEn}`);
        reasonsZh.push(`受保护路径的写入被拦下：${main.zh}${moreZh}`);
        if (!stuckAt && !input.runError) {
          stuckAt = main.step;
          stuckAtZh = main.step;
          protectedBlockStuck = true;
        }
      } else {
        reasonsEn.push('a safety check refused an action');
        reasonsZh.push('有操作被安全检查拒绝');
        if (!stuckAt && !input.runError) {
          stuckAt = `${main.en}${moreEn}`;
          stuckAtZh = `${main.zh}${moreZh}`;
          protectedBlockStuck = true;
        }
      }
    } else {
      const main = gates[0]!;
      const more = gates.length - 1;
      const moreEn = more ? ` (+${more} more)` : '';
      const moreZh = more ? `（另有 ${more} 处）` : '';
      const gate = unresolvedGateReason(main);
      reasonsEn.push(`${gate.en}${moreEn}`);
      reasonsZh.push(`${gate.zh}${moreZh}`);
      skipBlockedHalf = true;
    }
  }

  // O121 (PM): loop-guard stop → incomplete, 「卡在」 (not 被拦).
  const guardStops: Array<{ step: string; en?: string; zh?: string }> =
    tracker.loopGuardStops ?? [];
  if (guardStops.length > 0) {
    status = status ?? 'incomplete';
    reasonsEn.push('the repeated-failure guard stopped a tool');
    reasonsZh.push('重复失败保护停下了工具');
    if (!stuckAt && !input.runError) {
      stuckAt = guardStops[0]!.en ?? guardStops[0]!.step;
      stuckAtZh = guardStops[0]!.zh ?? guardStops[0]!.step;
    }
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
    reasonsZh.push(zhRunErrorReason(input.runError));
  }

  if (input.request && requestExpectsFileChanges(input.request) && !tracker.wroteFiles) {
    status = status ?? 'incomplete';
    reasonsEn.push('no files were modified');
    reasonsZh.push('没有改动任何文件');
  }

  if (unverifiedClaims.length > 0 && status !== 'verify_failed') {
    const labels = unverifiedClaims.map((c) => CHECK_LABEL[c]).join(', ');
    const failedRun = unverifiedClaims.some((c) => tracker.checks.get(c));
    // Soft: no VERIFY_CMD hard failure — show「未验证」; exit is non-0 (O109).
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

  // O111: unfinished class (turn/budget/…) plus the last tool step when both
  // are known, e.g. `run budget (read_file: src/a.ts)`; either alone otherwise.
  // O113: a safety/approval block alone uses 「被拦」; budget/turn-limit classes
  // stay 「卡在」 even when a blocked tool also ran (do not mislabel budget).
  let stuckWasBlocked = false;
  if (!stuckAt) {
    const blockedStep = tracker.lastBlockedStep;
    const step = tracker.lastFailedStep ?? tracker.lastStep;
    const cls = input.runError ? stuckClassFromUnfinished(input.runError) : undefined;
    if (cls && step) {
      stuckAt = `${cls.en} (${step})`;
      stuckAtZh = `${cls.zh}（${step}）`;
    } else if (cls) {
      stuckAt = cls.en;
      stuckAtZh = cls.zh;
    } else if (blockedStep && !skipBlockedHalf) {
      stuckAt = blockedStep;
      stuckAtZh = blockedStep;
      stuckWasBlocked = true;
    } else if (step && !skipBlockedHalf) {
      stuckAt = step;
      stuckAtZh = step;
    }
  }

  // O109: soft unverified alone is ExitCode.INCOMPLETE (9), same as other
  // non-completed statuses — scripts can tell Unverified from success via exit.
  // O152: post-run protected-path detection (L3) is always exit 9, even when a
  // concurrent session-persist error would otherwise surface as exit 7
  // (SESSION). Exit 7 keeps its original meaning (session errors without L3).
  const l3 = tracker.protectedPathChanges !== undefined && tracker.protectedPathChanges.length > 0;
  const exitCode = l3
    ? ExitCode.INCOMPLETE
    : input.errorExitCode && input.errorExitCode !== 0
      ? input.errorExitCode
      : ExitCode.INCOMPLETE;

  return {
    status,
    reason: joinReasons(reasonsEn, false),
    reasonZh: joinReasons(reasonsZh, true),
    exitCode,
    ...(stuckAt ? { stuckAt } : {}),
    ...(stuckAtZh ? { stuckAtZh } : {}),
    ...(stuckWasBlocked || protectedBlockStuck ? { stuckWasBlocked: true } : {}),
  };
}

/**
 * O111: concrete stuck step when known; never a placeholder stuck step.
 * When stuckAt is absent, omit the 「卡在：…」 / `stuck at:` half entirely.
 */
function head(label: string, reason: string | undefined, zh: boolean): string {
  if (!reason) return label;
  return zh ? `${label}：${reason}` : `${label}: ${reason}`;
}

function appendStuckHalf(
  base: string,
  stuck: string | undefined,
  zh: boolean,
  blocked = false
): string {
  if (!stuck) return base;
  // O113: safety/approval block → 「被拦：…」 / `Blocked by: …`
  if (blocked) {
    return zh ? `${base}；被拦：${stuck}` : `${base}; Blocked by: ${stuck}`;
  }
  return zh ? `${base}；卡在：${stuck}` : `${base}; stuck at: ${stuck}`;
}

/**
 * O116: the headless budget error is an English sentence
 * (`Run budget exceeded (tool_calls). Partial output above …`). In zh the
 * conclusion line must not carry it verbatim — keep only the counter key as a
 * parenthesised identifier. Other runErrors pass through unchanged.
 */
export function zhRunErrorReason(runError: string): string {
  const m = /^\s*Run budget exceeded(?:\s*\(([^)]*)\))?/i.exec(runError);
  if (!m) return runError;
  const key = m[1]?.trim();
  return key ? `运行预算用尽（${key}）` : '运行预算用尽';
}

/**
 * Map unfinished runError / stop subtype to a short stuck class (O111).
 * Returns undefined when the string is not a known unfinished class.
 */
export function stuckClassFromUnfinished(runError: string): { en: string; zh: string } | undefined {
  const s = runError.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (
    /error_max_turns|max_turns_reached|tool_followup_cap|turn limit|回合上限/.test(lower) ||
    /hit the turn limit/.test(lower)
  ) {
    return { en: 'turn limit', zh: '回合上限' };
  }
  if (/tool_budget|工具预算|tool budget/.test(lower)) {
    return { en: 'tool budget', zh: '工具预算' };
  }
  if (/error_budget|budget_|运行预算|run budget|budget exceeded/.test(lower)) {
    return { en: 'run budget', zh: '运行预算' };
  }
  if (/error_output_limit|output_limit|max_tokens|输出长度|output limit/.test(lower)) {
    return { en: 'output limit', zh: '输出长度上限' };
  }
  if (/aborted_by_user|用户中断|interrupted by user/.test(lower)) {
    return { en: 'user interrupt', zh: '用户中断' };
  }
  return undefined;
}

/**
 * Mandatory last line for `-p` / TUI / O99.
 * Always non-empty: completed →「完成：…」; others → matching prefix.
 */
export function formatOutcomeLine(outcome: RunOutcome, lang: OutcomeLang): string {
  const zh = lang === 'zh';
  // O111: no placeholder reason — omit the reason when empty.
  const reason = (zh ? outcome.reasonZh : outcome.reason)?.replace(/\s+/g, ' ').trim();
  // O111: no placeholder stuck step — omit the stuck half when unset.
  const stuckRaw = zh ? outcome.stuckAtZh : outcome.stuckAt;
  const stuck = stuckRaw?.replace(/\s+/g, ' ').trim() || undefined;
  // O113: incomplete + safety block uses 「被拦」 half; Stop-hook `blocked`
  // status already carries 「被拦」/Blocked in the head — keep stuck half as 卡在.
  const blockedHalf = outcome.stuckWasBlocked === true && outcome.status === 'incomplete';
  switch (outcome.status) {
    case 'completed':
      return head(zh ? '完成' : 'Completed', reason, zh);
    case 'unverified':
      return head(zh ? '未验证' : 'Unverified', reason, zh);
    case 'verify_failed':
      return appendStuckHalf(head(zh ? '验证失败' : 'Verify failed', reason, zh), stuck, zh);
    case 'blocked':
      return appendStuckHalf(head(zh ? '被拦' : 'Blocked', reason, zh), stuck, zh);
    case 'incomplete':
    default:
      return appendStuckHalf(
        head(zh ? '未完成' : 'Incomplete', reason, zh),
        stuck,
        zh,
        blockedHalf
      );
  }
}
