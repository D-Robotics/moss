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

const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);

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
  // multi_edit / apply_patch count as 2 units each (batch surgical change).
  return editFile + writeFile + multiEdit * 2 + applyPatch * 2;
}

export function evaluateVerifyNudge(request: VerifyNudgeRequest): VerifyNudgeResult {
  if (request.attempts >= VERIFY_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.turns < VERIFY_NUDGE_MIN_TURNS) return { fire: false };

  const edits = weightedEditUnits(request.toolCallsByName);
  if (edits < VERIFY_NUDGE_MIN_EDITS) return { fire: false };

  // Already verified this run (dedicated tools).
  if (countTools(request.toolCallsByName, VERIFY_TOOLS) > 0) return { fire: false };

  // Weak signal: any exec may be a test command — skip nudge to avoid noise.
  // The end-of-turn gate still requires a real verification-shaped command.
  if ((request.toolCallsByName.exec ?? 0) > 0 || (request.toolCallsByName.exec_background ?? 0) > 0) {
    return { fire: false };
  }

  const user = (request.userText || '').trim();
  if (!user) return { fire: false };
  if (SKIP_TESTS_USER_RE.test(user)) return { fire: false };
  if (!CODING_CHANGE_RE.test(user)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] You have already edited code several times without running verification. ' +
      'Before more edits: call `run_tests` or `verify_fix` (preferred), or `code_diagnostics`, ' +
      'or `exec` with a clear test/build/typecheck command. Use the real output to decide the next fix. ' +
      'Do not keep patching while blind to whether the suite is green.',
  };
}
