#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  getPlanController,
  getSharedPlanController,
  setActivePlanId,
  getActivePlanId,
  getActivePlanForSession,
  resetPlanControllerStoreForTests,
} from '../dist/plan-execute/plan-controller-store.js';

// per-session: 不同 sessionKey 拿到不同实例
{
  resetPlanControllerStoreForTests();
  const a = getPlanController('sess-a');
  const b = getPlanController('sess-b');
  assert.notEqual(a, b, 'different sessionKeys get different controllers');
  assert.equal(getPlanController('sess-a'), a, 'same sessionKey returns same instance');
}

// activePlanId 按 session 隔离 —— A 的 gate 查不到 B 的 plan
{
  resetPlanControllerStoreForTests();
  const a = getPlanController('sess-a');
  const b = getPlanController('sess-b');
  const planA = a.createPlan('goal A', [{ step: 1, description: 'do A' }]);
  const planB = b.createPlan('goal B', [{ step: 1, description: 'do B' }]);
  setActivePlanId('sess-a', planA.id);
  setActivePlanId('sess-b', planB.id);
  assert.equal(getActivePlanId('sess-a'), planA.id);
  assert.equal(getActivePlanId('sess-b'), planB.id);
  // A 的 session 只看到 A 的 plan
  assert.equal(getActivePlanForSession('sess-a')?.id, planA.id);
  assert.equal(getActivePlanForSession('sess-a')?.goal, 'goal A');
  assert.equal(getActivePlanForSession('sess-b')?.id, planB.id);
  // 关键:A 查不到 B
  assert.notEqual(getActivePlanForSession('sess-a')?.id, planB.id);
}

// shared fallback: 无 session 兜底共享实例
{
  resetPlanControllerStoreForTests();
  const s1 = getSharedPlanController();
  const s2 = getSharedPlanController();
  assert.equal(s1, s2, 'shared fallback returns same instance');
}

// 未知 session: getActivePlanForSession 返回 null
{
  resetPlanControllerStoreForTests();
  assert.equal(getActivePlanForSession('nope'), null);
}
console.log('plan-controller-store: ok');
