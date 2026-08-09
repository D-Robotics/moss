/**
 * AmbiguityNudge — mid-run soft ask when a coding request is multi-interpretation
 * and the model already mutated code without clarifying or stating an assumption.
 *
 * Complements end-of-turn investigation gates: fires once while tools are still
 * running so the parent does not invent a silent scope choice.
 *
 * Soft: max 1 fire per run; never blocks completion.
 */

const AMBIGUITY_RE =
  /(?:\bor\b|\beither\b|\balternatively\b|要么|或者|还是|两(?:种|个)方案|maybe|perhaps|不确定|不清楚|which (?:one|approach)|选哪个)/iu;

const CODING_RE =
  /(?:fix|bug|implement|refactor|optimi[sz]e|migrate|rewrite|add\s+(?:a\s+)?(?:test|feature)|修改|修复|实现|重构|优化|迁移)/iu;

const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file', 'apply_patch']);

export const AMBIGUITY_NUDGE_MAX_ATTEMPTS = 1;
export const AMBIGUITY_NUDGE_MIN_EDITS = 1;

export interface AmbiguityNudgeRequest {
  toolCallsByName: Record<string, number>;
  userText: string;
  /** Whether ask_user_question was already used this run. */
  attempts: number;
}

export type AmbiguityNudgeResult = { fire: false } | { fire: true; correction: string };

function countEdits(byName: Record<string, number>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (EDIT_TOOLS.has(name)) n += count;
  }
  return n;
}

/**
 * True when the user message looks multi-interpretation for coding work.
 * @internal exported for tests
 */
export function looksAmbiguousCodingRequest(userText: string): boolean {
  const user = (userText || '').trim();
  if (!user || user.length < 40) return false;
  if (!CODING_RE.test(user)) return false;
  if (!AMBIGUITY_RE.test(user)) return false;
  // Single short either/or without coding verbs already filtered
  return true;
}

export function evaluateAmbiguityNudge(request: AmbiguityNudgeRequest): AmbiguityNudgeResult {
  if (request.attempts >= AMBIGUITY_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if ((request.toolCallsByName.ask_user_question ?? 0) > 0) return { fire: false };
  if (countEdits(request.toolCallsByName) < AMBIGUITY_NUDGE_MIN_EDITS) return { fire: false };
  if (!looksAmbiguousCodingRequest(request.userText)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user request looks multi-interpretation (either/or / 要么…或者…), and you already edited code ' +
      'without `ask_user_question` or an explicit stated assumption. ' +
      'Before more edits: either call `ask_user_question` with 2–4 concrete choices, or state in one line which ' +
      'interpretation you chose and why, then keep that scope for the rest of the run. ' +
      'Do not silently switch interpretations mid-task.',
  };
}
