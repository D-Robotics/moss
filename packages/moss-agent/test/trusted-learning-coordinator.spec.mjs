#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../dist/memory/memory-manager.js';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import {
  TrustedLearningCoordinator,
  recallTrustedLearningObservations,
} from '../dist/memory/trusted-learning-coordinator.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-trusted-learning-'));
const memoryManager = new MemoryManager(dir);
await memoryManager.load();
const eventLog = new LearningEventLog({ baseDir: dir });
const coordinator = new TrustedLearningCoordinator({ eventLog, memoryManager });
const environment = 'sha256:test-environment';
const plan = {
  id: 'task-1',
  goal: 'deploy',
  status: 'completed',
  version: 2,
  steps: [{ step: 1, description: 'run', status: 'completed', expectedAccept: ['rdk-model-zoo'] }],
  createdAt: '',
  updatedAt: '',
  terminalAccept: [{ name: 'stdout_matches', params: { pattern: 'OK' } }],
};
const terminal = (overrides = {}) => ({
  schemaVersion: 2,
  id: 'terminal-1',
  taskId: plan.id,
  runId: 'run-1',
  turn: 1,
  planVersion: 2,
  attemptId: 'task-1:run-1:1',
  evidenceId: 'evidence-1',
  skill: 'rdk-model-zoo',
  skills: ['rdk-model-zoo'],
  attribution: 'single-skill',
  environmentFingerprint: environment,
  verdict: 'fail',
  reason: 'terminal predicate failed',
  sessionKey: 'session-1',
  timestamp: '2026-07-31T00:00:00.000Z',
  ...overrides,
});
const experience = (overrides = {}) => ({
  schemaVersion: 2,
  id: 'experience-1',
  sessionKey: 'session-1',
  taskId: plan.id,
  runId: 'run-1',
  toolCallId: 'evidence-1',
  evidenceId: 'evidence-1',
  tool: 'device_exec',
  input: {},
  reportedIsError: true,
  verdict: 'fail',
  reasonCode: 'nonzero_exit',
  signalSource: 'exit_code',
  confidence: 'medium',
  durationMs: 3,
  timestamp: '2026-07-31T00:00:00.000Z',
  contractSkill: 'rdk-model-zoo',
  environmentFingerprint: environment,
  ...overrides,
});

const failed = await coordinator.observe({
  plan,
  terminalEntry: terminal(),
  terminalReasonCode: 'nonzero_exit',
  arbitration: {
    auditFailed: false,
    suspectSkills: [],
    reason: '',
    singleStepPassRate: 0,
    driftFromTerminal: 0,
  },
  experiences: [experience()],
});
assert.equal(failed.outcome, 'failed');
assert.equal(failed.failureClass, 'execution_failure');
assert.deepEqual(failed.experienceIds, ['experience-1']);

const duplicate = await coordinator.observe({
  plan,
  terminalEntry: terminal(),
  terminalReasonCode: 'nonzero_exit',
  arbitration: {
    auditFailed: false,
    suspectSkills: [],
    reason: '',
    singleStepPassRate: 0,
    driftFromTerminal: 0,
  },
  experiences: [experience()],
});
assert.equal(duplicate, null, 'same terminal evidence is idempotent');

const recovered = await coordinator.observe({
  plan,
  terminalEntry: terminal({
    id: 'terminal-2',
    turn: 2,
    attemptId: 'task-1:run-1:2',
    evidenceId: 'evidence-2',
    verdict: 'pass',
  }),
  arbitration: {
    auditFailed: false,
    suspectSkills: [],
    reason: '',
    singleStepPassRate: 1,
    driftFromTerminal: 0,
  },
  experiences: [
    experience({
      id: 'experience-2',
      toolCallId: 'evidence-2',
      evidenceId: 'evidence-2',
      reportedIsError: false,
      verdict: 'pass',
      reasonCode: 'exit_zero',
    }),
  ],
});
assert.equal(recovered.outcome, 'recovered');
assert.equal(recovered.previousFailureId, failed.id);
assert.equal(recovered.failureClass, 'execution_failure');

