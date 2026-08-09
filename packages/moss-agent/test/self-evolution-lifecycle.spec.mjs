import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { PatchExperimentLog } from '../dist/memory/patch-experiment-log.js';
import { RecoveryRecipeLog, compileRecoveryRecipe } from '../dist/memory/recovery-recipe-log.js';
import { TrustedPatchCoordinator } from '../dist/memory/trusted-patch-coordinator.js';
import {
  TrustedSkillExperimentCoordinator,
  assignPatchExperimentVariant,
  createPatchExperimentTaskSignature,
} from '../dist/memory/trusted-skill-experiment-coordinator.js';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evolution-lifecycle-'));
const memoryDir = path.join(workspace, '.moss', 'memory');
const eventLog = new LearningEventLog({ baseDir: memoryDir });
const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
const recipeLog = new RecoveryRecipeLog({ baseDir: memoryDir });
const patchCoordinator = new TrustedPatchCoordinator({
  workspaceDir: workspace,
  eventLog,
  patchLog,
  recipeLog,
  minRecoveryProofs: 2,
});
const environmentFingerprint = 'sha256:v1:lifecycle-environment';
const recovery = (index) => ({
  schemaVersion: 1,
  id: `recovery-${index}`,
  sessionKey: `session-${index}`,
  taskId: `task-${index}`,
  runId: `recovery-run-${index}`,
  turn: 2,
  planVersion: 1,
  skill: 'rdk-capture-photo',
  skills: ['rdk-capture-photo'],
  attribution: 'single-skill',
  environmentFingerprint,
  environmentIdentityVersion: 1,
  environmentCompleteness: 'complete',
  outcome: 'recovered',
  failureClass: 'execution_failure',
  executionDomain: 'real',
  realEvidenceEligible: true,
  evidenceId: `recovery-evidence-${index}`,
  experienceIds: [`recovery-experience-${index}`],
  previousFailureId: `failure-${index}`,
  reasonCode: 'exit_zero',
  toolSequence: ['device_exec'],
  timestamp: new Date(Date.now() + index).toISOString(),
});
const recoveries = [recovery(1), recovery(2)];
const recipe = compileRecoveryRecipe({
  event: recoveries[1],
  relatedRecoveries: [recoveries[0]],
  experiences: [
    {
      schemaVersion: 2,
      id: 'recovery-experience-2',
      tool: 'exec',
      input: { command: 'ffmpeg -f rawvideo -pix_fmt nv12 -i /tmp/frame.yuv /tmp/photo.jpg' },
      reportedIsError: false,
      verdict: 'pass',
      signalSource: 'exit_code',
      confidence: 'high',
      durationMs: 5,
      timestamp: new Date().toISOString(),
      sessionKey: 'session-2',
      taskId: 'task-2',
      runId: 'recovery-run-2',
      evidenceId: 'recovery-evidence-2',
      environmentFingerprint,
      diagnostics: { recoveryAdapter: 'rdk-camera-output-collision' },
    },
  ],
});
assert.ok(recipe);
await recipeLog.append(recipe);
for (const baseEvent of recoveries) {
  const event = { ...baseEvent, recoveryRecipeId: recipe.id };
  await eventLog.append(event);
  await patchCoordinator.observeLearningEvent(event);
}
const [validated] = await patchLog.latest();
assert.equal(validated.state, 'validated');
const shadowPublished = await patchCoordinator.observeShadowReplay({
  recipeId: recipe.id,
  taskId: 'held-out-task',
  runId: 'held-out-run',
  evidenceIds: ['held-out-evidence'],
  verdict: 'pass',
});
assert.equal(shadowPublished.state, 'published');
const [published] = await patchLog.latest();
assert.equal(published.state, 'published');
assert.equal(published.environmentCompleteness, 'complete');
await fs.access(published.artifactPath);

