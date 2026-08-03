#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CandidatePatchLog,
  PatchExperimentLog,
  TrustedSkillExperimentCoordinator,
  assignPatchExperimentVariant,
  buildTrustedPatchExperimentContext,
  createPatchExperimentTaskSignature,
} from '../dist/memory/index.js';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import { SkillRegistry } from '../dist/skills/registry.js';
import { loadSkillTool } from '../dist/tools/skill-tools.js';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { MemoryManager } from '../dist/memory/memory-manager.js';
import { parseSkillDocument } from '../dist/skills/skill-document.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-patch-ab-'));
const memoryDir = path.join(workspace, '.moss', 'memory');
const baseSkillDir = path.join(workspace, '.moss', 'skills', 'rdk-demo');
const learnedDir = path.join(workspace, '.moss', 'skills', 'learned', 'rdk-demo-trusted-recovery');
const artifactPath = path.join(learnedDir, 'SKILL.md');
await fs.mkdir(baseSkillDir, { recursive: true });
await fs.mkdir(learnedDir, { recursive: true });
await fs.writeFile(path.join(baseSkillDir, 'SKILL.md'), [
  '---', 'name: rdk-demo', 'description: demo board recovery', 'triggers: demo board', '---', '', 'Base guidance.',
].join('\n'));
await fs.writeFile(artifactPath, [
  '---', 'name: rdk-demo-trusted-recovery', 'description: generated recovery', 'triggers: demo board', '---', '',
  'LEARNED_RECOVERY_GUIDANCE',
].join('\n'));
await fs.writeFile(path.join(learnedDir, 'TRUSTED-PATCH.json'), JSON.stringify({ schemaVersion: 1, patchId: 'patch-ab' }));

const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
await patchLog.append({
  schemaVersion: 1, id: 'patch-ab', revision: 1, kind: 'skill-guidance', state: 'published',
  skill: 'rdk-demo', environmentFingerprint: 'env-demo', failureClass: 'execution_failure',
  sourceEventIds: ['learn-1', 'learn-2'], toolSequences: [['device_exec']],
  reasonCode: 'auto_published_trusted_recovery', artifactPath, timestamp: new Date().toISOString(),
});

const registry = new SkillRegistry({ workspaceDir: workspace });
const generated = registry.list().find((skill) => skill.name === 'rdk-demo-trusted-recovery');
assert.ok(generated, 'generated Skill remains visible for audit');
assert.equal(generated.enabled, false, 'generated Skill is disabled from ordinary activation');
assert.deepEqual(registry.matchByText('demo board task').map((skill) => skill.name), ['rdk-demo']);
assert.match(
  await loadSkillTool.execute({ name: 'rdk-demo-trusted-recovery' }, { workspaceDir: workspace }),
  /not found/i,
  'load_skill cannot bypass experiment isolation',
);

const experimentLog = new PatchExperimentLog({ baseDir: memoryDir });
const terminalLog = new TerminalVerdictLog({ baseDir: memoryDir });
const learningEventLog = new LearningEventLog({ baseDir: memoryDir });
const usage = [];
let rollbacks = 0;
const coordinator = new TrustedSkillExperimentCoordinator({
  workspaceDir: workspace,
  patchLog,
  experimentLog,
  terminalVerdictLog: terminalLog,
  learningEventLog,
  readUsage: async () => usage,
  rollback: async () => { rollbacks += 1; return true; },
  thresholds: { minSamplesPerArm: 2, wilsonZ: 0.1, maxCostRatio: 1.2, maxRetryIncrease: 0.25 },
});

const digestMemory = new MemoryManager(path.join(workspace, '.moss', 'digest-memory'));
await digestMemory.load();
await digestMemory.add('MATCHING_TRUSTED_OBSERVATION', 'memory', undefined, {
  scope: 'workspace', trust: 'observation', topic: 'learning:v2:rdk-demo:env-demo:execution_failure',
});
await digestMemory.add('UNRELATED_MEMORY', 'memory', undefined, {
  scope: 'workspace', trust: 'observation', topic: 'other-topic',
});
assert.match(await digestMemory.buildDigest(), /MATCHING_TRUSTED_OBSERVATION/);
const isolatedDigest = await digestMemory.buildDigest({
  excludeTopicPrefixes: ['learning:v2:rdk-demo:env-demo:'],
});
assert.doesNotMatch(isolatedDigest, /MATCHING_TRUSTED_OBSERVATION/);
assert.match(isolatedDigest, /UNRELATED_MEMORY/);

