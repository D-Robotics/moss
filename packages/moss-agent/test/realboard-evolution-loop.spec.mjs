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
import { fileURLToPath } from 'node:url';
import { verifyTaskTerminal } from '../dist/acceptance/task-terminal-verifier.js';
import { TerminalVerdictLog, aggregateTerminalBySkill } from '../dist/acceptance/terminal-verdict-log.js';
import { createTerminalCandidateSource } from '../dist/acceptance/promotion-candidate-source.js';
import { evaluatePromotion } from '../dist/acceptance/promotion-gate.js';
import { createOpinionSink } from '../dist/acceptance/promotion-opinion-sink.js';
import { MemoryManager } from '../dist/core/index.js';
import { planTool, resetPlanControllerForTests } from '../dist/plan-execute/plan-tools.js';
import { getActivePlanForSession } from '../dist/plan-execute/plan-controller-store.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { wrapWithTerminalArbitration } from '../dist/core/tools/terminal-arbitration-gate.js';
import { probeDeviceEnvironmentFacts, trustedEnvironmentIdentity } from '../dist/memory/environment-fingerprint.js';
import { DeviceSshSession } from '../dist/tools/device-ssh-session.js';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { TrustedLearningCoordinator } from '../dist/memory/trusted-learning-coordinator.js';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { TrustedPatchCoordinator } from '../dist/memory/trusted-patch-coordinator.js';
import { PatchExperimentLog } from '../dist/memory/patch-experiment-log.js';
import { TrustedSkillExperimentCoordinator } from '../dist/memory/trusted-skill-experiment-coordinator.js';

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

const identitySession = new DeviceSshSession({ host: HOST, user: 'root', port: 22 });
let realboardFacts;
try {
  await identitySession.connect();
  realboardFacts = await probeDeviceEnvironmentFacts(identitySession);
} finally {
  await identitySession.close();
}
const realboardIdentity = trustedEnvironmentIdentity({
  workspaceDir: process.cwd(), runtimeMode: 'device', device: realboardFacts,
});
assert.match(realboardFacts.boardModel ?? '', /RDK\s+X5/i, '固定身份探针必须识别当前真板为 RDK X5');
assert.equal(realboardIdentity.completeness, 'complete');
assert.match(realboardIdentity.fingerprint, /^sha256:v1:/);
console.log(`  ✓ 真板环境身份完整:${realboardFacts.boardModel}, firmware=${realboardFacts.firmwareVersion ?? realboardFacts.kernelVersion}, fingerprint=${realboardIdentity.fingerprint}`);

