#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillRegistry } from '../dist/skills/registry.js';
import { ContractRegistry } from '../dist/acceptance/contract-registry.js';
import { evaluatePredicate } from '../dist/acceptance/predicate-evaluator.js';
import { CrossSignalLog, hasIndependentCrossSignal } from '../dist/acceptance/cross-signal-log.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import { wrapWithTerminalArbitration } from '../dist/core/tools/terminal-arbitration-gate.js';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { TrustedPatchCoordinator } from '../dist/memory/trusted-patch-coordinator.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evolution-boundaries-'));

// First production evidence write creates its memory directory.
const freshExperienceLog = new ExperienceLog({ baseDir: path.join(tmp, 'fresh', 'memory') });
await freshExperienceLog.append({
  schemaVersion: 2, id: 'fresh', tool: 'exec', input: {}, reportedIsError: false, verdict: 'pass',
  reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', durationMs: 1,
  timestamp: new Date().toISOString(), sessionKey: 'fresh', executionDomain: 'local', realEvidenceEligible: false,
});
assert.equal((await freshExperienceLog.readAll()).length, 1);

// Priority operational Skills expose real machine contracts.
const registry = ContractRegistry.fromSkills(new SkillRegistry({ workspaceDir: process.cwd() }).list());
for (const skill of ['rdk-capture-photo', 'rdk-isp-tuning', 'rdk-hardware', 'rdk-command-manual']) {
  assert.ok(registry.findBySkill(skill), `${skill} contract must load through the production registry`);
}
assert.equal(registry.findByTool('device_exec', { command: 'ffmpeg -i frame.yuv /tmp/photo.jpg -y' })?.skillName, 'rdk-capture-photo');

// Capture hard predicates distinguish a real JPEG from an arbitrary non-empty file.
const jpegPath = path.join(tmp, 'photo.jpg');
await fs.writeFile(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const predicateInput = { result: '', reportedIsError: false, input: {}, workspaceDir: tmp, deviceExecutor: null };
assert.equal((await evaluatePredicate({ name: 'file_nonempty', params: { path: jpegPath } }, predicateInput)).verdict, 'pass');
assert.equal((await evaluatePredicate({ name: 'image_decodable', params: { path: jpegPath } }, predicateInput)).verdict, 'pass');
await fs.writeFile(jpegPath, 'not an image');
assert.equal((await evaluatePredicate({ name: 'image_decodable', params: { path: jpegPath } }, predicateInput)).verdict, 'fail');

// Multi-Skill failure and recovery credit only the uniquely owned step.
await fs.mkdir(path.join(tmp, 'multi'), { recursive: true });
const experienceLog = new ExperienceLog({ baseDir: path.join(tmp, 'multi') });
const terminalLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'multi') });
const plan = {
  id: 'multi-plan', goal: 'multi', status: 'executing', version: 1, currentStep: 1,
  steps: [
    { step: 1, description: 'first', status: 'executing', expectedAccept: ['skill-a'] },
    { step: 2, description: 'second', status: 'pending', expectedAccept: ['skill-b'] },
  ],
  terminalAccept: [{ name: 'exit_code_zero', params: {} }], createdAt: '', updatedAt: '',
};
const appendExperience = (runId, evidenceId, verdict) => experienceLog.append({
  schemaVersion: 2, id: `exp-${evidenceId}`, sessionKey: 'multi-session', taskId: plan.id, runId,
  stepId: `${plan.id}:step:1`, evidenceId, toolCallId: evidenceId, attemptId: `${runId}:${evidenceId}`,
  contractSkill: 'skill-a', contractVersion: '1', environmentFingerprint: 'local-env',
  executionDomain: 'local', realEvidenceEligible: false,
  tool: 'exec', input: {}, reportedIsError: verdict === 'fail', verdict,
  ...(verdict === 'fail' ? { reasonCode: 'nonzero_exit' } : { reasonCode: 'exit_zero' }),
  signalSource: 'exit_code', confidence: 'medium', durationMs: 1, timestamp: new Date().toISOString(),
});
const gate = wrapWithTerminalArbitration(async () => ({ ok: true }), {
  experienceLog, terminalVerdictLog: terminalLog, planProvider: { get: () => plan },
  workspaceDir: tmp, deviceExecutor: { current: null },
});
await appendExperience('run-recovery', 'failed-evidence', 'fail');
assert.equal((await gate({
  sessionKey: 'multi-session', runId: 'run-recovery', turn: 1, response: '', messages: [], totalToolCalls: 1,
  toolCallsByName: { exec: 1 }, executionEvidence: { source: 'exec', toolUseId: 'failed-evidence', exitCode: 1, stdout: '', stderr: '' },
})).ok, false);
let entries = await terminalLog.readAll();
assert.equal(entries.at(-1).attribution, 'single-owner-step');
assert.equal(entries.at(-1).skill, 'skill-a');
assert.deepEqual(entries.at(-1).attributedStepIds, ['multi-plan:step:1']);

