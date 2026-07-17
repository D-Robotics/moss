/**
 * TodoNudge (Grok TodoNudge parity, light).
 *
 * When a multi-step coding run has already made several tool calls without
 * ever opening a `todo_write` checklist, inject one soft system reminder so
 * long refactors/fixes keep an external plan instead of thrashing mid-thread.
 *
 * Soft: at most one fire per agent run; never blocks completion (TodoGate
 * handles incomplete lists at end-of-turn).
 */

const MULTI_STEP_CODING_RE =
  /(?:fix|bug|implement|refactor|optimi[sz]e|migrate|rewrite|add\s+(?:a\s+)?(?:test|feature)|修改|修复|实现|重构|优化|迁移)/iu;

const MULTI_ITEM_HINT_RE =
  /(?:\d+\s*[.)]\s+\S|and then|然后|接着|首先|其次|最后|step\s*\d|步骤)/iu;

export interface TodoNudgeRequest {
  turns: number;
  totalToolCalls: number;
  toolCallsByName: Record<string, number>;
  /** Latest real user text (not tool_result / [System]). */
  userText: string;
  /** How many times this run already fired a todo nudge. */
  attempts: number;
}

export type TodoNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

/** Defaults aligned with Grok TodoNudge (3 turns / tools, once per run). */
export const TODO_NUDGE_MIN_TURNS = 3;
export const TODO_NUDGE_MIN_TOOLS = 3;
export const TODO_NUDGE_MAX_ATTEMPTS = 1;

export function evaluateTodoNudge(request: TodoNudgeRequest): TodoNudgeResult {
  if (request.attempts >= TODO_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if ((request.toolCallsByName.todo_write ?? 0) > 0) return { fire: false };
  if (request.turns < TODO_NUDGE_MIN_TURNS) return { fire: false };
  if (request.totalToolCalls < TODO_NUDGE_MIN_TOOLS) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user) return { fire: false };

  // Multi-step coding only — skip pure chat / one-liner asks.
  const multiStep =
    MULTI_STEP_CODING_RE.test(user) ||
    MULTI_ITEM_HINT_RE.test(user) ||
    user.length > 200;
  if (!multiStep) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] This looks like multi-step work and you have not used `todo_write` yet. ' +
      'Open a short checklist now (3–7 items, exactly one `in_progress`), then continue. ' +
      'Keeping the plan in a tool result prevents losing the thread on long fixes/refactors. ' +
      'Skip only if the remaining work is truly a single trivial step.',
  };
}
