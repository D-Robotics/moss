#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlanExecuteController } from '../dist/plan-execute/index.js';

test('plan controller activates dependency-ready siblings and preserves them across failure', () => {
  const controller = new PlanExecuteController({ requireApproval: false });
  const plan = controller.createPlan('DAG', [
    { step: 1, description: 'analyse A', dependsOn: [] },
    { step: 2, description: 'analyse B', dependsOn: [] },
    { step: 3, description: 'merge', dependsOn: [1, 2] },
    { step: 4, description: 'independent verification', dependsOn: [2] },
  ]);
  assert.equal(controller.approvePlan(plan.id), true);
  assert.equal(controller.startExecution(plan.id), true);
  assert.deepEqual(
    controller
      .getPlan(plan.id)
      .steps.filter((step) => step.status === 'in_progress')
      .map((step) => step.step),
    [1, 2]
  );

  assert.equal(controller.completeStep(plan.id, 2, 'B done'), true);
  assert.equal(controller.getPlan(plan.id).steps[3].status, 'in_progress');
  assert.equal(controller.failStep(plan.id, 1, 'A failed'), true);
  assert.equal(controller.getPlan(plan.id).steps[2].status, 'blocked');
  assert.equal(
    controller.getPlan(plan.id).steps[3].status,
    'in_progress',
    'successful sibling remains runnable'
  );
});

test('omitted dependencies retain ordered-plan compatibility', () => {
  const controller = new PlanExecuteController();
  const plan = controller.createPlan('ordered', [
    { step: 1, description: 'first' },
    { step: 2, description: 'second' },
  ]);
  assert.deepEqual(
    plan.steps.map((step) => step.dependsOn),
    [[], [1]]
  );
});
