#!/usr/bin/env node
/**
 * pose-cross-signal-verifier — D7 跨信号端到端(camera pose vs encoder pose 偏差)。
 * 验:U5 偏差→false;信号一致→true;无设备→false;解析失败→false;注入 evaluatePromotion 端到端。
 */
import assert from 'node:assert/strict';
import { createPoseCrossSignalVerifier } from '../dist/acceptance/pose-cross-signal-verifier.js';
import { evaluatePromotion } from '../dist/acceptance/promotion-gate.js';

const candidate = { id: 'term_grasp-skill', targetSkill: 'grasp-skill', provenance: { layer: 'L2', kind: 'explicit-proposal', source: 'terminal-hard-signal', proposalRef: 'x' } };
const stats = (skill) => ({ skill, total: 30, pass: 30, fail: 0, unknown: 0, successRate: 1.0, proofCount: 30, failureReasons: {} });
const reads = {
  cameraRead: { command: 'cat /sys/camera_pose', valueRegex: 'error = ([\\d.]+)' },
  encoderRead: { command: 'cat /sys/encoder_pose', valueRegex: 'error = ([\\d.]+)' },
};

// 假设备:camera 恒报 8,encoder 恒报 0(U5 系统偏差)
const biasedDev = {
  async runReadOnly(command) {
    if (command.includes('camera')) return { stdout: 'error = 8', exitCode: 0 };
    if (command.includes('encoder')) return { stdout: 'error = 0', exitCode: 0 };
    return null;
  },
};
// 一致设备:两源都报 2
const consistentDev = {
  async runReadOnly(command) {
    if (command.includes('camera')) return { stdout: 'error = 2', exitCode: 0 };
    if (command.includes('encoder')) return { stdout: 'error = 2', exitCode: 0 };
    return null;
  },
};
// 解析失败设备
const unparseableDev = {
  async runReadOnly() { return { stdout: 'no number', exitCode: 0 }; },
};

// ─── 1. U5 偏差(camera 8 / encoder 0)→ false ───────────────────────────────
{
  const v = createPoseCrossSignalVerifier({ deviceExecutor: biasedDev, ...reads });
  assert.equal(await v(candidate), false, 'camera 8 vs encoder 0 系统偏差 → false(D6 切断)');
}
console.log('✓ U5 偏差(camera 8/encoder 0)→ false');

// ─── 2. 信号一致(camera 2/encoder 2)→ true ─────────────────────────────────
{
  const v = createPoseCrossSignalVerifier({ deviceExecutor: consistentDev, ...reads });
  assert.equal(await v(candidate), true, '两源一致 → 测量有效性确认 → true');
}
console.log('✓ 信号一致(camera 2/encoder 2)→ true');

// ─── 3. 无设备(null executor)→ false ──────────────────────────────────────
{
  const v = createPoseCrossSignalVerifier({ deviceExecutor: null, ...reads });
  assert.equal(await v(candidate), false, '无设备 → false(保守)');
}
console.log('✓ 无设备 → false');

// ─── 4. 解析失败 → false ────────────────────────────────────────────────────
{
  const v = createPoseCrossSignalVerifier({ deviceExecutor: unparseableDev, ...reads });
  assert.equal(await v(candidate), false, '读不出数 → false(无法确认)');
}
console.log('✓ 解析失败 → false');

// ─── 5. 注入 evaluatePromotion 端到端:D6+D7 真起作用 ────────────────────────
{
  const biased = createPoseCrossSignalVerifier({ deviceExecutor: biasedDev, ...reads });
  const d1 = await evaluatePromotion(stats('grasp-skill'), biased);
  assert.equal(d1.statisticalPassed, true);
  assert.equal(d1.crossSignalPassed, false, '跨信号检出 8 偏差 → 未确认');
  assert.equal(d1.promotable, false, '★ 偏差候选不升层(D6+D7 真切断)');

  const consistent = createPoseCrossSignalVerifier({ deviceExecutor: consistentDev, ...reads });
  const d2 = await evaluatePromotion(stats('good-skill'), consistent);
  assert.equal(d2.statisticalPassed, true);
  assert.equal(d2.crossSignalPassed, true, '两源一致 → 跨信号确认');
  assert.equal(d2.promotable, true, '★ 对照:一致候选可升层(D6 双门槛都过)');
}
console.log('✓ 注入 evaluatePromotion:偏差→non-promotable,一致→promotable(D6+D7 端到端)');

console.log('\n✅ pose-cross-signal-verifier 全部通过(5/5)');
