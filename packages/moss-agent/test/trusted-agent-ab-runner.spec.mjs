#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CandidatePatchLog,
  PatchExperimentLog,
  TrustedAgentAbRunner,
  TrustedSkillExperimentCoordinator,
  assignPatchExperimentVariant,
  createPatchExperimentTaskSignature,
} from '../dist/memory/index.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-agent-ab-runner-'));
const memoryDir = path.join(workspace, '.moss', 'memory');
const learnedDir = path.join(workspace, '.moss', 'skills', 'learned', 'rdk-demo-trusted-recovery');
await fs.mkdir(learnedDir, { recursive: true });
const artifactPath = path.join(learnedDir, 'SKILL.md');
await fs.writeFile(
  artifactPath,
  [
    '---',
    'name: rdk-demo-trusted-recovery',
    'description: trusted agent treatment',
    'enabled: false',
    '---',
    '',
    'AGENT_RECEIVES_THIS_LEARNED_GUIDANCE',
  ].join('\n')
);
const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
await patchLog.append({
  schemaVersion: 1,
  id: 'agent-ab-patch',
  revision: 1,
  kind: 'skill-guidance',
  state: 'published',
  skill: 'rdk-demo',
  environmentFingerprint: 'real-env',
  environmentIdentityVersion: 1,
  environmentCompleteness: 'complete',
  executionDomain: 'real',
  realEvidenceEligible: true,
  failureClass: 'execution_failure',
  sourceEventIds: ['a', 'b'],
  toolSequences: [['device_exec']],
  reasonCode: 'published',
  artifactPath,
  timestamp: new Date().toISOString(),
});
const experimentLog = new PatchExperimentLog({ baseDir: memoryDir });
const coordinator = new TrustedSkillExperimentCoordinator({
  workspaceDir: workspace,
  patchLog,
  experimentLog,
  thresholds: { minSamplesPerArm: 20 },
});

function runFor(userMessage, variant) {
  const signature = createPatchExperimentTaskSignature({
    userMessage,
    skill: 'rdk-demo',
    environmentFingerprint: 'real-env',
  });
  for (let index = 0; index < 10_000; index += 1) {
    const runId = `${variant}-${index}`;
    if (
      assignPatchExperimentVariant({
        patchId: 'agent-ab-patch',
        runId,
        taskSignature: signature,
        environmentFingerprint: 'real-env',
      }) === variant
    )
      return runId;
  }
  throw new Error(`no ${variant} run`);
}

const messages = ['inspect board temperature safely', 'inspect board architecture safely'];
const tasks = [
  {
    id: 'control-task',
    sessionKey: 'control-session',
    runId: runFor(messages[0], 'control'),
    userMessage: messages[0],
    skill: 'rdk-demo',
    environmentFingerprint: 'real-env',
    executionDomain: 'real',
    realEvidenceEligible: true,
  },
  {
    id: 'treatment-task',
    sessionKey: 'treatment-session',
    runId: runFor(messages[1], 'treatment'),
    userMessage: messages[1],
    skill: 'rdk-demo',
    environmentFingerprint: 'real-env',
    executionDomain: 'real',
    realEvidenceEligible: true,
  },
];
let executions = 0;
const runner = new TrustedAgentAbRunner({
  coordinator,
  experimentLog,
  buildBaseDigest: async () => 'BASE_AGENT_CONTEXT',
  loadTrustedObservation: async () => 'TRUSTED_OBSERVATION',
  executeAgentTask: async ({ task, memoryContext, variant, exposureId }) => {
    executions += 1;
    assert.ok(exposureId);
    if (variant === 'treatment')
      assert.match(memoryContext, /AGENT_RECEIVES_THIS_LEARNED_GUIDANCE/);
    else
      assert.doesNotMatch(
        memoryContext,
        /AGENT_RECEIVES_THIS_LEARNED_GUIDANCE|TRUSTED_OBSERVATION/
      );
    const evidenceId = `evidence-${task.id}`;
    const timestamp = new Date().toISOString();
    return {
      terminalEntry: {
        schemaVersion: 2,
        id: `terminal-${task.id}`,
        taskId: task.id,
        runId: task.runId,
        turn: 1,
        attemptId: `${task.id}:${task.runId}:1`,
        evidenceId,
        skill: 'rdk-demo',
        skills: ['rdk-demo'],
        attribution: 'single-skill',
        environmentFingerprint: 'real-env',
        environmentIdentityVersion: 1,
        environmentCompleteness: 'complete',
        executionDomain: 'real',
        realEvidenceEligible: true,
        verdict: 'pass',
        reason: 'objective-pass',
        sessionKey: task.sessionKey,
        timestamp,
      },
      experiences: [
        {
          schemaVersion: 2,
          id: `experience-${task.id}`,
          sessionKey: task.sessionKey,
          taskId: task.id,
          runId: task.runId,
          evidenceId,
          toolCallId: evidenceId,
          attemptId: `${task.runId}:${evidenceId}`,
          contractSkill: 'rdk-demo',
          environmentFingerprint: 'real-env',
          environmentIdentityVersion: 1,
          environmentCompleteness: 'complete',
          executionDomain: 'real',
          realEvidenceEligible: true,
          tool: 'device_exec',
          input: {},
          reportedIsError: false,
          verdict: 'pass',
          reasonCode: 'exit_zero',
          signalSource: 'exit_code',
          confidence: 'high',
          durationMs: 1,
          timestamp,
        },
      ],
    };
  },
});

const first = await runner.run(tasks);
assert.equal(first.executed, 2);
assert.equal(first.control, 1);
assert.equal(first.treatment, 1);
assert.equal(first.excluded, 0);
assert.equal(executions, 2);
const second = await runner.run(tasks);
assert.equal(second.resumed, 2);
assert.equal(executions, 2, 'resume does not execute Agent tasks again');
assert.equal(
  (await experimentLog.readAll()).filter((entry) => entry.kind === 'exposure').length,
  2
);

await assert.rejects(
  () =>
    runner.run([
      { ...tasks[0], id: 'one' },
      { ...tasks[0], id: 'two' },
    ]),
  /duplicate_ab_task_message/
);
await fs.rm(workspace, { recursive: true, force: true });
console.log('trusted-agent-ab-runner: real context exposure, arm isolation and resume audit ok');
