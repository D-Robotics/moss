#!/usr/bin/env node
/**
 * promotion-gate(T3.4)— D6 升层闸双门槛。
 */
import assert from 'node:assert/strict';
import {
  evaluatePromotion,
  DEFAULT_PROMOTION_THRESHOLDS,
} from '../dist/acceptance/promotion-gate.js';

const mkStats = (over = {}) => ({
  skill: 'rdk-device',
  total: 20,
  pass: 15,
  fail: 5,
  unknown: 0,
  successRate: 0.75,
  proofCount: 20,
  failureReasons: {},
  ...over,
});

// ─── 1. 双门槛都过 → 升层候选 ───────────────────────────────────────────────
{
  const stats = mkStats({ proofCount: 20, successRate: 0.75 });
  const d = await evaluatePromotion(stats, async () => true); // 跨信号确认
  assert.equal(d.promotable, true);
  assert.equal(d.statisticalPassed, true);
  assert.equal(d.crossSignalPassed, true);
}
console.log('✓ 双门槛都过 → 升层候选');

// ─── 2. 仅统计过(跨信号未确认)→ 拒(相关性≠正确性,D6 核心)────────────────
{
  const stats = mkStats({ proofCount: 20, successRate: 0.75 });
  const d = await evaluatePromotion(stats, async () => false); // 跨信号未确认
  assert.equal(d.promotable, false);
  assert.equal(d.statisticalPassed, true);
  assert.equal(d.crossSignalPassed, false);
  assert.match(d.reason, /相关性 ≠ 正确性/);
}
console.log('✓ 仅统计过 → 拒(相关性≠正确性)— D6 核心防误升');

// ─── 3. 仅跨信号确认(统计不足)→ 拒 ──────────────────────────────────────────
{
  // 跨信号确认 true,但 proofCount 不足 → 拒(短路:统计没过不调 verifier)
  let verifierCalled = false;
  const stats = mkStats({ proofCount: 3, successRate: 0.9 }); // proofCount < 10
  const d = await evaluatePromotion(stats, async () => {
    verifierCalled = true;
    return true;
  });
  assert.equal(d.promotable, false);
  assert.equal(d.statisticalPassed, false);
  assert.equal(d.crossSignalPassed, false);
  assert.equal(verifierCalled, false, '统计没过 → 短路,不调 verifier');
  assert.match(d.reason, /样本不足/);
}
console.log('✓ 统计不足 → 拒 + 短路不调 verifier(冷启动保护)');

// ─── 4. successRate 低 → 拒 ───────────────────────────────────────────────────
{
  const stats = mkStats({ proofCount: 20, successRate: 0.4 }); // < 0.7
  const d = await evaluatePromotion(stats, async () => true);
  assert.equal(d.promotable, false);
  assert.equal(d.statisticalPassed, false);
  assert.match(d.reason, /成功率/);
}
console.log('✓ successRate 低 → 拒');

// ─── 5. 默认 verifier(无注入)全 reject → 即使统计过也拒 ─────────────────────
{
  const stats = mkStats({ proofCount: 20, successRate: 0.8 });
  const d = await evaluatePromotion(stats); // 默认 verifier = reject
  assert.equal(d.promotable, false, '默认拒(层3未实现,保守)');
  assert.equal(d.crossSignalPassed, false);
}
console.log('✓ 默认 verifier reject → 保守拒升层(层3未接线)');

// ─── 6. 边界:proofCount 恰好 = 阈值 + successRate 恰好 = 阈值 ────────────────
{
  const stats = mkStats({ proofCount: 10, successRate: 0.7 }); // 恰好达标
  const d = await evaluatePromotion(stats, async () => true);
  assert.equal(d.statisticalPassed, true);
  assert.equal(d.promotable, true, '边界值达标');

  // 低于阈值一丁点 → 拒
  const stats2 = mkStats({ proofCount: 9, successRate: 0.7 });
  const d2 = await evaluatePromotion(stats2, async () => true);
  assert.equal(d2.statisticalPassed, false);
}
console.log('✓ 边界值:proofCount/successRate 恰好达标→过,低一点→拒');

console.log('\n✅ promotion-gate T3.4 全部通过(6/6)');
