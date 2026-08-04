#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { TrustedPatchCoordinator } from '../dist/memory/trusted-patch-coordinator.js';
import { SkillRegistry } from '../dist/skills/registry.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-trusted-patch-'));
const memoryDir = path.join(workspace, '.moss', 'memory');
const eventLog = new LearningEventLog({ baseDir: memoryDir });
const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
const coordinator = new TrustedPatchCoordinator({ workspaceDir: workspace, eventLog, patchLog, minRecoveryProofs: 2 });
assert.throws(
  () => new TrustedPatchCoordinator({ workspaceDir: workspace, eventLog, patchLog, minRecoveryProofs: 0 }),
  /minRecoveryProofs/,
);
const event = (id, taskId, runId) => ({
  schemaVersion: 1, id, sessionKey: `session-${id}`, taskId, runId, turn: 2, planVersion: 1,
  skill: 'rdk-model-zoo', skills: ['rdk-model-zoo'], attribution: 'single-skill',
  environmentFingerprint: 'sha256:x5', outcome: 'recovered', failureClass: 'execution_failure',
  evidenceId: `evidence-${id}`, experienceIds: [`experience-${id}`], previousFailureId: `failure-${id}`,
  reasonCode: 'exit_zero', toolSequence: ['device_exec', 'device_file_read'], timestamp: new Date().toISOString(),
});

const first = event('recover-1', 'task-1', 'run-1');
await eventLog.append(first);
const proposed = await coordinator.observeLearningEvent(first);
assert.equal(proposed.state, 'proposed');
assert.equal((await patchLog.latest())[0].state, 'proposed');

const second = event('recover-2', 'task-2', 'run-2');
await eventLog.append(second);
const published = await coordinator.observeLearningEvent(second);
assert.equal(published.state, 'published');
assert.ok(published.artifactPath);
const body = await fs.readFile(published.artifactPath, 'utf8');
assert.match(body, /Treat this as execution guidance, not as proof of success/);
assert.match(body, /`device_exec` → `device_file_read`/);
assert.doesNotMatch(body, /stdout|password|192\.168/);
const learned = new SkillRegistry({ workspaceDir: workspace, includeBuiltin: false, includeBundledRdkSkills: false }).list();
assert.ok(learned.some((skill) => skill.name === 'rdk-model-zoo-trusted-recovery'), 'published artifact is a loadable learned Skill');

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
