#!/usr/bin/env node
import assert from 'node:assert/strict';
import { PlanExecuteController } from '../dist/plan-execute/plan-execute-controller.js';
import { evaluatePlanCompletionGate } from '../dist/plan-execute/plan-completion-gate.js';

// helper: 造一个 controller + plan,返回 {plan, getActive}
function makePlan({ steps, status, completeSteps = [], skipSteps = [] }) {
  const c = new PlanExecuteController({
    maxReplans: 3,
    requireApproval: false,
    autoApproveSimple: false,
  });
  const plan = c.createPlan(
    'goal',
    steps.map((description, i) => ({ step: i + 1, description }))
  );
  // 把 plan 推到目标状态前,先 approve + start
  c.approvePlan(plan.id);
  c.startExecution(plan.id);
  for (const n of completeSteps) c.completeStep(plan.id, n, 'out');
  for (const n of skipSteps) c.skipStep(plan.id, n, 'reason');
  // 强制设目标 status(若 complete/skip 已自然推到 completed 则跳过)
  if (status && plan.status !== status) plan.status = status;
  const getActive = () => plan;
  return { plan, getActive };
}

// Case 1: executing 状态,5 步只完成 2 → 否决
{
  const { getActive } = makePlan({
    steps: ['s1', 's2', 's3', 's4', 's5'],
    status: 'executing',
    completeSteps: [1, 2],
  });
  const r = evaluatePlanCompletionGate(
    { sessionKey: 's', stopReason: 'end_turn' },
    { getActivePlanForSession: getActive }
  );
  assert.equal(r.ok, false);
  assert.match(r.correction, /未完成|not.*complete|plan_step/i);
  assert.equal(r.retryLimit, 2);
}

// Case 2: 全部 complete → 放行
{
  const { getActive } = makePlan({
    steps: ['s1', 's2'],
    status: 'executing',
    completeSteps: [1, 2],
  });
  const r = evaluatePlanCompletionGate({ sessionKey: 's' }, { getActivePlanForSession: getActive });
  assert.equal(r.ok, true);
}

// Case 3: escape hatch — 未完成但全 skip 带理由 → 放行
{
  // startExecution 把 step1 设 in_progress;step1 既没 complete 也没 skip
  // 为测"全 skip 放行",把 step1 也 skip
  const c = new PlanExecuteController({
    maxReplans: 3,
    requireApproval: false,
    autoApproveSimple: false,
  });
  const plan = c.createPlan('goal', [
    { step: 1, description: 's1' },
    { step: 2, description: 's2' },
  ]);
  c.approvePlan(plan.id);
  c.startExecution(plan.id);
  c.skipStep(plan.id, 1, 'r1');
  c.skipStep(plan.id, 2, 'r2');
  const r = evaluatePlanCompletionGate(
    { sessionKey: 's' },
    { getActivePlanForSession: () => plan }
  );
  assert.equal(r.ok, true, 'all steps skipped with reason -> pass');
}

// Case 4: 无 active plan → 放行
{
  const r = evaluatePlanCompletionGate(
    { sessionKey: 's' },
    { getActivePlanForSession: () => null }
  );
  assert.equal(r.ok, true);
}

// Case 5: status 不是 approved/executing(如 completed/draft)→ 放行
{
  const { plan } = makePlan({ steps: ['s1', 's2'], status: 'completed', completeSteps: [1, 2] });
  const r = evaluatePlanCompletionGate(
    { sessionKey: 's' },
    { getActivePlanForSession: () => plan }
  );
  assert.equal(r.ok, true);
}

// Case 6: 无 sessionKey → fail-open 放行(嵌入式无 session 兜底)
{
  const r = evaluatePlanCompletionGate({}, { getActivePlanForSession: () => null });
  assert.equal(r.ok, true);
}

// Case 7: getActivePlanForSession 抛错 → fail-open 放行
{
  const r = evaluatePlanCompletionGate(
    { sessionKey: 's' },
    {
      getActivePlanForSession: () => {
        throw new Error('boom');
      },
    }
  );
  assert.equal(r.ok, true);
}

// Case 8: MOSS_PLAN_GATE=off → flag off, even an unfinished executing plan passes
// (gate is a no-op so A/B baseline can be taken). Default is ON.
{
  const c = new PlanExecuteController({
    maxReplans: 3,
    requireApproval: false,
    autoApproveSimple: false,
  });
  const plan = c.createPlan('goal', ['s1', 's2', 's3']);
  c.approvePlan(plan.id);
  c.startExecution(plan.id); // executing, 0/3 done
  const prev = process.env.MOSS_PLAN_GATE;
  try {
    process.env.MOSS_PLAN_GATE = 'off';
    const r = evaluatePlanCompletionGate(
      { sessionKey: 's', stopReason: 'end_turn' },
      { getActivePlanForSession: () => plan }
    );
    assert.equal(r.ok, true, 'MOSS_PLAN_GATE=off -> unfinished plan passes (baseline mode)');
  } finally {
    if (prev === undefined) delete process.env.MOSS_PLAN_GATE;
    else process.env.MOSS_PLAN_GATE = prev;
  }
}

// Case 9: MOSS_PLAN_GATE unset (default) → gate is ON, unfinished executing plan rejected
{
  const c = new PlanExecuteController({
    maxReplans: 3,
    requireApproval: false,
    autoApproveSimple: false,
  });
  const plan = c.createPlan('goal', ['s1', 's2']);
  c.approvePlan(plan.id);
  c.startExecution(plan.id);
  const prev = process.env.MOSS_PLAN_GATE;
  try {
    delete process.env.MOSS_PLAN_GATE;
    const r = evaluatePlanCompletionGate(
      { sessionKey: 's', stopReason: 'end_turn' },
      { getActivePlanForSession: () => plan }
    );
    assert.equal(r.ok, false, 'MOSS_PLAN_GATE unset (default on) -> unfinished plan rejected');
  } finally {
    if (prev !== undefined) process.env.MOSS_PLAN_GATE = prev;
  }
}

// Case 10: approved but NOT started (0/N steps, plan.status==='approved') -> PASS.
// Rationale: the gate's job is "don't false-complete a plan mid-execution".
// An approved-but-not-started plan hasn't begun executing, so ending there is
// not "slacking off mid-run" — it's the model choosing not to execute yet.
// Blocking it forces the model to skip steps to escape, but skipStep rejects
// non-executing plans (step must be in_progress), which deadlocks the loop
// guard -> crashed runs. So the gate must NOT fire on approved-only plans.
{
  const c = new PlanExecuteController({
    maxReplans: 3,
    requireApproval: false,
    autoApproveSimple: false,
  });
  const plan = c.createPlan('goal', ['s1', 's2']);
  c.approvePlan(plan.id); // approved, 0/2, NOT started (step1 still pending, not in_progress)
  assert.equal(plan.status, 'approved');
  const prev = process.env.MOSS_PLAN_GATE;
  try {
    delete process.env.MOSS_PLAN_GATE;
    const r = evaluatePlanCompletionGate(
      { sessionKey: 's', stopReason: 'end_turn' },
      { getActivePlanForSession: () => plan }
    );
    assert.equal(r.ok, true, 'approved-but-not-started plan -> gate does not fire (no deadlock)');
  } finally {
    if (prev !== undefined) process.env.MOSS_PLAN_GATE = prev;
  }
}

console.log('plan-completion-gate: ok');