await appendExperience('run-recovery', 'recovered-evidence', 'pass');
assert.equal((await gate({
  sessionKey: 'multi-session', runId: 'run-recovery', turn: 2, response: '', messages: [], totalToolCalls: 2,
  toolCallsByName: { exec: 2 }, executionEvidence: { source: 'exec', toolUseId: 'recovered-evidence', exitCode: 0, stdout: '', stderr: '' },
})).ok, true);
entries = await terminalLog.readAll();
assert.equal(entries.at(-1).attribution, 'single-owner-step');
assert.equal(entries.at(-1).skill, 'skill-a');

await appendExperience('run-whole-pass', 'whole-pass-evidence', 'pass');
await gate({
  sessionKey: 'multi-session', runId: 'run-whole-pass', turn: 1, response: '', messages: [], totalToolCalls: 1,
  toolCallsByName: { exec: 1 }, executionEvidence: { source: 'exec', toolUseId: 'whole-pass-evidence', exitCode: 0, stdout: '', stderr: '' },
});
entries = await terminalLog.readAll();
assert.equal(entries.at(-1).attribution, 'multi-skill');
assert.equal(entries.at(-1).skill, 'unknown');

// Device simulation recovery is auditable but cannot publish a device patch.
const eventLog = new LearningEventLog({ baseDir: path.join(tmp, 'simulation') });
const patchLog = new CandidatePatchLog({ baseDir: path.join(tmp, 'simulation') });
const patchCoordinator = new TrustedPatchCoordinator({ workspaceDir: tmp, eventLog, patchLog, minRecoveryProofs: 1 });
const simulatedRecovery = {
  schemaVersion: 1, id: 'sim-recovery', sessionKey: 'sim', taskId: 'sim-task', runId: 'sim-run', turn: 2,
  planVersion: 1, skill: 'rdk-demo', skills: ['rdk-demo'], attribution: 'single-skill',
  environmentFingerprint: 'sim-env', environmentIdentityVersion: 1, environmentCompleteness: 'complete',
  executionDomain: 'simulation', realEvidenceEligible: false, outcome: 'recovered', failureClass: 'execution_failure',
  evidenceId: 'sim-evidence', experienceIds: ['sim-exp'], previousFailureId: 'sim-fail', reasonCode: 'simulated',
  toolSequence: ['device_exec'], timestamp: new Date().toISOString(),
};
await eventLog.append(simulatedRecovery);
assert.equal(await patchCoordinator.observeLearningEvent(simulatedRecovery), null);
assert.deepEqual(await patchLog.readAll(), []);

// Cross-signal requires distinct source groups linked to the same eligible real sample.
const eligibleTerminal = {
  schemaVersion: 2, id: 'terminal-real', taskId: 'real-task', runId: 'real-run', attemptId: 'real-attempt',
  evidenceId: 'real-evidence', skill: 'rdk-model-zoo', skills: ['rdk-model-zoo'], attribution: 'single-skill',
  environmentFingerprint: 'real-env', environmentIdentityVersion: 1, environmentCompleteness: 'complete',
  executionDomain: 'real', realEvidenceEligible: true, verdict: 'pass', reason: 'ok', sessionKey: 'real',
  timestamp: new Date().toISOString(),
};
const signal = (id, channel, sourceDigest) => ({
  schemaVersion: 1, id, skill: 'rdk-model-zoo', taskId: 'real-task', runId: 'real-run', evidenceId: 'real-evidence',
  environmentFingerprint: 'real-env', executionDomain: 'real', realEvidenceEligible: true,
  channel, sourceDigest, verdict: 'pass', reasonCode: 'ok', timestamp: new Date().toISOString(),
});
assert.equal(await hasIndependentCrossSignal({
  skill: 'rdk-model-zoo', terminalEntries: [eligibleTerminal],
  crossSignals: [signal('stdout', 'execution-stdout', 'sha256:stdout'), signal('exit', 'process-exit', 'sha256:exit')],
}), false, 'two parsers in the execution group are not independent');
assert.equal(await hasIndependentCrossSignal({
  skill: 'rdk-model-zoo', terminalEntries: [eligibleTerminal],
  crossSignals: [signal('stdout', 'execution-stdout', 'sha256:stdout'), signal('artifact', 'artifact-mime', 'sha256:artifact')],
}), true);

// Log is append-only and idempotent by observation id.
const crossLog = new CrossSignalLog({ baseDir: path.join(tmp, 'cross') });
await crossLog.appendMany([signal('artifact', 'artifact-mime', 'sha256:artifact')]);
await crossLog.appendMany([signal('artifact', 'artifact-mime', 'sha256:artifact')]);
assert.equal((await crossLog.readAll()).length, 1);

await fs.rm(tmp, { recursive: true, force: true });
console.log('self-evolution-boundaries: contracts, sim2real, multi-Skill attribution and cross-signal isolation ok');