const signature = createPatchExperimentTaskSignature({
  userMessage: 'demo board task', skill: 'rdk-demo', environmentFingerprint: 'env-demo',
});
assert.deepEqual(
  parseSkillDocument('\uFEFF---\r\nname: demo\r\n---\r\n\r\nGuidance\r\n---\r\nTail'),
  { frontmatter: 'name: demo', body: 'Guidance\n---\nTail' },
);
assert.equal(parseSkillDocument('---\nname: unclosed').body, '', 'malformed frontmatter is not injected');

const assignments = Array.from({ length: 2_000 }, (_, index) => assignPatchExperimentVariant({
  patchId: 'patch-ab', runId: `distribution-${index}`, taskSignature: signature,
  environmentFingerprint: 'env-demo',
}));
const treatmentShare = assignments.filter((variant) => variant === 'treatment').length / assignments.length;
assert.ok(treatmentShare > 0.45 && treatmentShare < 0.55, `assignment split should be balanced, got ${treatmentShare}`);
function runFor(variant, prefix, start = 0) {
  for (let i = start; i < start + 10_000; i += 1) {
    const runId = `${prefix}-${i}`;
    if (assignPatchExperimentVariant({ patchId: 'patch-ab', runId, taskSignature: signature, environmentFingerprint: 'env-demo' }) === variant) return runId;
  }
  throw new Error(`unable to find ${variant} run id`);
}

const controlRun = runFor('control', 'stable-control');
const treatmentRun = runFor('treatment', 'stable-treatment');
const control = await coordinator.prepareRun({
  sessionKey: 'session-control', runId: controlRun, userMessage: 'demo board task',
  environmentFingerprint: 'env-demo', skill: 'rdk-demo',
});
assert.equal(control.assignment.variant, 'control');
assert.equal(control.assignment.exposed, false);
assert.equal(control.guidanceContext, '');
let observationLoads = 0;
const controlContext = await buildTrustedPatchExperimentContext({
  digest: 'BASE_DIGEST', prepared: control,
  loadTrustedObservation: async () => { observationLoads += 1; return 'TRUSTED_OBSERVATION'; },
});
assert.equal(controlContext, 'BASE_DIGEST');
assert.equal(observationLoads, 0, 'control does not load the matching Observation');

const treatment = await coordinator.prepareRun({
  sessionKey: 'session-treatment', runId: treatmentRun, userMessage: 'demo board task',
  environmentFingerprint: 'env-demo', skill: 'rdk-demo',
});
assert.equal(treatment.assignment.variant, 'treatment');
assert.equal(treatment.assignment.exposed, true);
const treatmentContext = await buildTrustedPatchExperimentContext({
  digest: 'BASE_DIGEST', prepared: treatment,
  loadTrustedObservation: async () => { observationLoads += 1; return 'TRUSTED_OBSERVATION'; },
});
assert.match(treatmentContext, /LEARNED_RECOVERY_GUIDANCE/);
assert.match(treatmentContext, /TRUSTED_OBSERVATION/);
assert.equal(observationLoads, 1);
await coordinator.prepareRun({
  sessionKey: 'session-treatment', runId: treatmentRun, userMessage: 'demo board task',
  environmentFingerprint: 'env-demo', skill: 'rdk-demo',
});
assert.equal((await experimentLog.readAll()).filter((entry) => entry.kind === 'assignment' && entry.runId === treatmentRun).length, 1);
assert.equal(await coordinator.prepareRun({
  sessionKey: 'unknown', runId: 'unknown-run', userMessage: 'demo board task',
  environmentFingerprint: 'unknown', skill: 'rdk-demo',
}), null);

