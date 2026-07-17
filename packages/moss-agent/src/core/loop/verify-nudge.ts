/**
 * VerifyNudge (mid-run counterpart to the end-of-turn coding verification gate).
 *
 * When a coding run has already made several surgical edits without any
 * verification tool, inject one soft system reminder to close the loop with
 * run_tests / verify_fix / code_diagnostics (or a real test/build exec).
 *
 * Soft: max 1 fire per agent run; never blocks completion (the CLI completion
 * gate still enforces verification evidence at end-of-turn).
 */

const CODING_CHANGE_RE =
  /(?:fix|bug|implement|refactor|optimi[sz]e|migrate|rewrite|add\s+(?:a\s+)?(?:test|feature)|repair|patch|修改|修复|实现|重构|优化|迁移|加(?:一个|个)?测试|写测试)/iu;

const SKIP_TESTS_USER_RE =
  /(?:不要跑测试|跳过测试|skip\s+tests?|no\s+tests?|only\s+(?:docs?|copy|文案)|只改文案|docs?\s+only|documentation\s+only)/iu;

/** Runtime / suite verification — silences mid-run nudge for all intents. */
const RUNTIME_VERIFY_TOOLS = new Set(['run_tests', 'verify_fix']);
/** Lint/typecheck-style only — enough for generic coding, not for fix/implement. */
const DIAGNOSTICS_TOOLS = new Set(['code_diagnostics']);

const FIX_OR_IMPLEMENT_RE =
  /(?:fix|bug|implement|refactor|repair|patch|报错|失败|崩溃|exception|error|错误|修复|修一下|实现|重构)/iu;

export interface VerifyNudgeRequest {
  turns: number;
  totalToolCalls: number;
  toolCallsByName: Record<string, number>;
  userText: string;
  attempts: number;
}

export type VerifyNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

export const VERIFY_NUDGE_MIN_TURNS = 3;
/** Weighted edit units before nudging (single-file edit_file = 1 each). */
export const VERIFY_NUDGE_MIN_EDITS = 2;
export const VERIFY_NUDGE_MAX_ATTEMPTS = 1;

function countTools(byName: Record<string, number>, names: Set<string>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (names.has(name)) n += count;
  }
  return n;
}

/**
 * Weight batch mutators higher so one multi_edit/apply_patch of many files
 * still triggers a mid-run verify reminder (they are "several edits" in intent).
 */
export function weightedEditUnits(toolCallsByName: Record<string, number>): number {
  const editFile = toolCallsByName.edit_file ?? 0;
  const writeFile = toolCallsByName.write_file ?? 0;
  const multiEdit = toolCallsByName.multi_edit ?? 0;
  const applyPatch = toolCallsByName.apply_patch ?? 0;
  const moveFile = toolCallsByName.move_file ?? 0;
  // multi_edit / apply_patch count as 2 units each (batch surgical change).
  // move_file is a layout mutation — counts as one edit unit.
  return editFile + writeFile + moveFile + multiEdit * 2 + applyPatch * 2;
}

export function evaluateVerifyNudge(request: VerifyNudgeRequest): VerifyNudgeResult {
  if (request.attempts >= VERIFY_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.turns < VERIFY_NUDGE_MIN_TURNS) return { fire: false };

  const edits = weightedEditUnits(request.toolCallsByName);
  if (edits < VERIFY_NUDGE_MIN_EDITS) return { fire: false };

  // Runtime suite already ran this turn — skip mid-run nudge.
  if (countTools(request.toolCallsByName, RUNTIME_VERIFY_TOOLS) > 0) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user) return { fire: false };
  if (SKIP_TESTS_USER_RE.test(user)) return { fire: false };
  if (!CODING_CHANGE_RE.test(user)) return { fire: false };

  const fixOrImplement = FIX_OR_IMPLEMENT_RE.test(user);
  // Diagnostics-only is enough to silence for generic coding, but not for
  // fix/implement (pairs with end-of-turn diagnostics-only rejection).
  if (!fixOrImplement && countTools(request.toolCallsByName, DIAGNOSTICS_TOOLS) > 0) {
    return { fire: false };
  }

  // Weak signal: any exec may be a test command — skip nudge to avoid noise
  // unless this is a fix/implement run still missing runtime tools.
  if (
    !fixOrImplement &&
    ((request.toolCallsByName.exec ?? 0) > 0 || (request.toolCallsByName.exec_background ?? 0) > 0)
  ) {
    return { fire: false };
  }
  // For fix/implement: still fire if only diagnostics/exec without run_tests/verify_fix
  // (end gate will require runtime green; mid-run keeps pressure on).
  if (
    fixOrImplement &&
    countTools(request.toolCallsByName, DIAGNOSTICS_TOOLS) > 0 &&
    countTools(request.toolCallsByName, RUNTIME_VERIFY_TOOLS) === 0
  ) {
    // fall through to fire
  } else if (
    fixOrImplement &&
    ((request.toolCallsByName.exec ?? 0) > 0 || (request.toolCallsByName.exec_background ?? 0) > 0)
  ) {
    // exec may already be a test command — skip to avoid double-nag; end gate checks shape
    return { fire: false };
  }

  const fixHint = fixOrImplement
    ? '`run_tests` or `verify_fix` (required for fix/implement — `code_diagnostics` alone is not enough)'
    : '`run_tests` or `verify_fix` (preferred), or `code_diagnostics`';

  return {
    fire: true,
    correction:
      '[System] You have already edited code several times without running verification. ' +
      `Before more edits: call ${fixHint}, ` +
      'or `exec` with a clear test command. Use the real output to decide the next fix. ' +
      'Do not keep patching while blind to whether the suite is green.',
  };
}
