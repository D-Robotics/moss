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
const event = (id, taskId, runId) => ({
  schemaVersion: 1, id, sessionKey: `session-${id}`, taskId, runId, turn: 2, planVersion: 1,
  skill: 'rdk-model-zoo', skills: ['rdk-model-zoo'], attribution: 'single-skill',
  environmentFingerprint: 'sha256:x5', environmentIdentityVersion: 1,
  environmentCompleteness: 'complete', executionDomain: 'real', realEvidenceEligible: true,
  outcome: 'recovered', failureClass: 'execution_failure',
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

const third = event('recover-3', 'task-3', 'run-3');
third.toolSequence = Array.from({ length: 20 }, () => 'device_exec');
await eventLog.append(third);
const frozen = await coordinator.observeLearningEvent(third);
assert.equal(frozen.state, 'published', 'new recovery cannot mutate the revision under A/B');
assert.equal(frozen.revision, published.revision);

const states = (await patchLog.readAll()).filter((record) => record.id === published.id).map((record) => record.state);
assert.deepEqual(states, ['proposed', 'proposed', 'validated', 'published']);
assert.equal(await coordinator.rollback(published.id), true);
assert.equal((await patchLog.latest(published.id))[0].state, 'rolled_back');
await assert.rejects(() => fs.access(published.artifactPath));

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