// ─── 1. 真跑 yolov5,抓 stdout + exit ─────────────────────────────────────────
function runYolov5() {
  const cmd = 'cd /app/pydev_demo/07_yolov5_sample && timeout 30 python3 test_yolov5.py';
  const r = spawnSync('ssh', [...SSH_ARGS, cmd], { stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
  return { stdout: String(r.stdout), exitCode: r.status ?? 1 };
}

function runControlledYolov5Failure() {
  const cmd = 'cd /app/pydev_demo/07_yolov5_sample && timeout 0.01 python3 test_yolov5.py';
  const r = spawnSync('ssh', [...SSH_ARGS, cmd], { stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.status ?? 1 };
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
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-realboard-loop-'));
const sessionKey = 'realboard-yolov5';
const workspaceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const planCtx = { workspaceDir, sessionKey, runId: 'plan-setup' };
resetPlanControllerForTests();
const created = await planTool.execute({
  action: 'create', goal: 'yolov5 推理验证',
  steps: [{ description: 'yolov5 推理', expectedTools: ['device_exec'], expectedAccept: ['rdk-model-zoo'] }],
  terminalAccept: [
    { name: 'exit_code_zero', params: {} },
    { name: 'stdout_matches', params: { pattern: 'bbox:|score:|name:' } },
  ],
}, planCtx);
const createdId = /Plan created: (\S+)/.exec(created)?.[1];
assert.ok(createdId, `真实 plan create 应返回 plan id: ${created}`);
await planTool.execute({ action: 'review', planId: createdId }, planCtx);
await planTool.execute({ action: 'approve', planId: createdId }, planCtx);
await planTool.execute({ action: 'start', planId: createdId }, planCtx);
const plan = getActivePlanForSession(sessionKey);
assert.ok(plan, '真实 plan 工具创建并启动的 Plan 应可由 session provider 读取');
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

// ─── 2.5 第二阶段:真板可控失败 → 新 evidence 恢复 → Observation ─────────────
const recoveryDir = path.join(tmp, 'trusted-recovery');
await fs.mkdir(recoveryDir, { recursive: true });
const recoveryExperienceLog = new ExperienceLog({ baseDir: recoveryDir });
const recoveryTerminalLog = new TerminalVerdictLog({ baseDir: recoveryDir });
const recoveryEventLog = new LearningEventLog({ baseDir: recoveryDir });
const recoveryPatchLog = new CandidatePatchLog({ baseDir: recoveryDir });
const recoveryExperimentLog = new PatchExperimentLog({ baseDir: recoveryDir });
const recoveryMemory = new MemoryManager(recoveryDir);
await recoveryMemory.load();
const recoveryPatchCoordinator = new TrustedPatchCoordinator({
  workspaceDir: tmp, eventLog: recoveryEventLog, patchLog: recoveryPatchLog,
});
const recoveryCoordinator = new TrustedLearningCoordinator({
  eventLog: recoveryEventLog, memoryManager: recoveryMemory, patchCoordinator: recoveryPatchCoordinator,
});
let experimentRollbacks = 0;
const recoveryExperimentCoordinator = new TrustedSkillExperimentCoordinator({
  workspaceDir: tmp,
  patchLog: recoveryPatchLog,
  experimentLog: recoveryExperimentLog,
  terminalVerdictLog: recoveryTerminalLog,
  learningEventLog: recoveryEventLog,
  rollback: async (patchId) => {
    experimentRollbacks += 1;
    return recoveryPatchCoordinator.rollback(patchId);
  },
});
const recoveryGate = wrapWithTerminalArbitration(async () => ({ ok: true }), {
  experienceLog: recoveryExperienceLog,
  planProvider: { get: getActivePlanForSession },
  deviceExecutor: { current: null }, workspaceDir,
  terminalVerdictLog: recoveryTerminalLog,
  trustedLearningCoordinator: recoveryCoordinator,
  trustedSkillExperimentCoordinator: recoveryExperimentCoordinator,
});
const recoveryRunId = 'realboard-controlled-recovery';
const env = realboardIdentity.fingerprint;
const failedRun = runControlledYolov5Failure();
assert.notEqual(failedRun.exitCode, 0, '受控超时必须产生无破坏性的 YoloV5 非零退出');
await recoveryExperienceLog.append({
  schemaVersion: 2, id: 'controlled-fail-exp', sessionKey, taskId: plan.id, runId: recoveryRunId,
  attemptId: `${recoveryRunId}:controlled-fail`, stepId: `${plan.id}:step:1`, toolCallId: 'controlled-fail', evidenceId: 'controlled-fail',
  contractSkill: 'rdk-model-zoo', contractVersion: '1.0.0', environmentFingerprint: env,
  environmentIdentityVersion: realboardIdentity.schemaVersion, environmentCompleteness: realboardIdentity.completeness,
  executionDomain: 'real', realEvidenceEligible: true,
  tool: 'device_exec', input: { command: 'test_yolov5.py (controlled timeout)' }, reportedIsError: true,
  verdict: 'fail', reasonCode: 'nonzero_exit', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1',
  durationMs: 10, timestamp: new Date().toISOString(),
});
const blocked = await recoveryGate({
  sessionKey, runId: recoveryRunId, turn: 1, response: 'done', messages: [], totalToolCalls: 1, toolCallsByName: { device_exec: 1 },
  executionEvidence: { source: 'device_exec', toolUseId: 'controlled-fail', exitCode: failedRun.exitCode, stdout: failedRun.stdout, stderr: failedRun.stderr },
});
assert.equal(blocked.ok, false, '真板受控失败必须阻止 completion');
await recoveryExperienceLog.append({
  schemaVersion: 2, id: 'controlled-recover-exp', sessionKey, taskId: plan.id, runId: recoveryRunId,
  attemptId: `${recoveryRunId}:controlled-recover`, stepId: `${plan.id}:step:1`, toolCallId: 'controlled-recover', evidenceId: 'controlled-recover',
  contractSkill: 'rdk-model-zoo', contractVersion: '1.0.0', environmentFingerprint: env,
  environmentIdentityVersion: realboardIdentity.schemaVersion, environmentCompleteness: realboardIdentity.completeness,
  executionDomain: 'real', realEvidenceEligible: true,
  tool: 'device_exec', input: { command: 'test_yolov5.py' }, reportedIsError: false,
  verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1',
  durationMs: 1, timestamp: new Date().toISOString(),
});
const recoveredGate = await recoveryGate({
  sessionKey, runId: recoveryRunId, turn: 2, response: 'done', messages: [], totalToolCalls: 2, toolCallsByName: { device_exec: 2 },
  executionEvidence: { source: 'device_exec', toolUseId: 'controlled-recover', exitCode: sampleRun.exitCode, stdout: sampleRun.stdout, stderr: '' },
});
assert.equal(recoveredGate.ok, true, '真板新 evidence 成功后允许 completion');
const recoveryEvents = await recoveryEventLog.readAll();
assert.deepEqual(recoveryEvents.map((event) => event.outcome), ['failed', 'recovered']);
assert.equal(recoveryEvents[1].previousFailureId, recoveryEvents[0].id);
assert.ok((await recoveryMemory.getAll()).some((entry) => entry.trust === 'observation' && entry.topic?.includes('execution_failure')));
const [realboardPatch] = await recoveryPatchLog.latest();
assert.equal(realboardPatch.state, 'proposed', '单次真板恢复只形成候选,未达到 2 个独立 proof 不自动发布');
await assert.rejects(() => fs.access(path.join(tmp, '.moss', 'skills', 'learned')));
assert.equal((await recoveryExperimentLog.readAll()).length, 0, '未发布的单次恢复候选不得进入 A/B 实验');
assert.equal(experimentRollbacks, 0, 'shadow/proposed 候选不得触发实验回滚');
console.log('  ✓ 第四阶段:未发布候选不进入 A/B,不产生错误降级或回滚');
console.log('  ✓ 第二阶段:真板 YoloV5 受控失败 → 新 evidence 恢复 → Observation 落盘');
console.log('  ✓ 第三阶段:单次恢复仅 proposed,proof 不足时保守不发布 learned Skill');

// ─── 3. 真实 completion gate 按 Plan/Run 隔离并写 v2 terminal proof ──────────
const tvLog = new TerminalVerdictLog({ baseDir: tmp });
const experienceLog = new ExperienceLog({ baseDir: tmp });
const wrapped = wrapWithTerminalArbitration(async () => ({ ok: true }), {
  experienceLog,
  planProvider: { get: getActivePlanForSession },
  deviceExecutor: { current: null }, workspaceDir, terminalVerdictLog: tvLog,
});
for (let i = 0; i < N; i++) {
  const runId = `realboard-run-${i}`;
  const toolCallId = `realboard-tool-${i}`;
  await experienceLog.append({
    schemaVersion: 2, id: `exp-${i}`, sessionKey, taskId: plan.id, runId,
    attemptId: `${runId}:${toolCallId}`, stepId: `${plan.id}:step:1`, toolCallId, evidenceId: toolCallId,
    contractSkill: 'rdk-model-zoo', contractVersion: '1.0.0',
    environmentFingerprint: realboardIdentity.fingerprint,
    environmentIdentityVersion: realboardIdentity.schemaVersion,
    environmentCompleteness: realboardIdentity.completeness,
    executionDomain: 'real', realEvidenceEligible: true,
    tool: 'device_exec', input: { command: 'test_yolov5.py' }, reportedIsError: false,
    verdict: 'pass', reasonCode: 'all_postconditions_met', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1',
    durationMs: 1, timestamp: new Date().toISOString(),
  });
  const gated = await wrapped({
    sessionKey, runId, turn: 1, response: 'done', messages: [], totalToolCalls: 1, toolCallsByName: { device_exec: 1 },
    executionEvidence: { source: 'device_exec', toolUseId: toolCallId, exitCode: runs[i].exitCode, stdout: runs[i].stdout, stderr: '' },
  });
  assert.equal(gated.ok, true, `第 ${i + 1} 次真实 completion gate 应通过`);
}
const statsBySkill = aggregateTerminalBySkill(await tvLog.readAll());
const mzStats = statsBySkill.get('rdk-model-zoo');
assert.ok(mzStats);
assert.ok(mzStats.proofCount >= 10, `proofCount 应 ≥10,实际 ${mzStats.proofCount}`);
assert.equal(mzStats.successRate, 1.0, '10 次全 pass → successRate=1.0');
console.log(`  ✓ 真实 Plan + completion gate 写 ${mzStats.proofCount} 条 v2 rdk-model-zoo proof`);

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
