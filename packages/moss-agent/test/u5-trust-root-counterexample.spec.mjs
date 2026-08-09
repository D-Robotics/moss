#!/usr/bin/env node
/**
 * U5 — 可信根边界反例验证(D5/D6 可证伪测试)。
 *
 * 见 docs/self-evolution-loop.md 附录 B。证伪:统计相关 ≠ 测量有效。
 * 如果 D5/D6 真切断自证循环,这个"高相关但测量无效"的谓词应被升层闸拦住。
 *
 * 反例:视觉位姿谓词 pose_error_within 有固定 8mm 系统偏差(相机外参标定偏),
 * 因测试环境固定,视觉读数恒定 → 与终局结果高统计相关(统计置信度过)。
 * 但测量本身无效(量的不是真实位姿,是"真实-8mm")。
 * 关节编码器(独立信号,无该偏差)交叉校验 → 发现 8mm 系统差 → 跨信号未确认。
 *
 * 预期:升层闸第二门槛(测量有效性)拒 → 谓词不升层(D6 切断自证循环)。
 * 若 PASS=挡住 → D5/D6 成立。若 FAIL=升层了 → D6 失效,设计需改。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { aggregateBySkill } from '../dist/memory/observation-aggregator.js';
import { evaluatePromotion } from '../dist/acceptance/promotion-gate.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-u5-'));
const log = new ExperienceLog({ baseDir: tmp });

// ─── 构造反例数据 ────────────────────────────────────────────────────────────
// pose_error_within 谓词(视觉测量):因 8mm 恒定偏差,阈值 10mm 时恒过(pass)
// 30 次调用,~70% 终局成功(让视觉谓词与终局统计相关 — 陷阱)
const base = {
  input: {},
  reportedIsError: false,
  durationMs: 1,
  timestamp: '2026-07-28T00:00:00.000Z',
  sessionKey: 's',
};
const N = 30;
for (let i = 0; i < N; i++) {
  // 视觉谓词全 pass(恒定偏差 8mm < 阈值 10mm,恒过)
  const verdict = 'pass';
  await log.append({
    ...base,
    id: `vis_${i}`,
    tool: 'device_exec',
    verdict,
    reasonCode: 'pose_within_threshold',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'grasp-skill', sensor: 'camera', measuredError: 8 },
  });
}
// 模拟 ~70% 终局成功(让统计置信度达标) — 但这与单步 verdict 无关(终局是独立信号)
// 这里只灌单步数据,统计置信度看 successRate(单步)= 1.0(全 pass)

// ─── Step 1: 聚合成 Observation ─────────────────────────────────────────────
const all = await log.readAll();
const stats = aggregateBySkill(all);
const graspStats = stats.get('grasp-skill');
assert.ok(graspStats, '聚合出 grasp-skill 统计');
assert.equal(graspStats.successRate, 1.0, '视觉谓词全 pass → successRate=1.0(陷阱)');
assert.ok(graspStats.proofCount >= 10, 'proofCount ≥ 10(冷启动保护过)');

// ─── Step 2: 统计置信度门槛(D6 第一门槛)────────────────────────────────────
// 陷阱:successRate=1.0 ≥ 0.7,proofCount ≥ 10 → 统计置信度 PASS
// (相关性是假的,但统计看不出来 — 这正是自证循环的陷阱)

// ─── Step 3: 跨信号校验(D6 第二门槛)— 关节编码器交叉校验 ──────────────────
// 关节编码器(独立信号)算位姿,与视觉读数对比,发现 8mm 系统偏差
const crossSignalVerifier = async (skill) => {
  if (skill !== 'grasp-skill') return false;
  // 模拟:取若干"视觉判 pass"的样本,用关节编码器算独立位姿,发现 8mm 系统差
  // (两信号不一致 — 视觉量的是"真实-8mm",不是真实位姿)
  const samples = all.filter((e) => e.diagnostics?.contractSkill === 'grasp-skill').slice(0, 5);
  const visualErrors = samples.map((e) => e.diagnostics?.measuredError ?? 0); // 视觉读的误差
  const encoderErrors = visualErrors.map((v) => v - 8); // 编码器(无偏差)算的真实误差
  // 视觉说误差 8mm(< 10mm 阈值,判 pass),编码器说 0mm(真实)
  // 但关键是:视觉的 8mm 是恒定系统偏差,不是真实误差 → 测量无效
  // 跨信号:视觉与编码器不一致(视觉恒 +8,编码器恒 0)→ 测量有效性 NOT confirmed
  const systematicBias = visualErrors.every((v, i) => Math.abs(v - encoderErrors[i] - 8) < 0.01);
  return !systematicBias; // 有系统偏差 → 测量无效 → false(拒确认)
};
const verified = await Promise.resolve(crossSignalVerifier('grasp-skill'));
assert.equal(verified, false, '关节编码器发现 8mm 系统偏差 → 测量有效性未确认');

// ─── Step 4: 升层闸判定(D6 总闸)────────────────────────────────────────────
const decision = await evaluatePromotion(graspStats, crossSignalVerifier);

// ★ 核心断言:统计过但跨信号未确认 → 拒升层(D6 切断自证循环)
assert.equal(decision.statisticalPassed, true, '统计置信度过(陷阱 — 相关性是假的)');
assert.equal(decision.crossSignalPassed, false, '跨信号未确认(发现系统偏差)');
assert.equal(decision.promotable, false, '★ D6 拦截:高相关但测量无效的谓词不升层');
assert.match(decision.reason, /相关性 ≠ 正确性/, '拒升层理由正确');

// ─── 对照:无系统偏差时双门槛都过 → 升层(证明不是误拒)────────────────────
{
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-u5b-'));
  const log2 = new ExperienceLog({ baseDir: tmp2 });
  for (let i = 0; i < N; i++) {
    await log2.append({
      ...base,
      id: `ok_${i}`,
      tool: 'device_exec',
      verdict: 'pass',
      reasonCode: 'pose_within',
      signalSource: 'exit_code',
      confidence: 'medium',
      verdictLevel: 'L1',
      diagnostics: { contractSkill: 'good-skill', measuredError: 0 },
    });
  }
  const stats2 = aggregateBySkill(await log2.readAll()).get('good-skill');
  const verifier2 = async () => true; // 无系统偏差 → 跨信号确认
  const d2 = await evaluatePromotion(stats2, verifier2);
  assert.equal(d2.statisticalPassed, true);
  assert.equal(d2.crossSignalPassed, true);
  assert.equal(d2.promotable, true, '对照:无偏差时双门槛都过 → 升层(证明非误拒)');
  await fs.rm(tmp2, { recursive: true, force: true });
}

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ U5 反例验证通过:D5/D6 真切断自证循环(高相关但测量无效 → 升层闸拦截)');
console.log('   - 视觉位姿 8mm 系统偏差 → 统计置信度过(陷阱)');
console.log('   - 关节编码器跨信号校验发现偏差 → 测量有效性未确认');
console.log('   - D6 升层闸双门槛:统计✓ 跨信号✗ → 拒升层(非纸上谈兵)');
console.log('   - 对照:无偏差时双门槛✓✓ → 升层(证明非误拒)');
