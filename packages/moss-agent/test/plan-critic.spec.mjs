#!/usr/bin/env node
import assert from 'node:assert/strict';
import { PlanExecuteController } from '../dist/plan-execute/plan-execute-controller.js';
import {
  criticTimeoutMs,
  shouldRunCritic,
  formatCritiqueForModel,
  runPlanCritique,
} from '../dist/plan-execute/plan-critic.js';

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

// timeout configuration is bounded and has a stable default.
{
  const previous = process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS;
  try {
    delete process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS;
    assert.equal(criticTimeoutMs(), 30_000);
    process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS = '999';
    assert.equal(criticTimeoutMs(), 30_000);
    process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS = '999999';
    assert.equal(criticTimeoutMs(), 120_000);
  } finally {
    if (previous === undefined) delete process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS;
    else process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS = previous;
  }
}

// Malformed or out-of-range model output fails open instead of entering the plan.
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
  for (const payload of [
    { ok: false, issues: [{ step: 99, severity: 'high', problem: 'x', suggestedFix: 'y' }] },
    { ok: false, issues: [{ step: 1, severity: 'critical', problem: 'x', suggestedFix: 'y' }] },
    { ok: false, issues: [{ step: 1, severity: 'high', problem: '', suggestedFix: 'y' }] },
  ]) {
    const result = await runPlanCritique({
      plan,
      taskText: 't',
      runSubagent: async () => JSON.stringify(payload),
    });
    assert.deepEqual(result, { ok: true });
  }
}

// Valid output is bounded before it is returned to the parent model.
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
  const result = await runPlanCritique({
    plan,
    taskText: 't',
    runSubagent: async () => JSON.stringify({
      ok: false,
      summary: 's'.repeat(2_000),
      issues: Array.from({ length: 12 }, () => ({
        step: null,
        severity: 'low',
        problem: 'p'.repeat(2_000),
        suggestedFix: 'f'.repeat(2_000),
      })),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 8);
  assert.equal(result.summary.length, 1_000);
  assert.equal(result.issues[0].problem.length, 1_000);
}
console.log('plan-critic: ok');
