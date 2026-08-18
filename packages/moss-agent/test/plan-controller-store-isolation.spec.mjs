#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlanControllerStore } from '../dist/plan-execute/index.js';

test('plan controller state is isolated per agent-owned store', () => {
  const first = new PlanControllerStore();
  const second = new PlanControllerStore();
  const plan = first
    .getPlanController('shared-session')
    .createPlan('first agent goal', [{ step: 1, description: 'only first sees this' }]);
  first.setActivePlanId('shared-session', plan.id);

  assert.equal(first.getActivePlanForSession('shared-session')?.id, plan.id);
  assert.equal(second.getActivePlanForSession('shared-session'), null);
  assert.notEqual(
    first.getPlanController('shared-session'),
    second.getPlanController('shared-session')
  );
});
