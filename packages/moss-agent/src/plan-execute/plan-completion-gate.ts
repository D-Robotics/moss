import type { Plan } from './plan-execute-controller.js';

export interface PlanCompletionGateRequest {
  sessionKey?: string;
  stopReason?: string;
}

export interface PlanCompletionGateDeps {
  getActivePlanForSession: (sessionKey: string) => Plan | null;
}

export type PlanCompletionGateResult =
  | { ok: true }
  | { ok: false; reason: string; correction: string; retryLimit: number };

const RETRY_LIMIT = 2;

export function evaluatePlanCompletionGate(
  request: PlanCompletionGateRequest,
  deps: PlanCompletionGateDeps,
): PlanCompletionGateResult {
  // 用户中止 → 放行(与 evaluatePlanEvalCompletionGate 一致)
  if (request.stopReason === 'aborted_by_user') return { ok: true };
  const sessionKey = request.sessionKey;
  if (!sessionKey) return { ok: true }; // 无 session: fail-open

  let plan: Plan | null;
  try {
    plan = deps.getActivePlanForSession(sessionKey);
  } catch {
    return { ok: true }; // 故障 fail-open
  }
  if (!plan) return { ok: true };
  if (plan.status !== 'approved' && plan.status !== 'executing') return { ok: true };

  const total = plan.steps.length;
  const done = plan.steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  if (done >= total) return { ok: true };

  const unfinished = plan.steps
    .filter((s) => s.status !== 'completed' && s.status !== 'skipped')
    .map((s) => `Step ${s.step}: ${s.description}`)
    .join('\n');

  return {
    ok: false,
    reason: 'plan has unfinished steps',
    retryLimit: RETRY_LIMIT,
    correction:
      `[System] Plan ${plan.id} is ${plan.status} but ${total - done} step(s) remain unfinished:\n` +
      `${unfinished}\n` +
      `Continue executing the plan, or for each remaining step call plan_step action="skip" with a reason. ` +
      `Do not claim the task complete while the plan has unfinished steps.`,
  };
}
