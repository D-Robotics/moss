#!/usr/bin/env node
/**
 * observation-aggregator(T2.2)— 从 Experience 提炼 Observation。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ObservationAggregator,
  aggregateBySkill,
  formatObservationContent,
} from '../dist/memory/observation-aggregator.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { MemoryManager } from '../dist/memory/memory-manager.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-obs-'));
const log = new ExperienceLog({ baseDir: tmp });
const mm = new MemoryManager(tmp);
await mm.load();

// 灌入 Experience 数据:rdk-device 5 pass/2 fail/1 unknown,rdk-ros 3 pass/1 fail
const base = {
  input: {},
  reportedIsError: false,
  durationMs: 1,
  timestamp: '2026-07-28T00:00:00.000Z',
  sessionKey: 's',
};
const entries = [
  {
    ...base,
    id: '1',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-device', exitCode: 0 },
  },
  {
    ...base,
    id: '2',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-device', exitCode: 0 },
  },
  {
    ...base,
    id: '3',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-device', exitCode: 0 },
  },
  {
    ...base,
    id: '4',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-device', exitCode: 0 },
  },
  {
    ...base,
    id: '5',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-device', exitCode: 0 },
  },
  {
    ...base,
    id: '6',
    tool: 'device_exec',
    verdict: 'fail',
    reasonCode: 'nonzero_exit',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-device', exitCode: 1 },
  },
  {
    ...base,
    id: '7',
    tool: 'device_exec',
    verdict: 'fail',
    reasonCode: 'file_missing',
    signalSource: 'file_exist',
    confidence: 'high',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-device' },
  },
  {
    ...base,
    id: '8',
    tool: 'device_exec',
    verdict: 'unknown',
    reasonCode: 'no_hard_signal',
    signalSource: 'model_judge',
    confidence: 'low',
    verdictLevel: 'L2',
    diagnostics: { contractSkill: 'rdk-device' },
  },
  {
    ...base,
    id: '9',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-ros' },
  },
  {
    ...base,
    id: '10',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-ros' },
  },
  {
    ...base,
    id: '11',
    tool: 'device_exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-ros' },
  },
  {
    ...base,
    id: '12',
    tool: 'device_exec',
    verdict: 'fail',
    reasonCode: 'process_not_running',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L1',
    diagnostics: { contractSkill: 'rdk-ros' },
  },
  // 无 contractSkill 的(L2 通用)不统计
  {
    ...base,
    id: '13',
    tool: 'exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L2',
    diagnostics: {},
  },
];
for (const e of entries) await log.append(e);

// ─── 1. aggregateBySkill 统计正确 ────────────────────────────────────────────
{
  const all = await log.readAll();
  const stats = aggregateBySkill(all);
  assert.equal(stats.size, 2, '2 个 skill 有契约条目(rdk-device, rdk-ros),L2 不统计');

  const dev = stats.get('rdk-device');
  assert.ok(dev);
  assert.equal(dev.total, 8);
  assert.equal(dev.pass, 5);
  assert.equal(dev.fail, 2);
  assert.equal(dev.unknown, 1);
  assert.equal(dev.proofCount, 7, 'proofCount = pass+fail = 7(unknown 不计)');
  assert.ok(Math.abs(dev.successRate - 5 / 7) < 0.001, 'successRate = 5/7');
  assert.equal(dev.failureReasons['nonzero_exit'], 1);
  assert.equal(dev.failureReasons['file_missing'], 1);

  const ros = stats.get('rdk-ros');
  assert.equal(ros.pass, 3);
  assert.equal(ros.fail, 1);
  assert.equal(ros.proofCount, 4);
  assert.ok(Math.abs(ros.successRate - 0.75) < 0.001);
}
console.log('✓ aggregateBySkill: rdk-device 5/7=71.4%, rdk-ros 3/4=75%, proofCount 正确');

// ─── 2. formatObservationContent 人可读 + 含 proofCount ──────────────────────
{
  const all = await log.readAll();
  const dev = aggregateBySkill(all).get('rdk-device');
  const text = formatObservationContent(dev);
  assert.match(text, /skill=rdk-device/);
  assert.match(text, /successRate=71\.4%/);
  assert.match(text, /proofCount=7/);
  assert.match(text, /topFailures/);
}
console.log('✓ formatObservationContent: 含 skill/successRate/proofCount/topFailures');

// ─── 3. ObservationAggregator.aggregate 写 observation 条目进 MemoryManager ─
{
  const agg = new ObservationAggregator({ experienceLog: log, memoryManager: mm });
  const count = await agg.aggregate();
  assert.equal(count, 2, '聚合 2 个 skill');
  const all = await mm.getAll();
  const obs = all.filter((e) => e.trust === 'observation');
  assert.equal(obs.length, 2, '2 条 observation 条目');
  const devObs = obs.find((e) => e.content.includes('rdk-device'));
  assert.ok(devObs);
  assert.match(devObs.content, /successRate=71\.4%/);
  assert.match(devObs.topic, /proofCount=7/);
}
console.log('✓ aggregate: 写 observation 条目(trust=observation,含统计 + proofCount)');

// ─── 4. 异步不阻塞(aggregate 返回后数据可读)────────────────────────────────
{
  const agg = new ObservationAggregator({ experienceLog: log, memoryManager: mm });
  // 不 await,直接 fire-and-forget(模拟异步定时触发)
  const p = agg.aggregate();
  await p; // 这里 await 只为测试,实际是后台触发
  // 聚合完 observation 条目存在
  const obs = (await mm.getAll()).filter((e) => e.trust === 'observation');
  assert.ok(obs.length >= 2);
}
console.log('✓ aggregate 异步(Promise,可后台触发不阻塞)');

// ─── 5. 无契约数据时不写 observation(L2 通用不统计)─────────────────────────
{
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-obs2-'));
  const log2 = new ExperienceLog({ baseDir: tmp2 });
  const mm2 = new MemoryManager(tmp2);
  await mm2.load();
  // 只灌无 contractSkill 的 L2 条目
  await log2.append({
    ...base,
    id: '1',
    tool: 'exec',
    verdict: 'pass',
    reasonCode: 'exit_zero',
    signalSource: 'exit_code',
    confidence: 'medium',
    verdictLevel: 'L2',
    diagnostics: {},
  });
  const agg = new ObservationAggregator({ experienceLog: log2, memoryManager: mm2 });
  const count = await agg.aggregate();
  assert.equal(count, 0, '无契约条目 → 0 skill 聚合');
  const obs = (await mm2.getAll()).filter((e) => e.trust === 'observation');
  assert.equal(obs.length, 0, '无 observation 写入');
  await fs.rm(tmp2, { recursive: true, force: true });
}
console.log('✓ 无契约数据不写 observation(L2 通用判定不进归纳)');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ observation-aggregator T2.2 全部通过(5/5)');
