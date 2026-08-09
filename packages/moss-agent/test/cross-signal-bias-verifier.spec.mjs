#!/usr/bin/env node
/**
 * cross-signal-bias-verifier — D6 ② 测量有效性跨信号确认(injectable)。
 * 验:无独立参考→false;U5 系统偏差→false;信号一致→true;长度不匹配→false;
 *    注入 evaluatePromotion 端到端(偏差→non-promotable,一致→promotable)。
 */
import assert from 'node:assert/strict';
import { createBiasDetectionVerifier } from '../dist/acceptance/cross-signal-bias-verifier.js';
import { evaluatePromotion } from '../dist/acceptance/promotion-gate.js';

const candidate = {
  id: 'term_grasp-skill',
  targetSkill: 'grasp-skill',
  provenance: {
    layer: 'L2',
    kind: 'explicit-proposal',
    source: 'terminal-hard-signal',
    proposalRef: 'x',
  },
};
const stats = (skill) => ({
  skill,
  total: 30,
  pass: 30,
  fail: 0,
  unknown: 0,
  successRate: 1.0,
  proofCount: 30,
  failureReasons: {},
});

// ─── 1. 无 biasReference(production 默认)→ false ─────────────────────────────
{
  const v = createBiasDetectionVerifier({});
  assert.equal(await v(candidate), false, '无独立参考 → false(保守拒确认)');
}
console.log('✓ 无 biasReference → false(production 保守)');

// ─── 2. biasReference 返 null → false ─────────────────────────────────────────
{
  const v = createBiasDetectionVerifier({
    biasReference: async () => null,
    measurementExtractor: async () => [8, 8, 8],
  });
  assert.equal(await v(candidate), false, '独立参考 null → false');
}
console.log('✓ biasReference 返 null → false');

// ─── 3. U5 系统偏差(视觉恒 +8,编码器恒 0)→ false ──────────────────────────
{
  const v = createBiasDetectionVerifier({
    measurementExtractor: async () => [8, 8, 8, 8, 8], // 视觉读的误差(恒定 +8 系统偏差)
    biasReference: async () => [0, 0, 0, 0, 0], // 编码器(无偏差)真实误差
    biasTolerance: 0.01,
  });
  assert.equal(await v(candidate), false, '8mm 系统偏差 → 测量无效 → false(D6 切断自证循环)');
}
console.log('✓ U5 系统偏差(视觉+8/编码器0)→ false');

// ─── 4. 信号一致(无偏差)→ true ─────────────────────────────────────────────
{
  const v = createBiasDetectionVerifier({
    measurementExtractor: async () => [2, 1, 3, 2, 1],
    biasReference: async () => [2, 1, 3, 2, 1], // 完全一致
    biasTolerance: 0.01,
  });
  assert.equal(await v(candidate), true, '信号一致 → 测量有效性确认 → true');
}
console.log('✓ 信号一致(无偏差)→ true');

// ─── 5. 长度不匹配 → false ──────────────────────────────────────────────────
{
  const v = createBiasDetectionVerifier({
    measurementExtractor: async () => [8, 8, 8],
    biasReference: async () => [0, 0],
    biasTolerance: 0.01,
  });
  assert.equal(await v(candidate), false, '长度不匹配 → false(无法确认)');
}
console.log('✓ 长度不匹配 → false');

// ─── 6. 注入 evaluatePromotion 端到端:D6 双门槛真起作用 ───────────────────────
{
  // 偏差候选:统计过 + 跨信号未确认 → non-promotable
  const biased = createBiasDetectionVerifier({
    measurementExtractor: async () => [8, 8, 8],
    biasReference: async () => [0, 0, 0],
    biasTolerance: 0.01,
  });
  const d1 = await evaluatePromotion(stats('grasp-skill'), biased);
  assert.equal(d1.statisticalPassed, true, '统计过(陷阱)');
  assert.equal(d1.crossSignalPassed, false, '跨信号检出偏差 → 未确认');
  assert.equal(d1.promotable, false, '★ 偏差候选不升层(D6 拦截)');

  // 一致候选:统计过 + 跨信号确认 → promotable(证明非误拒)
  const consistent = createBiasDetectionVerifier({
    measurementExtractor: async () => [1, 1, 1],
    biasReference: async () => [1, 1, 1],
    biasTolerance: 0.01,
  });
  const d2 = await evaluatePromotion(stats('good-skill'), consistent);
  assert.equal(d2.statisticalPassed, true);
  assert.equal(d2.crossSignalPassed, true);
  assert.equal(d2.promotable, true, '对照:信号一致 → 升层(非误拒)');
}
console.log('✓ 注入 evaluatePromotion:偏差→non-promotable,一致→promotable(D6 双门槛真起作用)');

console.log('\n✅ cross-signal-bias-verifier 全部通过(6/6)');
