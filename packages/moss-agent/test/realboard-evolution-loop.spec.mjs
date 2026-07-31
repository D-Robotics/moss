#!/usr/bin/env node
/**
 * realboard-evolution-loop — 真机(RDK X5)自进化闭环端到端集成测试。
 *
 * 在真板上跑完整闭环:yolov5 推理 → 终态判定 → 终态写 log → 10 次后候选触发 →
 * evaluatePromotion 双门槛 → Opinion 落盘。验 T3.3 终局判定 + T3.4 候选源真闭环
 * 在真机上跑通(非离线 fixture 想象)。
 *
 * 无板环境(板不可达)→ skip(不假报 pass)。需 MOSS_REALBOARD_HOST 环境变量或
 * 默认 192.168.127.10 可达。用 ssh 直连跑命令(旁路 moss deviceExecutor,聚焦验
 * 自进化逻辑本身)。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyTaskTerminal } from '../dist/acceptance/task-terminal-verifier.js';
import { TerminalVerdictLog, aggregateTerminalBySkill } from '../dist/acceptance/terminal-verdict-log.js';
import { createTerminalCandidateSource } from '../dist/acceptance/promotion-candidate-source.js';
import { evaluatePromotion } from '../dist/acceptance/promotion-gate.js';
import { createOpinionSink } from '../dist/acceptance/promotion-opinion-sink.js';
import { MemoryManager } from '../dist/core/index.js';

const HOST = process.env.MOSS_REALBOARD_HOST ?? '192.168.127.10';
// SSH 参数(不含可执行名 'ssh',spawnSync 第一个参数单独给)
const SSH_ARGS = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8', `root@${HOST}`];

// ─── 0. 板可达性 gate:不可达 → skip ──────────────────────────────────────────
function boardReachable() {
  const r = spawnSync('ssh', [...SSH_ARGS, 'echo ok'], { stdio: 'pipe' });
  return r.status === 0 && String(r.stdout).trim() === 'ok';
}
if (!boardReachable()) {
  console.log(`  [SKIP] realboard-evolution-loop: 板 ${HOST} 不可达(无板环境跳过)`);
  process.exit(0);
}
console.log(`  [REALBOARD] ${HOST} 可达,跑真机自进化闭环...`);

// ─── 1. 真跑 yolov5,抓 stdout + exit ─────────────────────────────────────────
function runYolov5() {
  const cmd = 'cd /app/pydev_demo/07_yolov5_sample && timeout 30 python3 test_yolov5.py';
  const r = spawnSync('ssh', [...SSH_ARGS, cmd], { stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
  return { stdout: String(r.stdout), exitCode: r.status ?? 1 };
}

const runs = [];
const N = 10; // 凑 minProofCount
for (let i = 0; i < N; i++) {
  const { stdout, exitCode } = runYolov5();
  assert.equal(exitCode, 0, `真机 yolov5 第 ${i + 1} 次应 EXIT=0,实际 ${exitCode}`);
  runs.push({ stdout, exitCode });
  console.log(`  [run ${i + 1}/${N}] EXIT=0, bbox 数=${(stdout.match(/bbox:/g) || []).length}`);
}
console.log(`  ✓ 真机 yolov5 跑 ${N} 次,全 EXIT=0`);

// ─── 2. T3.3 终态判定:plan.terminalAccept = exit_code_zero + stdout_matches(bbox) ──
const plan = {
  id: 'plan-yolov5-realboard', goal: 'yolov5 推理验证', status: 'executing', version: 1, steps: [],
  createdAt: '', updatedAt: '',
  steps: [{ step: 1, description: 'yolov5 推理', status: 'completed', expectedAccept: ['rdk-model-zoo'] }],
  terminalAccept: [
    { name: 'exit_code_zero', params: {} },
    { name: 'stdout_matches', params: { pattern: 'bbox:|score:|name:' } },
  ],
};
const sampleRun = runs[0];
const terminal = await verifyTaskTerminal({
  plan,
  workspaceDir: os.tmpdir(),
  deviceExecutor: null,
  finalResponse: 'done',
  executionEvidence: {
    source: 'device_exec',
    exitCode: sampleRun.exitCode,
    stdout: sampleRun.stdout,
    stderr: '',
  },
});
assert.equal(terminal.verdict, 'pass', `T3.3 终态应判 pass(真机 exit0 + bbox/score),实际=${terminal.verdict} reason=${terminal.reason}`);
console.log(`  ✓ T3.3 终态判定:pass(真机 yolov5 EXIT=0 + stdout bbox/score/name)`);

// ─── 3. 写 terminal-verdict log(N 条,skill=rdk-model-zoo)─────────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-realboard-loop-'));
const tvLog = new TerminalVerdictLog({ baseDir: tmp });
for (let i = 0; i < N; i++) {
  await tvLog.append({
    id: `yolo-${i}`, skill: 'rdk-model-zoo', verdict: 'pass',
    reason: 'yolov5 EXIT=0 + bbox/score', sessionKey: `s${i}`, timestamp: new Date().toISOString(),
  });
}
const statsBySkill = aggregateTerminalBySkill(await tvLog.readAll());
const mzStats = statsBySkill.get('rdk-model-zoo');
assert.ok(mzStats);
assert.ok(mzStats.proofCount >= 10, `proofCount 应 ≥10,实际 ${mzStats.proofCount}`);
assert.equal(mzStats.successRate, 1.0, '10 次全 pass → successRate=1.0');
console.log(`  ✓ 终态 log 写 ${mzStats.proofCount} 条,rdk-model-zoo proofCount=${mzStats.proofCount} successRate=1.0`);

// ─── 4. T3.4 候选源触发(≥minProofCount)──────────────────────────────────────
const candidateSource = createTerminalCandidateSource({ terminalVerdictLog: tvLog, minProofCount: 10 });
const candidates = await candidateSource({ sessionKey: 's', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 0, toolCallsByName: {} });
assert.equal(candidates.length, 1, '应触发 1 个候选(rdk-model-zoo)');
assert.equal(candidates[0].targetSkill, 'rdk-model-zoo');
console.log(`  ✓ T3.4 候选源触发:1 个候选 rdk-model-zoo(终局硬信号统计触发)`);

// ─── 5. evaluatePromotion 双门槛 + Opinion 落盘 ───────────────────────────────
const mm = new MemoryManager(tmp);
const records = [];
const sink = createOpinionSink({ memoryManager: mm });
const statsSource = (await import('../dist/acceptance/promotion-candidate-source.js')).createTerminalStatsSource({ terminalVerdictLog: tvLog });
const { PromotionCoordinator } = await import('../dist/acceptance/promotion-coordinator.js');
const coordinator = new PromotionCoordinator({
  candidateSource,
  statsSource,
  crossSignalVerifier: () => false, // X5 无 pose 对照信号 → 保守拒(D6:无跨信号确认不升层)
  decisionSink: async (r) => { records.push(r); await sink(r); },
});
await coordinator.observeCompletion({ sessionKey: 's', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 0, toolCallsByName: {} });

assert.equal(records.length, 1);
assert.equal(records[0].decision.statisticalPassed, true, '统计置信度过(10 次 pass)');
assert.equal(records[0].decision.crossSignalPassed, false, '跨信号未确认(X5 无 pose 对照 → 保守 false)');
assert.equal(records[0].decision.promotable, false, '★ 真机闭环:统计过但跨信号拒 → non-promotable(D6 切断,不自动升层)');

const mems = await mm.getAll();
assert.equal(mems.length, 1, '1 条 Opinion 落盘');
assert.equal(mems[0].trust, 'observation');
console.log(`  ✓ T3.4 闭环:统计过(statisticalPassed=true)+ 跨信号拒(crossSignalPassed=false)→ non-promotable → 1 Opinion 落盘`);

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ realboard-evolution-loop: 真机 RDK X5 自进化闭环端到端通过(yolov5 真跑 → 终态判定 → 候选 → 双门槛 → Opinion)');
