import { readEnv } from '../utils/env-compat.js';
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

/**
 * Whether the plan completion gate is active. Default ON (the gate is a
 * shipped feature, not an experiment). Set `MOSS_PLAN_GATE=off` to disable —
 * the gate becomes a complete no-op, so an A/B baseline can be taken against
 * the same task set with the gate off. This mirrors `criticEnabled()` in
 * plan-critic.ts but defaults the opposite way (critic defaults off).
 */
export function planGateEnabled(): boolean {
  const v = readEnv('MOSS_PLAN_GATE');
  // Explicitly off only; anything else (unset, on, yes, 1) means enabled.
  return !(v && /^(off|0|false|no)$/i.test(String(v).trim()));
}

export function evaluatePlanCompletionGate(
  request: PlanCompletionGateRequest,
  deps: PlanCompletionGateDeps,
): PlanCompletionGateResult {
  // A/B switch: when explicitly disabled, the gate is a no-op (baseline mode).
  if (!planGateEnabled()) return { ok: true };

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
  // Only guard plans that are actively executing. An approved-but-not-started
  // plan (status==='approved', steps still pending) has NOT begun execution, so
  // ending the turn there is not "slacking off mid-run" — the gate must not
  // fire. Firing on approved-only plans deadlocks: the correction tells the
  // model to plan_step skip the remaining steps, but skipStep rejects plans
  // that aren't executing (a step must be in_progress), so the model retries
  // until the tool-loop guard halts the run. See plan-completion-gate.spec.mjs
  // Case 10.
  if (plan.status !== 'executing') return { ok: true };

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
      `Continue executing the plan, or for each remaining step use your plan-management tool ` +
      `(e.g. plan_step / update_plan with action="skip") to skip it with a reason. ` +
      `Do not claim the task complete while the plan has unfinished steps.`,
  };
}
