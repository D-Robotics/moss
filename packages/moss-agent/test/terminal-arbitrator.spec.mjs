#!/usr/bin/env node
/**
 * terminal-arbitrator(T3.3)— 终局判据审计 + 漂移校准。
 */
import assert from 'node:assert/strict';
import { auditTerminal, checkDrift } from '../dist/acceptance/terminal-arbitrator.js';

const mkExp = (verdict, contractSkill) => ({
  id: Math.random().toString(36).slice(2),
  tool: 'device_exec', input: {}, reportedIsError: false,
  verdict, reasonCode: verdict === 'fail' ? 'nonzero_exit' : 'exit_zero',
  signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1',
  durationMs: 1, timestamp: '2026-07-28T00:00:00.000Z', sessionKey: 's',
  diagnostics: { contractSkill },
});

// ─── 1. 单步全 pass + 终态 pass → 无审计 ────────────────────────────────────
{
  const r = auditTerminal({
    experiences: [mkExp('pass', 'rdk-device'), mkExp('pass', 'rdk-device')],
    terminalVerdict: 'pass',
  });
  assert.equal(r.auditFailed, false);
  assert.equal(r.singleStepPassRate, 1);
  assert.match(r.reason, /终态 pass/);
}
console.log('✓ 单步全 pass + 终态 pass → 无判据失效');

// ─── 2. 单步全 pass + 终态 fail → auditFailed(判据失效,核心)────────────────
{
  const r = auditTerminal({
    experiences: [mkExp('pass', 'rdk-device'), mkExp('pass', 'rdk-ros')],
    terminalVerdict: 'fail',
    terminalReason: 'model not running on board',
  });
  assert.equal(r.auditFailed, true, '单步全 pass 但终态 fail → 判据失效');
  assert.deepEqual(r.suspectSkills, ['rdk-device', 'rdk-ros'], '定位失效契约');
  assert.match(r.reason, /判据失效/);
}
console.log('✓ 单步全 pass + 终态 fail → auditFailed(定位失效契约)');

// ─── 3. 单步有 fail + 终态 fail → 正常失败(非判据失效)─────────────────────
{
  const r = auditTerminal({
    experiences: [mkExp('pass', 'rdk-device'), mkExp('fail', 'rdk-ros')],
    terminalVerdict: 'fail',
  });
  assert.equal(r.auditFailed, false, '单步有 fail 且终态 fail → 一致,非判据失效');
  assert.match(r.reason, /正常失败/);
  assert.ok(r.singleStepPassRate < 1);
}
console.log('✓ 单步有 fail + 终态 fail → 正常失败(判据与终态一致)');

// ─── 4. 终态 unknown → 无法判定 ──────────────────────────────────────────────
{
  const r = auditTerminal({
    experiences: [mkExp('pass', 'rdk-device')],
    terminalVerdict: 'unknown',
  });
  assert.equal(r.auditFailed, false);
  assert.match(r.reason, /unknown/);
}
console.log('✓ 终态 unknown → 无法判定判据失效');

// ─── 5. 无契约步骤的条目不计入(只有 L1 contractSkill 的算)──────────────────
{
  const r = auditTerminal({
    experiences: [{ ...mkExp('pass', undefined), diagnostics: {} }], // 无 contractSkill
    terminalVerdict: 'fail',
  });
  assert.equal(r.auditFailed, false, '无契约步骤 → allPass=false(空集不算全 pass)');
  assert.equal(r.singleStepPassRate, 1); // 无契约步骤时返回 1(占位)
}
console.log('✓ 无契约步骤不计入审计');

// ─── 6. 漂移校准:单步通过率 vs 终局成功率差值超阈 → driftDetected ──────────
{
  let r = checkDrift({ singleStepPassRate: 0.9, terminalSuccessRate: 0.5 }); // 差 0.4 > 0.2
  assert.equal(r.driftDetected, true);
  assert.ok(Math.abs(r.delta - 0.4) < 0.001);
  assert.match(r.reason, /漂移检测/);

  // 差值在阈内 → 无漂移
  r = checkDrift({ singleStepPassRate: 0.75, terminalSuccessRate: 0.7 }); // 差 0.05 < 0.2
  assert.equal(r.driftDetected, false);

  // 反向漂移(终局高于单步)也检测
  r = checkDrift({ singleStepPassRate: 0.4, terminalSuccessRate: 0.8 }); // 差 -0.4
  assert.equal(r.driftDetected, true, '反向漂移也检测');

  // 自定义阈值(更小阈值,差值真大于它)
  r = checkDrift({ singleStepPassRate: 0.75, terminalSuccessRate: 0.6, driftThreshold: 0.1 });
  assert.equal(r.driftDetected, true, '差 0.15 > 阈 0.1 → 检测');
  // 阈值更大时同样的差不检测
  r = checkDrift({ singleStepPassRate: 0.75, terminalSuccessRate: 0.6, driftThreshold: 0.2 });
  assert.equal(r.driftDetected, false, '差 0.15 < 阈 0.2 → 不检测');
}
console.log('✓ 漂移校准: 双向差值超阈 → driftDetected(触发契约重评)');

console.log('\n✅ terminal-arbitrator T3.3 全部通过(6/6)');
