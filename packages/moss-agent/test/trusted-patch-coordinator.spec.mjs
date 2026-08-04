#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { TrustedPatchCoordinator } from '../dist/memory/trusted-patch-coordinator.js';
import { RecoveryRecipeLog } from '../dist/memory/recovery-recipe-log.js';
import { SkillRegistry } from '../dist/skills/registry.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-trusted-patch-'));
const memoryDir = path.join(workspace, '.moss', 'memory');
const eventLog = new LearningEventLog({ baseDir: memoryDir });
const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
const recipeLog = new RecoveryRecipeLog({ baseDir: memoryDir });
const coordinator = new TrustedPatchCoordinator({ workspaceDir: workspace, eventLog, patchLog, recipeLog, minRecoveryProofs: 2 });
assert.throws(
  () => new TrustedPatchCoordinator({ workspaceDir: workspace, eventLog, patchLog, recipeLog, minRecoveryProofs: 0 }),
  /minRecoveryProofs/,
);
const event = (id, taskId, runId) => ({
  schemaVersion: 1, id, sessionKey: `session-${id}`, taskId, runId, turn: 2, planVersion: 1,
  skill: 'rdk-capture-photo', skills: ['rdk-capture-photo'], attribution: 'single-skill',
  environmentFingerprint: 'sha256:x5', environmentIdentityVersion: 1,
  environmentCompleteness: 'complete', executionDomain: 'real', realEvidenceEligible: true,
  outcome: 'recovered', failureClass: 'execution_failure',
  evidenceId: `evidence-${id}`, experienceIds: [`experience-${id}`], previousFailureId: `failure-${id}`,
  reasonCode: 'exit_zero', toolSequence: ['exec', 'exec'], recoveryRecipeId: 'recipe-camera', timestamp: new Date().toISOString(),
});
const recipe = (revision, sources, taskRuns, experiences) => ({
  schemaVersion: 1, id: 'recipe-camera', revision, state: 'candidate', skill: 'rdk-capture-photo',
  environmentSelector: { fingerprint: 'sha256:x5', boardFamily: 'rdk-x5' },
  failureSignature: { failureClass: 'execution_failure', reasonCodes: ['nonzero_exit'] },
  preconditions: [{ name: 'process_running', params: { pattern: 'isp' } }],
  steps: [
    { tool: 'exec', operation: 'inspect_output_target_type', arguments: { path: '${artifactPath}' }, expectedEvidence: [{ name: 'stdout_matches', params: { pattern: 'missing|regular|empty-directory' } }] },
    { tool: 'exec', operation: 'remove_exact_empty_output_collision', arguments: { path: '${artifactPath}', requireEmptyDirectory: true }, expectedEvidence: [{ name: 'exit_code_zero', params: {} }] },
    { tool: 'exec', operation: 'convert_to_unique_staging_jpeg', arguments: { input: '${sourceYuv}', output: '${stagingArtifactPath}', width: '${width}', height: '${height}' }, expectedEvidence: [{ name: 'image_decodable', params: { path: '${stagingArtifactPath}' } }] },
    { tool: 'exec', operation: 'promote_validated_artifact', arguments: { source: '${stagingArtifactPath}', output: '${artifactPath}' }, expectedEvidence: [{ name: 'file_nonempty', params: { path: '${artifactPath}' } }] },
  ],
  executionMode: 'single-bounded-transaction',
  terminalAccept: [{ name: 'image_content_nontrivial', params: { path: '${artifactPath}', minVariation: 2 } }],
  safetyConstraints: [], bindings: { sourceYuv: 'path', stagingArtifactPath: 'path', artifactPath: 'path', width: 'integer', height: 'integer' },
  verifiedBindings: { sensorIndex: 50, width: 1920, height: 1080, frameBytes: 3110400 },
  invariants: ['output-target-type', 'bounded-empty-collision-cleanup', 'unique-staging-output', 'validate-before-promote'], sourceEventIds: sources,
  sourceTaskRunIds: taskRuns, sourceExperienceIds: experiences, independentRecoveryCount: taskRuns.length,
  qualityReason: taskRuns.length >= 2 ? 'quality_passed' : 'insufficient_independent_evidence', timestamp: new Date().toISOString(),
});

const first = event('recover-1', 'task-1', 'run-1');
await eventLog.append(first);
await recipeLog.append(recipe(1, [first.id], ['task-1:run-1'], first.experienceIds));
const proposed = await coordinator.observeLearningEvent(first);
assert.equal(proposed.state, 'proposed');
assert.equal((await patchLog.latest())[0].state, 'proposed');

