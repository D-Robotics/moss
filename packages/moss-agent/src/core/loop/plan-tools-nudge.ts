/**
 * PlanToolsNudge — mid-run reminder when the user asked for a formal plan /
 * multi-step execution plan but plan/plan_step tools have not been used.
 *
 * Soft: max 1 fire. Pairs with evaluatePlanEvalCompletionGate (end-of-turn).
 * Does not force tools for pure prose outlines — only nudges multi-step
 * planning work that already used other tools.
 */

export const PLAN_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const PLAN_TOOLS = new Set(['plan', 'plan_step']);

const PLAN_USER_RE =
  /(?:\bplan\b|\broadmap\b|\bmilestones?\b|执行计划|方案设计|怎么拆|分阶段|里程碑|plan_step|分步实施)/iu;

export interface PlanToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  totalToolCalls: number;
  attempts: number;
}

export type PlanToolsNudgeResult = { fire: false } | { fire: true; correction: string };

function countPlanTools(byName: Record<string, number>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (PLAN_TOOLS.has(name)) n += count;
  }
  return n;
}

export function evaluatePlanToolsNudge(request: PlanToolsNudgeRequest): PlanToolsNudgeResult {
  if (request.attempts >= PLAN_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  // Multi-step work already underway — avoid pre-tool noise.
  if (request.totalToolCalls < 2) return { fire: false };
  if (countPlanTools(request.toolCallsByName) > 0) return { fire: false };
  // Already using todo_write as a lightweight checklist — do not double-nag.
  if ((request.toolCallsByName.todo_write ?? 0) > 0) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !PLAN_USER_RE.test(user)) return { fire: false };

  // Short "what's the plan?" conceptual questions without multi-step execution ask.
  if (
    user.length < 80 &&
    /(?:what(?:'s| is) (?:the |your )?plan|有什么计划)/iu.test(user) &&
    !/(?:execute|implement|分阶段|里程碑|steps?)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked for a multi-step plan / roadmap, and you have already used tools without `plan` / `plan_step`. ' +
      'If you need formal plan state (approve/start/complete steps), use those tools. ' +
      'If you only need a short prose outline, say so and consider `todo_write` for a lightweight checklist — ' +
      'do not claim formal plan execution without plan tools.',
  };
}
