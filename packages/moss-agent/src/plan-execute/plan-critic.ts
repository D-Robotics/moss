// NOTE: Real subagent-runner wiring is a deliberate follow-up. The host's
// subagent runner (core/subagent/subagent-runner.ts) is a factory
// `createSubAgentRunner(deps)` needing host-level deps (provider, sessionStore,
// streamFn, ...) constructed in moss-agent.ts; there is no clean one-shot
// prompt->assistant-text entry a tool can call from plan-tools.ts. So the
// throw in makeSubagentRunner (plan-tools.ts) is the production path.
// MOSS_PLAN_VALIDATE defaults off, so this throw never fires in normal use;
// even when the flag is on, runPlanCritique's try/catch fails open to {ok:true}
// (approve). A host-provided injection point must be added to wire the real
// runner — see task-3-brief Step 6/Step 10 follow-up.
import type { Plan } from './plan-execute-controller.js';
import { PlanExecuteController } from './plan-execute-controller.js';
import { PLAN_CRITIC_SYSTEM_PROMPT } from './plan-critic-prompt.js';
import { readEnv } from '../utils/env-compat.js';

export interface CritiqueIssue {
  step: number | null;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  suggestedFix: string;
}
export type CritiqueResult = { ok: true } | { ok: false; summary: string; issues: CritiqueIssue[] };

export function criticEnabled(): boolean {
  const v = readEnv('MOSS_PLAN_VALIDATE');
  return Boolean(v) && /^(1|true|on|yes)$/i.test(String(v).trim());
}
export function criticMinSteps(): number {
  const v = Number(readEnv('MOSS_PLAN_VALIDATE_MIN_STEPS'));
  return Number.isFinite(v) && v > 0 ? v : 5;
}
export function shouldRunCritic(plan: Plan): boolean {
  if (!criticEnabled()) return false;
  return plan.steps.length >= criticMinSteps();
}

export function formatCritiqueForModel(result: CritiqueResult): string {
  if (result.ok) return '[plan: approved by critic]';
  const lines = ['[plan: needs revision]'];
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  for (const iss of result.issues) {
    const loc = iss.step == null ? '(plan)' : `Step ${iss.step}`;
    lines.push(`- [${iss.severity}] ${loc}: ${iss.problem}`);
    lines.push(`  fix: ${iss.suggestedFix}`);
  }
  lines.push('Revise the plan (plan action="create" with revised steps) then action="approve".');
  return lines.join('\n');
}

// fail-open:任何故障 → { ok: true }(放行 approve,不阻塞执行)
export async function runPlanCritique(params: {
  plan: Plan;
  taskText: string;
  runSubagent: (input: { systemPrompt: string; userText: string }) => Promise<string>;
}): Promise<CritiqueResult> {
  try {
    const planText = PlanExecuteController.formatPlan(params.plan);
    const userText = `Task:\n${params.taskText}\n\nPlan:\n${planText}`;
    const raw = await params.runSubagent({ systemPrompt: PLAN_CRITIC_SYSTEM_PROMPT, userText });
    const parsed = JSON.parse(raw);
    if (parsed && parsed.ok === true) return { ok: true };
    if (parsed && Array.isArray(parsed.issues)) {
      return { ok: false, summary: String(parsed.summary ?? ''), issues: parsed.issues };
    }
    return { ok: true }; // 非预期格式 → 放行
  } catch {
    return { ok: true }; // 解析失败/超时 → 放行
  }
}
