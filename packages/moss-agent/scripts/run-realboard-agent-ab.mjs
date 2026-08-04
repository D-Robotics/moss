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
import { RecoveryRecipeLog } from '../dist/memory/recovery-recipe-log.js';
import { readUsageLog, resolveLLMUsageLogPath } from '../dist/observability/llm-usage.js';
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
const allowedCostMetrics = new Set(['retries', 'toolCalls', 'durationMs', 'tokens']);
const requestedCostMetrics = (process.env.MOSS_AGENT_AB_COST_METRICS ?? '')
  .split(',').map((value) => value.trim()).filter((value) => allowedCostMetrics.has(value));
const experimentHypothesis = process.env.MOSS_AGENT_AB_HYPOTHESIS === 'success_superiority'
  ? 'success_superiority'
  : scenario === 'camera' ? 'success_noninferiority_cost_superiority' : 'success_superiority';
const experimentCostMetrics = requestedCostMetrics.length
  ? [...new Set(requestedCostMetrics)]
  : scenario === 'camera' ? ['durationMs'] : ['retries', 'toolCalls', 'durationMs', 'tokens'];
function finiteEnvNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
const experimentThresholds = {
  minSamplesPerArm: Math.max(2, targetPerArm),
  successNoninferiorityMargin: finiteEnvNumber('MOSS_AGENT_AB_SUCCESS_NONINFERIORITY_MARGIN', 0.05, 0, 0.5),
  minCostImprovementRatio: finiteEnvNumber('MOSS_AGENT_AB_MIN_COST_IMPROVEMENT_RATIO', 0.1, 0, 1),
  minCostMetricsImproved: Math.max(1, Math.min(4, Number.parseInt(process.env.MOSS_AGENT_AB_MIN_COST_METRICS_IMPROVED ?? (scenario === 'camera' ? '1' : '2'), 10))),
  maxCostRatio: finiteEnvNumber('MOSS_AGENT_AB_MAX_COST_RATIO', 1.2, 1, 10),
};
const requestedConcurrency = Math.max(1, Math.min(4, Number.parseInt(process.env.MOSS_AGENT_AB_CONCURRENCY ?? '4', 10)));
// The MIPI ISP pipeline is a singleton on the connected board. Never overlap
// camera arms, otherwise the benchmark itself introduces device contention.
const concurrency = scenario === 'camera' ? 1 : requestedConcurrency;
const maxLaunches = Math.max(targetPerArm * 2, Number.parseInt(process.env.MOSS_AGENT_AB_MAX_LAUNCHES ?? String(targetPerArm * 4), 10));
const benchmarkDir = path.resolve(process.env.MOSS_AGENT_AB_WORKSPACE
  ?? path.join(os.tmpdir(), `moss-${skillName}-real-agent-ab`));
const memoryDir = path.join(benchmarkDir, '.moss', 'memory');
const runLogDir = path.join(benchmarkDir, 'agent-runs');
const processResultPath = path.join(benchmarkDir, 'runner-process-results.jsonl');

