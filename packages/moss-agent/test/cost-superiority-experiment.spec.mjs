#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { PatchExperimentLog } from '../dist/memory/patch-experiment-log.js';
import { TrustedSkillExperimentCoordinator } from '../dist/memory/trusted-skill-experiment-coordinator.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-cost-ab-'));
const memory = path.join(workspace, '.moss', 'memory');
const patchLog = new CandidatePatchLog({ baseDir: memory });
const experimentLog = new PatchExperimentLog({ baseDir: memory });
await patchLog.append({
  schemaVersion: 1, id: 'patch-cost', revision: 1, kind: 'skill-guidance', state: 'published', skill: 'demo',
  environmentFingerprint: 'env', failureClass: 'execution_failure', sourceEventIds: [], toolSequences: [['exec']],
  reasonCode: 'published', timestamp: new Date().toISOString(),
});
const hypothesis = 'success_noninferiority_cost_superiority';
for (const variant of ['control', 'treatment']) {
  for (let i = 0; i < 20; i += 1) {
    const runId = `${variant}-${i}`;
    await experimentLog.append({
      schemaVersion: 1, kind: 'assignment', id: `assign-${runId}`, patchId: 'patch-cost', patchRevision: 1,
      skill: 'demo', environmentFingerprint: 'env', sessionKey: runId, runId, taskSignature: 'sig', variant,
      exposed: variant === 'treatment', exposureId: `exposure-${runId}`, hypothesis, experimentConfigHash: 'sha256:frozen',
      timestamp: new Date().toISOString(),
    });
    await experimentLog.append({
      schemaVersion: 1, kind: 'outcome', id: `outcome-${runId}`, patchId: 'patch-cost', patchRevision: 1,
      skill: 'demo', environmentFingerprint: 'env', assignmentId: `assign-${runId}`, sessionKey: runId,
      taskId: `task-${runId}`, runId, evidenceId: `evidence-${runId}`, variant, terminalVerdict: 'pass', success: true,
      retries: variant === 'control' ? 2 : 0, toolCalls: variant === 'control' ? 12 : 6,
      corrections: variant === 'control' ? 2 : 0, durationMs: variant === 'control' ? 2000 : 1000,
      inputTokens: variant === 'control' ? 2000 : 1000, outputTokens: 100, failureClasses: [], safetyFailed: false,
      eligible: true, timestamp: new Date().toISOString(),
    });
  }
}
const coordinator = new TrustedSkillExperimentCoordinator({
  workspaceDir: workspace, patchLog, experimentLog, hypothesis,
  thresholds: { minSamplesPerArm: 20, successNoninferiorityMargin: 0.05, minCostImprovementRatio: 0.1, minCostMetricsImproved: 2 },
});
const decision = await coordinator.evaluatePatch('patch-cost');
assert.equal(decision.state, 'active');
assert.equal(decision.reasonCode, 'credible_cost_benefit_under_success_noninferiority');
assert.deepEqual(decision.improvedCostMetrics, ['retries', 'toolCalls', 'durationMs', 'tokens']);
await experimentLog.append({
  schemaVersion: 1, kind: 'assignment', id: 'assign-mutated-config', patchId: 'patch-cost', patchRevision: 1,
  skill: 'demo', environmentFingerprint: 'env', sessionKey: 'mutated', runId: 'mutated', taskSignature: 'sig',
  variant: 'control', exposed: false, exposureId: 'exposure-mutated', hypothesis,
  experimentConfigHash: 'sha256:changed-after-outcomes', timestamp: new Date().toISOString(),
});
const frozen = await coordinator.evaluatePatch('patch-cost');
assert.equal(frozen.state, 'shadow');
assert.equal(frozen.reasonCode, 'experiment_configuration_changed');
await fs.rm(workspace, { recursive: true, force: true });
console.log('cost-superiority experiment: noninferior success plus frozen multi-metric benefit activates');