const experimentLog = new PatchExperimentLog({ baseDir: memoryDir });
const terminalLog = new TerminalVerdictLog({ baseDir: memoryDir });
const experiment = new TrustedSkillExperimentCoordinator({
  workspaceDir: workspace,
  patchLog,
  experimentLog,
  terminalVerdictLog: terminalLog,
  rollback: (patchId) => patchCoordinator.rollback(patchId),
  thresholds: { minSamplesPerArm: 2, wilsonZ: 0.1, maxCostRatio: 1.2, maxRetryIncrease: 0.25 },
});
const signature = createPatchExperimentTaskSignature({
  userMessage: 'demo task',
  skill: 'rdk-capture-photo',
  environmentFingerprint,
});
function runFor(variant, prefix) {
  for (let index = 0; index < 10_000; index += 1) {
    const runId = `${prefix}-${index}`;
    if (
      assignPatchExperimentVariant({
        patchId: published.id,
        runId,
        taskSignature: signature,
        environmentFingerprint,
      }) === variant
    )
      return runId;
  }
  throw new Error(`No run id for ${variant}`);
}
let sequence = 0;
async function observe(variant, verdict, options = {}) {
  sequence += 1;
  const runId = runFor(variant, `${variant}-${sequence}`);
  const prepared = await experiment.prepareRun({
    sessionKey: `session-${runId}`,
    runId,
    userMessage: 'demo task',
    environmentFingerprint,
    skill: 'rdk-capture-photo',
    executionDomain: 'real',
    realEvidenceEligible: true,
  });
  assert.ok(prepared);
  assert.equal(prepared.assignment.variant, variant);
  await prepared.confirmExposure();
  const taskId = `experiment-task-${sequence}`;
  const evidenceId = `experiment-evidence-${sequence}`;
  const terminalEntry = {
    schemaVersion: 2,
    id: `terminal-${sequence}`,
    taskId,
    runId,
    turn: 1,
    attemptId: `${taskId}:${runId}:1`,
    evidenceId,
    skill: 'rdk-capture-photo',
    skills: ['rdk-capture-photo'],
    attribution: 'single-skill',
    environmentFingerprint,
    environmentIdentityVersion: 1,
    environmentCompleteness: 'complete',
    verdict,
    reason: verdict,
    sessionKey: `session-${runId}`,
    executionDomain: 'real',
    realEvidenceEligible: true,
    correctionCount: options.correctionCount ?? 0,
    ...(options.safetyFailed
      ? { safetyFailed: true, safetyReasonCode: 'safety_predicate_failed:force_below' }
      : {}),
    timestamp: new Date(Date.now() + sequence * 100).toISOString(),
  };
  await terminalLog.append(terminalEntry);
  return experiment.observeTerminal({
    terminalEntry,
    experiences: [
      {
        schemaVersion: 2,
        id: `experience-${sequence}`,
        tool: 'device_exec',
        input: {},
        reportedIsError: false,
        verdict: 'pass',
        signalSource: 'exit_code',
        confidence: 'high',
        durationMs: 5,
        timestamp: new Date(Date.parse(terminalEntry.timestamp) - 5).toISOString(),
        sessionKey: terminalEntry.sessionKey,
        taskId,
        runId,
        evidenceId,
        toolCallId: evidenceId,
        contractSkill: 'rdk-capture-photo',
        environmentFingerprint,
        environmentIdentityVersion: 1,
        environmentCompleteness: 'complete',
        executionDomain: 'real',
        realEvidenceEligible: true,
      },
    ],
  });
}

await observe('control', 'fail', { correctionCount: 1 });
await observe('control', 'fail', { correctionCount: 1 });
await observe('treatment', 'pass');
const activated = await observe('treatment', 'pass');
assert.equal(activated.decision.state, 'active');
const forcedTreatment = await experiment.prepareRun({
  sessionKey: 'active-session',
  runId: runFor('control', 'active-control-hash'),
  userMessage: 'demo task',
  environmentFingerprint,
  skill: 'rdk-capture-photo',
  executionDomain: 'real',
  realEvidenceEligible: true,
});
assert.equal(forcedTreatment.assignment.variant, 'treatment');
await forcedTreatment.confirmExposure();

// Active patches force treatment, so observe the forced assignment directly.
const safetyTaskId = 'safety-task';
const safetyEvidence = 'safety-evidence';
const safetyTerminal = {
  schemaVersion: 2,
  id: 'safety-terminal',
  taskId: safetyTaskId,
  runId: forcedTreatment.assignment.runId,
  turn: 1,
  attemptId: `${safetyTaskId}:${forcedTreatment.assignment.runId}:1`,
  evidenceId: safetyEvidence,
  skill: 'rdk-capture-photo',
  skills: ['rdk-capture-photo'],
  attribution: 'single-skill',
  environmentFingerprint,
  environmentIdentityVersion: 1,
  environmentCompleteness: 'complete',
  executionDomain: 'real',
  realEvidenceEligible: true,
  verdict: 'fail',
  reason: 'acceptance_failure',
  safetyFailed: true,
  safetyReasonCode: 'safety_predicate_failed:force_below',
  correctionCount: 1,
  sessionKey: 'active-session',
  timestamp: new Date().toISOString(),
};
await terminalLog.append(safetyTerminal);
const demoted = await experiment.observeTerminal({
  terminalEntry: safetyTerminal,
  experiences: [
    {
      schemaVersion: 2,
      id: 'safety-experience',
      tool: 'device_exec',
      input: {},
      reportedIsError: false,
      verdict: 'fail',
      signalSource: 'contract',
      confidence: 'high',
      durationMs: 5,
      timestamp: new Date().toISOString(),
      sessionKey: 'active-session',
      taskId: safetyTaskId,
      runId: safetyTerminal.runId,
      evidenceId: safetyEvidence,
      toolCallId: safetyEvidence,
      contractSkill: 'rdk-capture-photo',
      environmentFingerprint,
      environmentIdentityVersion: 1,
      environmentCompleteness: 'complete',
      executionDomain: 'real',
      realEvidenceEligible: true,
    },
  ],
});
assert.equal(demoted.decision.state, 'demoted');
assert.equal(demoted.decision.rollbackApplied, true);
assert.equal((await patchLog.latest(published.id))[0].state, 'rolled_back');
await assert.rejects(() => fs.access(published.artifactPath));
assert.equal(
  await experiment.prepareRun({
    sessionKey: 'after',
    runId: 'after',
    userMessage: 'demo task',
    environmentFingerprint,
    skill: 'rdk-capture-photo',
    executionDomain: 'real',
    realEvidenceEligible: true,
  }),
  null
);

await fs.rm(workspace, { recursive: true, force: true });
console.log('self-evolution-lifecycle: publish, shadow, active, safety demotion and rollback ok');