await fs.mkdir(runLogDir, { recursive: true });
await fs.mkdir(path.join(benchmarkDir, '.moss'), { recursive: true });
await fs.writeFile(path.join(benchmarkDir, '.moss', 'evolution.json'), `${JSON.stringify({
  experiment: {
    hypothesis: experimentHypothesis,
    costMetrics: experimentCostMetrics,
    ...experimentThresholds,
  },
}, null, 2)}\n`, 'utf8');

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
const recipeLog = new RecoveryRecipeLog({ baseDir: memoryDir });
const memoryManager = new MemoryManager(memoryDir);
await memoryManager.load();
const patchCoordinator = new TrustedPatchCoordinator({
  workspaceDir: benchmarkDir,
  eventLog,
  patchLog,
  recipeLog,
  minRecoveryProofs: 2,
});
const learningCoordinator = new TrustedLearningCoordinator({
  eventLog,
  memoryManager,
  patchCoordinator,
  recipeLog,
});
const experimentCoordinator = new TrustedSkillExperimentCoordinator({
  workspaceDir: benchmarkDir,
  patchLog,
  experimentLog,
  terminalVerdictLog: terminalLog,
  learningEventLog: eventLog,
  rollback: (patchId) => patchCoordinator.rollback(patchId),
  hypothesis: experimentHypothesis,
  costMetrics: experimentCostMetrics,
  thresholds: experimentThresholds,
  readUsage: () => readUsageLog({ logPath: resolveLLMUsageLogPath({ workspaceDir: benchmarkDir }) }),
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

    let failedCommand = "sh -c 'echo controlled-readonly-failure >&2; exit 7'";
    let recoveryCommand = 'uname -m';
    if (scenario === 'camera') {
      await ssh.run('rm -f /root/handle_*.yuv', { timeout: 15_000 });
      const captureCommand = "(sleep 8; printf 'lq') | timeout 30 /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s 50 -c io >/dev/null 2>&1";
      const capture = await ssh.run(captureCommand, { timeout: 40_000 });
      const captureEvidence = `bootstrap-capture-${index}`;
      await experienceLog.append({
        schemaVersion: 2, id: `bootstrap-capture-experience-${index}`, sessionKey, taskId: plan.id, runId,
        attemptId: `${runId}:${captureEvidence}`, stepId: `${plan.id}:step:1`, toolCallId: captureEvidence,
        evidenceId: captureEvidence, contractSkill: skillName, contractVersion: '1',
        environmentFingerprint: identity.fingerprint, environmentIdentityVersion: identity.schemaVersion,
        environmentCompleteness: identity.completeness, executionDomain: 'real', realEvidenceEligible: true,
        tool: 'exec', input: { command: captureCommand }, reportedIsError: false, verdict: 'pass',
        reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1',
        durationMs: 1, timestamp: new Date().toISOString(),
      });
      if (capture.exitCode !== 0) throw new Error(`bootstrap_camera_capture_failed:${capture.exitCode}`);
      const yuv = (await ssh.run('ls -t /root/handle_*.yuv | head -1', { timeout: 15_000 })).stdout.trim();
      if (!/1920x1080.*\.yuv$/.test(yuv)) throw new Error(`bootstrap_camera_yuv_missing:${yuv}`);
      await ssh.run("sh -c 'if [ -d /tmp/photo.jpg ]; then rmdir /tmp/photo.jpg; fi; rm -f /tmp/photo.jpg; mkdir /tmp/photo.jpg'", { timeout: 15_000 });
      failedCommand = `ffmpeg -loglevel error -f rawvideo -pix_fmt nv12 -s 1920x1080 -i ${yuv} -frames 1 /tmp/photo.jpg -y`;
      recoveryCommand = `rmdir /tmp/photo.jpg && ffmpeg -loglevel error -f rawvideo -pix_fmt nv12 -s 1920x1080 -i ${yuv} -frames 1 /tmp/photo.jpg -y`;
    }
    let failed;
    try {
      failed = await ssh.run(failedCommand, { timeout: 40_000 });
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
      input: { command: scenario === 'camera' ? failedCommand : '<redacted-controlled-readonly-failure>' },
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
      input: { command: recoveryCommand },
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

  if (scenario !== 'camera') {
    throw new Error('actionable_recipe_adapter_unavailable:run_with_MOSS_AGENT_AB_SCENARIO=camera');
  }
  const recipe = (await recipeLog.latest()).find((entry) => (
    entry.skill === skillName
    && entry.environmentSelector.fingerprint === identity.fingerprint
    && entry.state === 'quality_validated'
  ));
  if (!recipe) throw new Error('trusted_recipe_not_quality_validated_after_two_real_recoveries');

  const shadowSessionKey = 'shadow-session-camera';
  const shadowRunId = `shadow-run-camera-${Date.now()}`;
  const shadowCtx = { workspaceDir: repositoryDir, sessionKey: shadowSessionKey, runId: shadowRunId };
  const shadowCreated = await planTool.execute({
    action: 'create', goal: 'Held-out RDK X5 camera output-collision Shadow replay',
    steps: [{ description: 'Recover a fresh JPEG from an occupied output path', expectedTools: ['exec'], expectedAccept: [skillName] }],
    terminalAccept: [
      { name: 'exit_code_zero', params: {} },
      { name: 'file_nonempty', params: { path: '/tmp/photo.jpg' } },
      { name: 'image_decodable', params: { path: '/tmp/photo.jpg' } },
      { name: 'image_dimensions', params: { path: '/tmp/photo.jpg', width: 1920, height: 1080 } },
      { name: 'image_content_nontrivial', params: { path: '/tmp/photo.jpg', minVariation: 8 } },
    ],
  }, shadowCtx);
  const shadowPlanId = /Plan created: (\S+)/.exec(shadowCreated)?.[1];
  if (!shadowPlanId) throw new Error(`shadow_plan_create_failed:${shadowCreated}`);
  await planTool.execute({ action: 'review', planId: shadowPlanId }, shadowCtx);
  await planTool.execute({ action: 'approve', planId: shadowPlanId }, shadowCtx);
  await planTool.execute({ action: 'start', planId: shadowPlanId }, shadowCtx);
  const shadowPlan = getActivePlanForSession(shadowSessionKey);
  if (!shadowPlan) throw new Error('shadow_plan_missing');
  await ssh.run('rm -f /root/handle_*.yuv', { timeout: 15_000 });
  await ssh.run("(sleep 8; printf 'lq') | timeout 30 /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s 50 -c io >/dev/null 2>&1", { timeout: 40_000 });
  const shadowYuv = (await ssh.run('ls -t /root/handle_*.yuv | head -1', { timeout: 15_000 })).stdout.trim();
  if (!/1920x1080.*\.yuv$/.test(shadowYuv)) throw new Error(`shadow_camera_yuv_missing:${shadowYuv}`);
  await ssh.run("sh -c 'if [ -d /tmp/photo.jpg ]; then rmdir /tmp/photo.jpg; fi; rm -f /tmp/photo.jpg; mkdir /tmp/photo.jpg'", { timeout: 15_000 });
  const stagingPath = `/tmp/moss-shadow-${Date.now()}.jpg`;
  const shadowCommand = `rmdir /tmp/photo.jpg && ffmpeg -loglevel error -f rawvideo -pix_fmt nv12 -s 1920x1080 -i ${shadowYuv} -frames 1 ${stagingPath} -y && mv ${stagingPath} /tmp/photo.jpg`;
  const shadowResult = await ssh.run(shadowCommand, { timeout: 40_000 });
  const shadowEvidence = `shadow-camera-${Date.now()}`;
  await experienceLog.append({
    schemaVersion: 2, id: `shadow-experience-${shadowEvidence}`, sessionKey: shadowSessionKey,
    taskId: shadowPlan.id, runId: shadowRunId, attemptId: `${shadowRunId}:${shadowEvidence}`,
    stepId: `${shadowPlan.id}:step:1`, toolCallId: shadowEvidence, evidenceId: shadowEvidence,
    contractSkill: skillName, contractVersion: '1', environmentFingerprint: identity.fingerprint,
    environmentIdentityVersion: identity.schemaVersion, environmentCompleteness: identity.completeness,
    executionDomain: 'real', realEvidenceEligible: true, tool: 'exec', input: { command: shadowCommand },
    reportedIsError: false, verdict: 'pass', reasonCode: 'all_postconditions_met', signalSource: 'exit_code',
    confidence: 'medium', verdictLevel: 'L1', durationMs: 1, timestamp: new Date().toISOString(),
  });
  const shadowAccepted = await terminalGate({
    sessionKey: shadowSessionKey, runId: shadowRunId, turn: 1, response: 'held-out shadow verified', messages: [],
    totalToolCalls: 1, toolCallsByName: { exec: 1 }, executionEvidence: {
      source: 'exec', toolUseId: shadowEvidence, exitCode: shadowResult.exitCode,
      stdout: shadowResult.stdout, stderr: shadowResult.stderr,
    },
  });
  if (!shadowAccepted.ok) throw new Error(`shadow_replay_terminal_failed:${shadowAccepted.reason ?? 'unknown'}`);
  const shadowPublished = await patchCoordinator.observeShadowReplay({
    recipeId: recipe.id, taskId: shadowPlan.id, runId: shadowRunId, evidenceIds: [shadowEvidence], verdict: 'pass',
  });
  if (!shadowPublished || shadowPublished.state !== 'published') throw new Error('shadow_replay_did_not_publish_patch');

  const published = (await patchLog.latest()).find((record) =>
    record.skill === skillName
      && record.environmentFingerprint === identity.fingerprint
      && record.state === 'published');
  if (!published) throw new Error('trusted_patch_not_published_after_two_real_recoveries');
  return published;
}

const patch = await ensurePublishedPatch();
process.stdout.write(`[bootstrap] published=${patch.id} artifact=${patch.artifactPath}\n`);

function latestExperimentOutcomes(records) {
  const latestByRun = new Map();
  for (const record of records) {
    if (record.kind !== 'outcome' || record.patchId !== patch.id) continue;
    const key = `${record.patchId}\0${record.taskId}\0${record.runId}`;
    const previous = latestByRun.get(key);
    if (!previous || Date.parse(record.timestamp) >= Date.parse(previous.timestamp)) latestByRun.set(key, record);
  }
  return [...latestByRun.values()];
}

function latestEligibleCounts(records) {
  const outcomes = latestExperimentOutcomes(records).filter((record) => record.eligible);
  return {
    control: outcomes.filter((entry) => entry.variant === 'control').length,
    treatment: outcomes.filter((entry) => entry.variant === 'treatment').length,
    outcomes,
  };
}

async function launchAgent(sequence, desiredVariant) {
  if (scenario === 'camera') {
    // Reversible, bounded fault: the required output path is occupied by an
    // empty directory. The learned recipe checks the target type and removes
    // only this exact empty benchmark-owned collision before staging output.
    await ssh.run("sh -c 'if [ -d /tmp/photo.jpg ]; then rmdir /tmp/photo.jpg; fi; rm -f /tmp/photo.jpg; mkdir /tmp/photo.jpg'", { timeout: 15_000 });
  }
  const marker = `real-agent-ab-${String(sequence).padStart(4, '0')}-${Date.now()}`;
  let prompt = scenario === 'camera'
    ? `${marker}: 这是 rdk-capture-photo 真实A/B任务。请使用 plan 工具创建、review、approve、start 一个单步骤 Plan；步骤 expectedTools=[exec]、expectedAccept=[rdk-capture-photo]；terminalAccept 必须包含 exit_code_zero、file_nonempty(path=/tmp/photo.jpg)、image_decodable(path=/tmp/photo.jpg)。随后在已连接的 RDK X5 上从当前 MIPI sensor 生成一张全新的 /tmp/photo.jpg，并依据机器验收返回结果。不得停止 cam-service，不得修改 ISP 配置，不得使用任务开始前的旧图片；所有探测和抓图必须有 timeout。`
    : `${marker}: 这是 rdk-hardware 真实A/B任务。请使用 plan 工具创建、review、approve、start 一个单步骤 Plan；步骤 expectedTools=[exec]、expectedAccept=[rdk-hardware]；terminalAccept 包含 exit_code_zero 和 stdout_matches(pattern=aarch64)。随后在已连接的 RDK X5 上只读执行 uname -m，依据机器验收返回结果，禁止任何板端写入。`;
  if (scenario === 'camera') {
    prompt = `${marker}: 这是 rdk-capture-photo 真实 A/B 任务。请用 plan 工具创建、review、approve、start 一个单步骤 Plan；步骤 expectedTools=[exec]、expectedAccept=[rdk-capture-photo]；terminalAccept 至少包含 exit_code_zero、file_nonempty(path=/tmp/photo.jpg)、image_decodable(path=/tmp/photo.jpg)、image_dimensions(path=/tmp/photo.jpg,width=1920,height=1080)。随后在已连接的 RDK X5 上从当前 MIPI sensor 生成全新的 /tmp/photo.jpg，并依据机器验收返回结果。不得停止 cam-service，不得修改 ISP 配置，不得使用任务开始前的旧图片；所有探测和抓图必须有 timeout。`;
  }
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
    let exitCode = null;
    let processError;
    try {
      exitCode = await new Promise((resolve, reject) => {
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
    } catch (error) {
      processError = error instanceof Error ? error.message : String(error);
    }
    return { marker, runId: selectedRunId, exitCode, processError, logPath };
  } finally {
    await output.close();
  }
}

async function readProcessResults() {
  try {
    return (await fs.readFile(processResultPath, 'utf8')).split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function latestProcessResults(records) {
  const latestByRun = new Map();
  for (const record of records) latestByRun.set(record.runId, record);
  return [...latestByRun.values()];
}

async function reconcileProcessResult(result) {
  const failed = result.exitCode !== 0 || Boolean(result.processError);
  const record = {
    schemaVersion: 1,
    runId: result.runId,
    marker: result.marker,
    exitCode: result.exitCode,
    failed,
    ...(result.processError ? { reasonCode: result.processError.startsWith('agent_timeout:') ? 'agent_process_timeout' : 'agent_process_error' } : {}),
    timestamp: new Date().toISOString(),
  };
  await fs.appendFile(processResultPath, `${JSON.stringify(record)}\n`, 'utf8');
  if (failed) {
    await experimentCoordinator.recordRunProcessFailure({
      patchId: patch.id,
      runId: result.runId,
      experiences: (await experienceLog.readAll()).filter((entry) => entry.runId === result.runId),
      reasonCode: record.reasonCode ?? 'agent_process_exit_nonzero',
      finishedAt: record.timestamp,
    });
  }
  return record;
}

async function reconcileRecordedProcessFailures() {
  const recorded = latestProcessResults(await readProcessResults());
  const experiences = await experienceLog.readAll();
  for (const record of recorded) {
    if (!record.failed || record.reasonCode === 'agent_process_interrupted_for_integrity_fix') continue;
    await experimentCoordinator.recordRunProcessFailure({
      patchId: patch.id,
      runId: record.runId,
      experiences: experiences.filter((entry) => entry.runId === record.runId),
      reasonCode: record.reasonCode ?? 'agent_process_exit_nonzero',
      finishedAt: record.timestamp,
    });
  }
}

await reconcileRecordedProcessFailures();
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
  for (const entry of settled) {
    if (entry.status === 'fulfilled') await reconcileProcessResult(entry.value);
  }
  launches += batchSize;
  counts = latestEligibleCounts(await experimentLog.readAll());
  const processResults = latestProcessResults(await readProcessResults());
  const failures = processResults.filter((entry) => entry.failed).length
    + settled.filter((entry) => entry.status === 'rejected').length;
  process.stdout.write(`[progress] launches=${launches}/${maxLaunches} control=${counts.control}/${targetPerArm} treatment=${counts.treatment}/${targetPerArm} processFailures=${failures}\n`);
}

const records = await experimentLog.readAll();
const decisions = records.filter((record) => record.kind === 'decision' && record.patchId === patch.id);
const decision = decisions.sort((left, right) => left.revision - right.revision).at(-1);
const excluded = latestExperimentOutcomes(records).filter((record) => !record.eligible).length;
const processResults = latestProcessResults(await readProcessResults());
const summary = {
  schemaVersion: 1,
  benchmarkDir,
  patchId: patch.id,
  environmentFingerprint: identity.fingerprint,
  targetPerArm,
  launches,
  eligible: { control: counts.control, treatment: counts.treatment },
  excluded,
  processFailures: processResults.filter((entry) => entry.failed).length,
  processResults: processResults.map(({ runId, exitCode, failed, reasonCode }) => ({ runId, exitCode, failed, ...(reasonCode ? { reasonCode } : {}) })),
  decision: decision ? {
    state: decision.state,
    reasonCode: decision.reasonCode,
    hypothesis: decision.hypothesis,
    improvedCostMetrics: decision.improvedCostMetrics,
    control: decision.control,
    treatment: decision.treatment,
  } : null,
  completed: counts.control >= targetPerArm && counts.treatment >= targetPerArm,
  timestamp: new Date().toISOString(),
};
await fs.writeFile(path.join(benchmarkDir, 'SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
if (scenario === 'camera') {
  try { await ssh.run("sh -c 'if [ -d /tmp/photo.jpg ]; then rmdir /tmp/photo.jpg; fi; rm -f /tmp/moss-shadow-*.jpg'", { timeout: 15_000 }); } catch { /* best-effort bounded cleanup */ }
}
await ssh.close();
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.completed) process.exitCode = 2;