const second = event('recover-2', 'task-2', 'run-2');
await eventLog.append(second);
await recipeLog.append(recipe(2, [first.id, second.id], ['task-1:run-1', 'task-2:run-2'], [...first.experienceIds, ...second.experienceIds]));
const validated = await coordinator.observeLearningEvent(second);
assert.equal(validated.state, 'validated');
assert.equal(validated.reasonCode, 'awaiting_held_out_shadow_replay');
const published = await coordinator.observeShadowReplay({
  recipeId: 'recipe-camera', taskId: 'task-shadow', runId: 'run-shadow', evidenceIds: ['shadow-evidence'], verdict: 'pass',
});
assert.equal(published.state, 'published');
assert.ok(published.artifactPath);
const body = await fs.readFile(published.artifactPath, 'utf8');
assert.match(body, /Treat this as execution guidance, not as proof of success/);
assert.match(body, /inspect_output_target_type/);
assert.match(body, /supersede the base Skill parameter-discovery steps/);
assert.match(body, /do not repeat discovery probes/);
assert.match(body, /capabilities, not extra requirements/);
assert.match(body, /single-bounded-transaction/);
assert.match(body, /do not manually repeat terminal probes/);
assert.doesNotMatch(body, /stdout|password|192\.168/);
const learned = new SkillRegistry({ workspaceDir: workspace, includeBuiltin: false, includeBundledRdkSkills: false }).list();
assert.ok(learned.some((skill) => skill.name === 'rdk-capture-photo-trusted-recovery'), 'published artifact is a loadable learned Skill');

const third = event('recover-3', 'task-3', 'run-3');
third.toolSequence = Array.from({ length: 20 }, () => 'device_exec');
await eventLog.append(third);
const frozen = await coordinator.observeLearningEvent(third);
assert.equal(frozen.state, 'published', 'new recovery cannot mutate the revision under A/B');
assert.equal(frozen.revision, published.revision);

const states = (await patchLog.readAll()).filter((record) => record.id === published.id).map((record) => record.state);
assert.deepEqual(states, ['proposed', 'proposed', 'validated', 'published']);
const artifactDir = path.dirname(published.artifactPath);
const unrelatedPath = path.join(artifactDir, 'operator-notes.txt');
await fs.writeFile(unrelatedPath, 'must survive rollback');
assert.equal(await coordinator.rollback(published.id), true);
assert.equal((await patchLog.latest(published.id))[0].state, 'rolled_back');
await assert.rejects(() => fs.access(published.artifactPath));
await assert.rejects(() => fs.access(path.join(artifactDir, 'TRUSTED-PATCH.json')));
assert.equal(await fs.readFile(unrelatedPath, 'utf8'), 'must survive rollback');

const learnedRoot = path.dirname(artifactDir);
const legacyDir = path.join(learnedRoot, 'legacy-backup');
const legacyArtifact = path.join(legacyDir, 'SKILL.md');
const legacyBackup = path.join(legacyDir, 'SKILL.backup.1700000000000.md');
await fs.mkdir(legacyDir, { recursive: true });
await fs.writeFile(legacyArtifact, 'new guidance');
await fs.writeFile(legacyBackup, 'old guidance');
await patchLog.append({
  ...published, id: 'patch_legacy_backup', revision: 1, state: 'published',
  artifactPath: legacyArtifact, backupPath: legacyBackup,
});
assert.equal(await coordinator.rollback('patch_legacy_backup'), true, 'pre-hardening backups remain restorable');
assert.equal(await fs.readFile(legacyArtifact, 'utf8'), 'old guidance');

await patchLog.append({
  ...published, id: 'patch_untrusted_backup', revision: 1, state: 'published',
  artifactPath: legacyArtifact, backupPath: path.join(legacyDir, 'operator-notes.txt'),
});
assert.equal(await coordinator.rollback('patch_untrusted_backup'), false, 'arbitrary same-directory files are not backups');

const drift = {
  ...event('drift-1', 'task-drift', 'run-drift'), outcome: 'failed', failureClass: 'contract_drift',
};
await eventLog.append(drift);
const review = await coordinator.observeLearningEvent(drift);
assert.equal(review.kind, 'contract-review');
assert.equal(review.state, 'proposed');
assert.equal(review.reasonCode, 'contract_requires_independent_review');

await fs.rm(workspace, { recursive: true, force: true });
console.log('trusted-patch-coordinator: propose, validate, publish, load and rollback ok');