function experience(taskId, runId, evidenceId, timestamp) {
  return {
    schemaVersion: 2, id: `exp-${evidenceId}`, tool: 'device_exec', input: {}, reportedIsError: false,
    verdict: 'pass', signalSource: 'exit_code', confidence: 'high', durationMs: 10, timestamp,
    sessionKey: `session-${runId}`, taskId, runId, evidenceId, toolCallId: evidenceId,
    contractSkill: 'rdk-demo', environmentFingerprint: 'env-demo',
  };
}
async function observe(runId, verdict, index, options = {}) {
  const prepared = await coordinator.prepareRun({
    sessionKey: `session-${runId}`, runId, userMessage: 'demo board task',
    environmentFingerprint: 'env-demo', skill: 'rdk-demo',
  });
  assert.ok(prepared);
  const taskId = `task-${index}`;
  const evidenceId = `evidence-${index}`;
  const timestamp = new Date(Date.now() + index * 100).toISOString();
  const terminal = {
    schemaVersion: 2, id: `terminal-${index}`, taskId, runId, turn: index, attemptId: `${taskId}:${runId}:${index}`,
    evidenceId, skill: 'rdk-demo', skills: ['rdk-demo'], attribution: 'single-skill',
    environmentFingerprint: 'env-demo', verdict, reason: options.reason ?? verdict,
    sessionKey: `session-${runId}`, timestamp,
  };
  await terminalLog.append(terminal);
  if (verdict === 'fail') {
    await learningEventLog.append({
      schemaVersion: 1, id: `learning-${index}`, sessionKey: `session-${runId}`, taskId, runId,
      turn: index, planVersion: 1, skill: 'rdk-demo', skills: ['rdk-demo'], attribution: 'single-skill',
      environmentFingerprint: 'env-demo', outcome: 'failed', failureClass: 'acceptance_failure',
      evidenceId, experienceIds: [`exp-${evidenceId}`], reasonCode: 'terminal_fail', timestamp,
    });
  }
  usage.push({
    timestamp, runId, providerId: 'test', model: 'test', inputTokens: 100, outputTokens: 20,
    estimatedCostUsd: 0.01, durationMs: 50, success: true,
  });
  return coordinator.observeTerminal({
    terminalEntry: terminal,
    experiences: [experience(taskId, runId, evidenceId, new Date(Date.parse(timestamp) - 50).toISOString())],
    safetyFailed: options.safetyFailed,
  });
}

const controlRuns = [runFor('control', 'metric-control-a'), runFor('control', 'metric-control-b'), runFor('control', 'metric-control-c')];
const treatmentRuns = [runFor('treatment', 'metric-treatment-a'), runFor('treatment', 'metric-treatment-b')];
await observe(controlRuns[0], 'fail', 1);
await observe(controlRuns[1], 'fail', 2);
const unknownResult = await observe(controlRuns[2], 'unknown', 3);
assert.equal(unknownResult.outcome.success, false);
await observe(treatmentRuns[0], 'pass', 4);
const activated = await observe(treatmentRuns[1], 'pass', 5);
assert.equal(activated.decision.state, 'active');
assert.equal(activated.decision.reasonCode, 'credible_benefit');
assert.equal(activated.decision.control.unknown, 1, 'unknown stays in the denominator');
assert.equal(activated.outcome.inputTokens, 100);
assert.equal(activated.outcome.outputTokens, 20);
assert.equal(activated.outcome.estimatedCostUsd, 0.01);
assert.equal(activated.outcome.toolCalls, 1);
assert.equal(activated.outcome.durationMs, 50);
assert.equal(activated.decision.control.failureClasses.acceptance_failure, 2);

await observe(treatmentRuns[1], 'pass', 5);
assert.equal((await experimentLog.readAll()).filter((entry) => entry.kind === 'outcome' && entry.runId === treatmentRuns[1]).length, 1, 'terminal replay is idempotent');

const activeRun = runFor('control', 'would-have-been-control');
const activePrepared = await coordinator.prepareRun({
  sessionKey: 'session-active', runId: activeRun, userMessage: 'demo board task',
  environmentFingerprint: 'env-demo', skill: 'rdk-demo',
});
assert.equal(activePrepared.assignment.variant, 'treatment', 'active patch treats every eligible run');
const demoted = await observe(activeRun, 'fail', 6, { safetyFailed: true, reason: 'safety_constraint_failed' });
assert.equal(demoted.decision.state, 'demoted');
assert.equal(demoted.decision.reasonCode, 'treatment_safety_failure');
assert.equal(rollbacks, 1);
assert.equal(await coordinator.prepareRun({
  sessionKey: 'after-demotion', runId: 'after-demotion', userMessage: 'demo board task',
  environmentFingerprint: 'env-demo', skill: 'rdk-demo',
}), null);

