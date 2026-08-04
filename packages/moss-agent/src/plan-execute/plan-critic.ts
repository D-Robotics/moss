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

const DEFAULT_CRITIC_TIMEOUT_MS = 30_000;
const MAX_CRITIC_ISSUES = 8;
const MAX_CRITIC_TEXT_CHARS = 1_000;
const VALID_SEVERITIES = new Set<CritiqueIssue['severity']>(['high', 'medium', 'low']);

export function criticEnabled(): boolean {
  const v = readEnv('MOSS_PLAN_VALIDATE');
  return Boolean(v) && /^(1|true|on|yes)$/i.test(String(v).trim());
}
export function criticMinSteps(): number {
  const v = Number(readEnv('MOSS_PLAN_VALIDATE_MIN_STEPS'));
  return Number.isFinite(v) && v > 0 ? Math.min(1_000, Math.floor(v)) : 5;
}
export function criticTimeoutMs(): number {
  const v = Number(readEnv('MOSS_PLAN_VALIDATE_TIMEOUT_MS'));
  return Number.isFinite(v) && v >= 1_000
    ? Math.min(120_000, Math.floor(v))
    : DEFAULT_CRITIC_TIMEOUT_MS;
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

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_CRITIC_TEXT_CHARS);
}

function parseCritiqueIssue(value: unknown, stepCount: number): CritiqueIssue | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const severity = candidate.severity;
  if (typeof severity !== 'string' || !VALID_SEVERITIES.has(severity as CritiqueIssue['severity'])) return null;
  const problem = boundedText(candidate.problem);
  const suggestedFix = boundedText(candidate.suggestedFix);
  if (!problem || !suggestedFix) return null;
  const rawStep = candidate.step;
  const step = rawStep === null
    ? null
    : Number.isInteger(rawStep) && Number(rawStep) >= 1 && Number(rawStep) <= stepCount
      ? Number(rawStep)
      : undefined;
  if (step === undefined) return null;
  return { step, severity: severity as CritiqueIssue['severity'], problem, suggestedFix };
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
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return { ok: true };
    if (parsed.ok === true && (!Array.isArray(parsed.issues) || parsed.issues.length === 0)) return { ok: true };
    if (!Array.isArray(parsed.issues) || parsed.issues.length === 0) return { ok: true };
    const issues = parsed.issues
      .slice(0, MAX_CRITIC_ISSUES)
      .map((issue) => parseCritiqueIssue(issue, params.plan.steps.length));
    if (issues.some((issue) => issue === null)) return { ok: true };
    const summary = typeof parsed.summary === 'string'
      ? parsed.summary.trim().slice(0, MAX_CRITIC_TEXT_CHARS)
      : '';
    return { ok: false, summary, issues: issues as CritiqueIssue[] };
  } catch {
    return { ok: true }; // 解析失败/超时 → 放行
  }
}