const recalled = await recallTrustedLearningObservations(memoryManager, {
  skill: 'rdk-model-zoo',
  environmentFingerprint: environment,
});
assert.match(recalled, /Recovered with fresh objective evidence/);
assert.match(recalled, /device_exec/);
assert.equal(
  await recallTrustedLearningObservations(memoryManager, {
    skill: 'rdk-model-zoo',
    environmentFingerprint: 'sha256:other',
  }),
  '',
  'cross-environment observations are not recalled'
);
assert.equal(
  await recallTrustedLearningObservations(memoryManager, {
    skill: 'other-skill',
    environmentFingerprint: environment,
  }),
  '',
  'other Skills are not recalled'
);
assert.equal(
  await recallTrustedLearningObservations(memoryManager, {
    skill: 'rdk-model-zoo',
    environmentFingerprint: 'unknown',
  }),
  '',
  'unknown environments are never recalled'
);

const legacyIgnored = await coordinator.observe({
  plan,
  terminalEntry: terminal({ id: 'legacy-backed', turn: 3, evidenceId: 'legacy-evidence' }),
  arbitration: {
    auditFailed: false,
    suspectSkills: [],
    reason: '',
    singleStepPassRate: 0,
    driftFromTerminal: 0,
  },
  experiences: [{ ...experience(), schemaVersion: undefined, id: 'legacy-experience' }],
});
assert.equal(legacyIgnored, null, 'v1 Experience cannot create trusted learning');

const drift = await coordinator.observe({
  plan: { ...plan, id: 'task-drift' },
  terminalEntry: terminal({
    id: 'drift',
    taskId: 'task-drift',
    runId: 'run-drift',
    evidenceId: 'drift-evidence',
  }),
  arbitration: {
    auditFailed: true,
    suspectSkills: ['rdk-model-zoo'],
    reason: '',
    singleStepPassRate: 1,
    driftFromTerminal: 1,
  },
  experiences: [
    experience({
      id: 'drift-exp',
      taskId: 'task-drift',
      runId: 'run-drift',
      evidenceId: 'drift-evidence',
      toolCallId: 'drift-evidence',
      verdict: 'pass',
      reportedIsError: false,
      reasonCode: 'exit_zero',
    }),
  ],
});
assert.equal(drift.failureClass, 'contract_drift');

const unknown = await coordinator.observe({
  plan: { ...plan, id: 'task-unknown' },
  terminalEntry: terminal({
    id: 'unknown',
    taskId: 'task-unknown',
    runId: 'run-unknown',
    evidenceId: 'unknown-evidence',
    verdict: 'unknown',
  }),
  arbitration: {
    auditFailed: false,
    suspectSkills: [],
    reason: '',
    singleStepPassRate: 1,
    driftFromTerminal: 0.5,
  },
  experiences: [
    experience({
      id: 'unknown-exp',
      taskId: 'task-unknown',
      runId: 'run-unknown',
      evidenceId: 'unknown-evidence',
      toolCallId: 'unknown-evidence',
      verdict: 'unknown',
      reportedIsError: false,
      reasonCode: 'no_hard_signal',
    }),
  ],
});
assert.equal(unknown.outcome, 'unknown');
assert.equal(unknown.failureClass, 'insufficient_evidence');

const multi = await coordinator.observe({
  plan: { ...plan, id: 'task-multi' },
  terminalEntry: terminal({
    id: 'multi',
    taskId: 'task-multi',
    runId: 'run-multi',
    evidenceId: 'multi-evidence',
    skill: 'unknown',
    skills: ['rdk-model-zoo', 'rdk-device'],
    attribution: 'multi-skill',
  }),
  arbitration: {
    auditFailed: false,
    suspectSkills: [],
    reason: '',
    singleStepPassRate: 0,
    driftFromTerminal: 0,
  },
  experiences: [
    experience({
      id: 'multi-exp',
      taskId: 'task-multi',
      runId: 'run-multi',
      evidenceId: 'multi-evidence',
      toolCallId: 'multi-evidence',
    }),
  ],
});
assert.equal(multi.skill, undefined, 'multi-Skill learning remains task-level');
assert.equal(multi.attribution, 'multi-skill');

const events = await eventLog.readAll();
assert.equal(
  events.length,
  5,
  'trusted events are append-only; duplicate and legacy inputs are excluded'
);
const observations = (await memoryManager.getAll()).filter(
  (entry) => entry.trust === 'observation'
);
assert.equal(
  observations.length,
  3,
  'single-Skill, drift and task-level multi-Skill topics stay separate; unknown is audit-only'
);
assert.ok(observations.some((entry) => entry.topic?.startsWith('learning:v2:task-task-multi:')));

await fs.rm(dir, { recursive: true, force: true });
console.log(
  'trusted-learning-coordinator: classification, idempotency, recovery and targeted recall ok'
);