const legacy = await coordinator.observeTerminal({
  terminalEntry: { id: 'legacy', skill: 'rdk-demo', verdict: 'pass', reason: 'legacy', sessionKey: 'legacy', timestamp: new Date().toISOString() },
  experiences: [experience('legacy-task', treatmentRun, 'legacy-evidence', new Date().toISOString())],
});
assert.equal(legacy, null, 'legacy terminal evidence is excluded');

const secondBaseDir = path.join(workspace, '.moss', 'skills', 'rdk-demo-two');
await fs.mkdir(secondBaseDir, { recursive: true });
await fs.writeFile(path.join(secondBaseDir, 'SKILL.md'), [
  '---', 'name: rdk-demo-two', 'description: second demo board skill', 'triggers: demo board', '---', '', 'Second.',
].join('\n'));
await patchLog.append({
  schemaVersion: 1, id: 'patch-ab-two', revision: 1, kind: 'skill-guidance', state: 'published',
  skill: 'rdk-demo-two', environmentFingerprint: 'env-demo', failureClass: 'execution_failure',
  sourceEventIds: [], toolSequences: [['device_exec']], reasonCode: 'published', artifactPath,
  timestamp: new Date().toISOString(),
});
assert.equal(await coordinator.prepareRun({
  sessionKey: 'multi-skill', runId: 'multi-skill-run', userMessage: 'demo board task',
  environmentFingerprint: 'env-demo',
}), null, 'ambiguous multi-Skill matches are excluded');

const report = await coordinator.formatReport('patch-ab');
assert.match(report, /control: n=3/);
assert.match(report, /treatment: n=3/);

const regressionDir = path.join(workspace, '.moss', 'regression');
const regressionPatches = new CandidatePatchLog({ baseDir: regressionDir });
const regressionExperiments = new PatchExperimentLog({ baseDir: regressionDir });
await regressionPatches.append({
  schemaVersion: 1, id: 'patch-regression', revision: 1, kind: 'skill-guidance', state: 'published',
  skill: 'rdk-demo', environmentFingerprint: 'env-demo', failureClass: 'execution_failure',
  sourceEventIds: [], toolSequences: [['device_exec']], reasonCode: 'published', artifactPath,
  timestamp: new Date().toISOString(),
});
let regressionRollbacks = 0;
const regressionCoordinator = new TrustedSkillExperimentCoordinator({
  workspaceDir: workspace, patchLog: regressionPatches, experimentLog: regressionExperiments,
  rollback: async () => { regressionRollbacks += 1; return true; },
  thresholds: { minSamplesPerArm: 2, wilsonZ: 0.1 },
});
assert.throws(() => new TrustedSkillExperimentCoordinator({
  workspaceDir: workspace, patchLog: regressionPatches, experimentLog: regressionExperiments,
  thresholds: { minSamplesPerArm: 0 },
}), /minSamplesPerArm/);
assert.throws(() => new TrustedSkillExperimentCoordinator({
  workspaceDir: workspace, patchLog: regressionPatches, experimentLog: regressionExperiments,
  thresholds: { maxCostRatio: Number.NaN },
}), /maxCostRatio/);
function rawOutcome(id, variant, terminalVerdict) {
  return {
    schemaVersion: 1, kind: 'outcome', id, patchId: 'patch-regression', patchRevision: 1,
    skill: 'rdk-demo', environmentFingerprint: 'env-demo', assignmentId: `assignment-${id}`,
    sessionKey: id, taskId: `task-${id}`, runId: `run-${id}`, evidenceId: `evidence-${id}`,
    variant, terminalVerdict, success: terminalVerdict === 'pass', retries: 0, toolCalls: 1,
    corrections: 0, durationMs: 10, inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.001,
    failureClasses: terminalVerdict === 'pass' ? [] : ['acceptance_failure'], safetyFailed: false,
    timestamp: new Date().toISOString(),
  };
}
await regressionExperiments.append(rawOutcome('c1', 'control', 'pass'));
await regressionExperiments.append(rawOutcome('c2', 'control', 'pass'));
await regressionExperiments.append(rawOutcome('t1', 'treatment', 'fail'));
await regressionExperiments.append(rawOutcome('t2', 'treatment', 'fail'));
const regressionDecision = await regressionCoordinator.evaluatePatch('patch-regression');
assert.equal(regressionDecision.state, 'demoted');
assert.equal(regressionDecision.reasonCode, 'credible_success_regression');
assert.equal(regressionRollbacks, 1);
console.log('trusted-skill-experiment-coordinator: assignment, isolation, metrics, activation and safety demotion ok');
