#!/usr/bin/env node
import assert from 'node:assert/strict';
import { PlanExecuteController } from '../dist/plan-execute/plan-execute-controller.js';
import { shouldRunCritic, formatCritiqueForModel, runPlanCritique } from '../dist/plan-execute/plan-critic.js';

// shouldRunCritic: steps < min(默认5) → false
{
  const prev = process.env.MOSS_PLAN_VALIDATE;
  process.env.MOSS_PLAN_VALIDATE = 'on';
  try {
    const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
    const plan = c.createPlan('g', [{ step: 1, description: 'a' }, { step: 2, description: 'b' }]);
    assert.equal(shouldRunCritic(plan), false, '2 steps < min 5 -> no critique');
  } finally {
    if (prev === undefined) delete process.env.MOSS_PLAN_VALIDATE; else process.env.MOSS_PLAN_VALIDATE = prev;
  }
}
// steps >= min → true
{
  const prev = process.env.MOSS_PLAN_VALIDATE;
  process.env.MOSS_PLAN_VALIDATE = 'on';
  try {
    const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
    const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
    assert.equal(shouldRunCritic(plan), true, '6 steps >= min 5 -> critique');
  } finally {
    if (prev === undefined) delete process.env.MOSS_PLAN_VALIDATE; else process.env.MOSS_PLAN_VALIDATE = prev;
  }
}

// formatCritiqueForModel: 把 issues 列成文本
{
  const text = formatCritiqueForModel({
    ok: false,
    summary: 'plan missing a verify step',
    issues: [{ step: 3, severity: 'high', problem: 'no verification', suggestedFix: 'add a test step' }],
  });
  assert.match(text, /needs revision|needs_review/i);
  assert.match(text, /no verification/);
  assert.match(text, /add a test step/);
}
// formatCritiqueForModel: ok 时返回安全文本
{
  const text = formatCritiqueForModel({ ok: true });
  assert.match(text, /approved|ok/i);
}

// runPlanCritique: issues 非空 → ok:false
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
  const r = await runPlanCritique({
    plan,
    taskText: 'do the thing',
    runSubagent: async () => JSON.stringify({ ok: false, summary: 'no verify step', issues: [{ step: 5, severity: 'high', problem: 'no test', suggestedFix: 'add test' }] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].problem, 'no test');
}
// runPlanCritique: subagent 抛错 → fail-open ok:true
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
  const r = await runPlanCritique({ plan, taskText: 't', runSubagent: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, true, 'critic failure -> fail-open approve');
}
console.log('plan-critic: ok');
