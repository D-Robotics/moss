/**
 * EvalToolsNudge — mid-run reminder when the user asked to run an eval /
 * benchmark suite but the `eval` tool has not been used.
 *
 * Soft: max 1 fire. Pairs with evaluatePlanEvalCompletionGate (eval branch).
 */

export const EVAL_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const EVAL_USER_RE =
  /(?:\beval\b|\bevaluation suite\b|\bbenchmark suite\b|跑评测|评估套件|评测套件|跑一下 eval)/iu;

export interface EvalToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  totalToolCalls: number;
  attempts: number;
}

export type EvalToolsNudgeResult = { fire: false } | { fire: true; correction: string };

export function evaluateEvalToolsNudge(request: EvalToolsNudgeRequest): EvalToolsNudgeResult {
  if (request.attempts >= EVAL_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if ((request.toolCallsByName.eval ?? 0) > 0) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !EVAL_USER_RE.test(user)) return { fire: false };

  // Conceptual "what is eval?" without asking to run a suite.
  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|execute|define|report|跑|执行)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked to run/define an eval or benchmark suite, and tools have already run without the `eval` tool. ' +
      'Use `eval` (define / run / auto / report) for formal suite results, or clearly say you are not using the eval tool. ' +
      'Do not invent benchmark scores or suite pass/fail.',
  };
}
