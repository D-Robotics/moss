#!/usr/bin/env node
/**
 * Resumable, real-model A/B benchmark for trusted self-evolution guidance.
 *
 * The bootstrap phase obtains two independent failure -> recovery proofs from
 * the connected RDK board through the production terminal/learning gates. It
 * then launches the real Moss CLI for comparable read-only tasks until both
 * experiment arms contain the requested number of eligible outcomes.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import { makeReadonlyExecutor } from '../dist/core/tools/device-readonly-executor.js';
import { wrapWithTerminalArbitration } from '../dist/core/tools/terminal-arbitration-gate.js';
import { MemoryManager } from '../dist/core/index.js';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { PatchExperimentLog } from '../dist/memory/patch-experiment-log.js';
import { probeDeviceEnvironmentFacts, trustedEnvironmentIdentity } from '../dist/memory/environment-fingerprint.js';
import { TrustedLearningCoordinator } from '../dist/memory/trusted-learning-coordinator.js';
import { TrustedPatchCoordinator } from '../dist/memory/trusted-patch-coordinator.js';
import {
  TrustedSkillExperimentCoordinator,
  assignPatchExperimentVariant,
  createPatchExperimentTaskSignature,
} from '../dist/memory/trusted-skill-experiment-coordinator.js';
import { getActivePlanForSession } from '../dist/plan-execute/plan-controller-store.js';
import { planTool } from '../dist/plan-execute/plan-tools.js';
import { DeviceSshSession } from '../dist/tools/device-ssh-session.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(packageDir, '..', '..');
const cliPath = path.join(packageDir, 'dist', 'cli.js');
const host = process.env.MOSS_REALBOARD_HOST ?? process.env.MOSS_DEVICE_HOST ?? '192.168.127.10';
const scenario = process.env.MOSS_AGENT_AB_SCENARIO === 'camera' ? 'camera' : 'hardware';
const skillName = scenario === 'camera' ? 'rdk-capture-photo' : 'rdk-hardware';
const targetPerArm = Math.max(1, Number.parseInt(process.env.MOSS_AGENT_AB_TARGET ?? '20', 10));
const requestedConcurrency = Math.max(1, Math.min(4, Number.parseInt(process.env.MOSS_AGENT_AB_CONCURRENCY ?? '4', 10)));
// The MIPI ISP pipeline is a singleton on the connected board. Never overlap
// camera arms, otherwise the benchmark itself introduces device contention.
const concurrency = scenario === 'camera' ? 1 : requestedConcurrency;
const maxLaunches = Math.max(targetPerArm * 2, Number.parseInt(process.env.MOSS_AGENT_AB_MAX_LAUNCHES ?? String(targetPerArm * 4), 10));
const benchmarkDir = path.resolve(process.env.MOSS_AGENT_AB_WORKSPACE
  ?? path.join(os.tmpdir(), `moss-${skillName}-real-agent-ab`));
const memoryDir = path.join(benchmarkDir, '.moss', 'memory');
const runLogDir = path.join(benchmarkDir, 'agent-runs');

await fs.mkdir(runLogDir, { recursive: true });

const ssh = new DeviceSshSession({ host, user: process.env.MOSS_DEVICE_USER ?? 'root', port: 22 });
let identity;
try {
  await ssh.connect();
  const facts = await probeDeviceEnvironmentFacts(ssh);
  identity = trustedEnvironmentIdentity({ workspaceDir: benchmarkDir, runtimeMode: 'device', device: facts });
  if (identity.completeness !== 'complete' || identity.fingerprint === 'unknown') {
    throw new Error(`incomplete_realboard_identity:${identity.reasonCode}`);
  }
  process.stdout.write(`[bootstrap] board=${facts.boardModel ?? 'unknown'} fingerprint=${identity.fingerprint}\n`);
} catch (error) {
  await ssh.close();
  throw error;
}

const experienceLog = new ExperienceLog({ baseDir: memoryDir });
const terminalLog = new TerminalVerdictLog({ baseDir: memoryDir });
const eventLog = new LearningEventLog({ baseDir: memoryDir });
const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
const experimentLog = new PatchExperimentLog({ baseDir: memoryDir });
const memoryManager = new MemoryManager(memoryDir);
await memoryManager.load();
const patchCoordinator = new TrustedPatchCoordinator({
  workspaceDir: benchmarkDir,
  eventLog,
  patchLog,
  minRecoveryProofs: 2,
});
const learningCoordinator = new TrustedLearningCoordinator({
  eventLog,
  memoryManager,
  patchCoordinator,
});
const experimentCoordinator = new TrustedSkillExperimentCoordinator({
  workspaceDir: benchmarkDir,
  patchLog,
  experimentLog,
  terminalVerdictLog: terminalLog,
  learningEventLog: eventLog,
  rollback: (patchId) => patchCoordinator.rollback(patchId),
});
const terminalGate = wrapWithTerminalArbitration(async () => ({ ok: true }), {
  experienceLog,
  planProvider: { get: getActivePlanForSession },
  deviceExecutor: { current: makeReadonlyExecutor({ sshSession: ssh }) },
  workspaceDir: benchmarkDir,
  terminalVerdictLog: terminalLog,
  trustedLearningCoordinator: learningCoordinator,
  trustedSkillExperimentCoordinator: experimentCoordinator,
});

async function ensurePublishedPatch() {
  const existing = (await patchLog.latest()).find((record) =>
    record.skill === skillName
      && record.environmentFingerprint === identity.fingerprint
      && record.state === 'published');
  if (existing) return existing;

  for (let index = 1; index <= 2; index += 1) {
    const sessionKey = `bootstrap-session-${index}`;
    const runId = `bootstrap-run-${index}`;
    // Plan acceptance validation needs the repository's bundled SkillRegistry;
    // execution evidence and patch identity remain scoped to benchmarkDir.
    const ctx = { workspaceDir: repositoryDir, sessionKey, runId };
    const created = await planTool.execute({
      action: 'create',
      goal: `RDK X5 ${scenario} recovery proof ${index}`,
      steps: [{
        description: 'Read and verify the board architecture',
        expectedTools: ['exec'],
        expectedAccept: [skillName],
      }],
      terminalAccept: scenario === 'camera' ? [
        { name: 'exit_code_zero', params: {} },
        { name: 'file_nonempty', params: { path: '/tmp/photo.jpg' } },
        { name: 'image_decodable', params: { path: '/tmp/photo.jpg' } },
      ] : [
        { name: 'exit_code_zero', params: {} },
        { name: 'stdout_matches', params: { pattern: 'aarch64' } },
      ],
    }, ctx);
    const planId = /Plan created: (\S+)/.exec(created)?.[1];
    if (!planId) throw new Error(`bootstrap_plan_create_failed:${created}`);
    await planTool.execute({ action: 'review', planId }, ctx);
    await planTool.execute({ action: 'approve', planId }, ctx);
    await planTool.execute({ action: 'start', planId }, ctx);
    const plan = getActivePlanForSession(sessionKey);
    if (!plan) throw new Error('bootstrap_plan_missing');

    let failed;
    try {
      failed = await ssh.run("sh -c 'echo controlled-readonly-failure >&2; exit 7'", { timeout: 15_000 });
    } catch (error) {
      if (!error || typeof error !== 'object' || typeof error.exitCode !== 'number') throw error;
      failed = {
        exitCode: error.exitCode,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : '',
      };
    }
    if (failed.exitCode === 0) throw new Error('bootstrap_failure_did_not_fail');
    const failedEvidence = `bootstrap-fail-${index}`;
    await experienceLog.append({
      schemaVersion: 2,
      id: `bootstrap-fail-experience-${index}`,
      sessionKey,
      taskId: plan.id,
      runId,
      attemptId: `${runId}:${failedEvidence}`,
      stepId: `${plan.id}:step:1`,
      toolCallId: failedEvidence,
      evidenceId: failedEvidence,
      contractSkill: skillName,
      contractVersion: '1',
      environmentFingerprint: identity.fingerprint,
      environmentIdentityVersion: identity.schemaVersion,
      environmentCompleteness: identity.completeness,
      executionDomain: 'real',
      realEvidenceEligible: true,
      tool: 'exec',
      input: { command: '<redacted-controlled-readonly-failure>' },
      reportedIsError: true,
      verdict: 'fail',
      reasonCode: 'nonzero_exit',
      signalSource: 'exit_code',
      confidence: 'medium',
      verdictLevel: 'L1',
      durationMs: 1,
      timestamp: new Date().toISOString(),
    });
    const blocked = await terminalGate({
      sessionKey,
      runId,
      turn: 1,
      response: 'failed verification',
      messages: [],
      totalToolCalls: 1,
      toolCallsByName: { exec: 1 },
      executionEvidence: {
        source: 'exec',
        toolUseId: failedEvidence,
        exitCode: failed.exitCode,
        stdout: failed.stdout,
        stderr: failed.stderr,
      },
    });
    if (blocked.ok) throw new Error('bootstrap_failure_was_not_blocked');

    let recoveryCommand = 'uname -m';
    if (scenario === 'camera') {
      await ssh.run("(sleep 8; printf 'lq') | timeout 30 /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s 50 -c io >/dev/null 2>&1", { timeout: 40_000 });
      const yuv = (await ssh.run('ls -t /root/handle_*.yuv | head -1', { timeout: 15_000 })).stdout.trim();
      if (!/1920x1080.*\.yuv$/.test(yuv)) throw new Error(`bootstrap_camera_yuv_missing:${yuv}`);
      recoveryCommand = `ffmpeg -loglevel error -f rawvideo -pix_fmt nv12 -s 1920x1080 -i ${yuv} -frames 1 /tmp/photo.jpg -y`;
    }
    const recovered = await ssh.run(recoveryCommand, { timeout: 40_000 });
    if (recovered.exitCode !== 0 || (scenario === 'hardware' && !/aarch64/i.test(recovered.stdout))) {
      throw new Error(`bootstrap_recovery_failed:${recovered.exitCode}`);
    }
    const recoveredEvidence = `bootstrap-recovered-${index}`;
    await experienceLog.append({
      schemaVersion: 2,
      id: `bootstrap-recovered-experience-${index}`,
      sessionKey,
      taskId: plan.id,
      runId,
      attemptId: `${runId}:${recoveredEvidence}`,
      stepId: `${plan.id}:step:1`,
      toolCallId: recoveredEvidence,
      evidenceId: recoveredEvidence,
      contractSkill: skillName,
      contractVersion: '1',
      environmentFingerprint: identity.fingerprint,
      environmentIdentityVersion: identity.schemaVersion,
      environmentCompleteness: identity.completeness,
      executionDomain: 'real',
      realEvidenceEligible: true,
      tool: 'exec',
      input: { command: scenario === 'camera' ? '<verified-camera-recovery>' : 'uname -m' },
      reportedIsError: false,
      verdict: 'pass',
      reasonCode: 'all_postconditions_met',
      signalSource: 'exit_code',
      confidence: 'medium',
      verdictLevel: 'L1',
      durationMs: 1,
      timestamp: new Date().toISOString(),
    });
    const accepted = await terminalGate({
      sessionKey,
      runId,
      turn: 2,
      response: 'recovered verification',
      messages: [],
      totalToolCalls: 2,
      toolCallsByName: { exec: 2 },
      executionEvidence: {
        source: 'exec',
        toolUseId: recoveredEvidence,
        exitCode: recovered.exitCode,
        stdout: recovered.stdout,
        stderr: recovered.stderr,
      },
    });
    if (!accepted.ok) throw new Error(`bootstrap_recovery_was_not_accepted:${accepted.reason ?? 'unknown'}`);
  }

  const published = (await patchLog.latest()).find((record) =>
    record.skill === skillName
      && record.environmentFingerprint === identity.fingerprint
      && record.state === 'published');
  if (!published) throw new Error('trusted_patch_not_published_after_two_real_recoveries');
  return published;
}

const patch = await ensurePublishedPatch();
process.stdout.write(`[bootstrap] published=${patch.id} artifact=${patch.artifactPath}\n`);

function latestEligibleCounts(records) {
  const latestByRun = new Map();
  for (const record of records) {
    if (record.kind !== 'outcome' || record.patchId !== patch.id) continue;
    const key = `${record.patchId}\0${record.taskId}\0${record.runId}`;
    const previous = latestByRun.get(key);
    if (!previous || Date.parse(record.timestamp) >= Date.parse(previous.timestamp)) latestByRun.set(key, record);
  }
  const outcomes = [...latestByRun.values()].filter((record) => record.eligible);
  return {
    control: outcomes.filter((entry) => entry.variant === 'control').length,
    treatment: outcomes.filter((entry) => entry.variant === 'treatment').length,
    outcomes,
  };
}

async function launchAgent(sequence, desiredVariant) {
  if (scenario === 'camera') {
    // Exact bounded benchmark artifact: removing it makes stale-file success
    // impossible while leaving camera/ISP configuration untouched.
    try { await ssh.run('rm -f /tmp/photo.jpg', { timeout: 15_000 }); } catch (error) {
      if (!error || typeof error !== 'object' || error.exitCode !== 0) throw error;
    }
  }
  const marker = `real-agent-ab-${String(sequence).padStart(4, '0')}-${Date.now()}`;
  const prompt = scenario === 'camera'
    ? `${marker}: 这是 rdk-capture-photo 真实A/B任务。请使用 plan 工具创建、review、approve、start 一个单步骤 Plan；步骤 expectedTools=[exec]、expectedAccept=[rdk-capture-photo]；terminalAccept 必须包含 exit_code_zero、file_nonempty(path=/tmp/photo.jpg)、image_decodable(path=/tmp/photo.jpg)。随后在已连接的 RDK X5 上从当前 MIPI sensor 生成一张全新的 /tmp/photo.jpg，并依据机器验收返回结果。不得停止 cam-service，不得修改 ISP 配置，不得使用任务开始前的旧图片；所有探测和抓图必须有 timeout。`
    : `${marker}: 这是 rdk-hardware 真实A/B任务。请使用 plan 工具创建、review、approve、start 一个单步骤 Plan；步骤 expectedTools=[exec]、expectedAccept=[rdk-hardware]；terminalAccept 包含 exit_code_zero 和 stdout_matches(pattern=aarch64)。随后在已连接的 RDK X5 上只读执行 uname -m，依据机器验收返回结果，禁止任何板端写入。`;
  const taskSignature = createPatchExperimentTaskSignature({
    userMessage: prompt,
    skill: skillName,
    environmentFingerprint: identity.fingerprint,
  });
  let selectedRunId;
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = `real-agent-ab-${scenario}-${sequence}-${index}`;
    if (assignPatchExperimentVariant({
      patchId: patch.id,
      runId: candidate,
      taskSignature,
      environmentFingerprint: identity.fingerprint,
    }) === desiredVariant) {
      selectedRunId = candidate;
      break;
    }
  }
  if (!selectedRunId) throw new Error(`unable_to_assign_${desiredVariant}:${marker}`);
  const logPath = path.join(runLogDir, `${marker}.log`);
  const output = await fs.open(logPath, 'w');
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, '--full-access', '--quiet', prompt], {
        cwd: benchmarkDir,
        env: {
          ...process.env,
          MOSS_DEVICE_HOST: host,
          MOSS_DEVICE_USER: process.env.MOSS_DEVICE_USER ?? 'root',
          MOSS_CLI_AUTO_APPROVE: '1',
          MOSS_RUN_ID: selectedRunId,
        },
        stdio: ['ignore', output.fd, output.fd],
        windowsHide: true,
      });
      const taskTimeoutMs = scenario === 'camera' ? 10 * 60_000 : 5 * 60_000;
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
        reject(new Error(`agent_timeout:${marker}`));
      }, taskTimeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    return { marker, exitCode, logPath };
  } finally {
    await output.close();
  }
}

let launches = (await fs.readdir(runLogDir)).filter((name) => name.endsWith('.log')).length;
let counts = latestEligibleCounts(await experimentLog.readAll());
process.stdout.write(`[resume] eligible control=${counts.control}/${targetPerArm} treatment=${counts.treatment}/${targetPerArm} priorLaunches=${launches}\n`);

while ((counts.control < targetPerArm || counts.treatment < targetPerArm) && launches < maxLaunches) {
  const remainingBudget = maxLaunches - launches;
  const batchSize = Math.min(concurrency, remainingBudget);
  const desiredVariant = counts.control >= targetPerArm && counts.treatment < targetPerArm
    ? 'treatment'
    : counts.treatment >= targetPerArm && counts.control < targetPerArm
      ? 'control'
      : counts.control <= counts.treatment ? 'control' : 'treatment';
  const batch = Array.from({ length: batchSize }, (_, offset) => launchAgent(launches + offset + 1, desiredVariant));
  const settled = await Promise.allSettled(batch);
  launches += batchSize;
  counts = latestEligibleCounts(await experimentLog.readAll());
  const failures = settled.filter((entry) => entry.status === 'rejected'
    || (entry.status === 'fulfilled' && entry.value.exitCode !== 0)).length;
  process.stdout.write(`[progress] launches=${launches}/${maxLaunches} control=${counts.control}/${targetPerArm} treatment=${counts.treatment}/${targetPerArm} processFailures=${failures}\n`);
}

const records = await experimentLog.readAll();
const decisions = records.filter((record) => record.kind === 'decision' && record.patchId === patch.id);
const decision = decisions.sort((left, right) => left.revision - right.revision).at(-1);
const excluded = records.filter((record) => record.kind === 'outcome' && record.patchId === patch.id && !record.eligible).length;
const summary = {
  schemaVersion: 1,
  benchmarkDir,
  patchId: patch.id,
  environmentFingerprint: identity.fingerprint,
  targetPerArm,
  launches,
  eligible: { control: counts.control, treatment: counts.treatment },
  excluded,
  decision: decision ? {
    state: decision.state,
    reasonCode: decision.reasonCode,
    control: decision.control,
    treatment: decision.treatment,
  } : null,
  completed: counts.control >= targetPerArm && counts.treatment >= targetPerArm,
  timestamp: new Date().toISOString(),
};
await fs.writeFile(path.join(benchmarkDir, 'SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
await ssh.close();
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.completed) process.exitCode = 2;
