#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runDeliveryEvidenceLab,
  validateDeliveryEvidenceManifest,
} from '../lib/delivery-evidence-lab.mjs';

const scenarioIds = [
  'small-bug',
  'ambiguous-cross-module-feature',
  'restart-recovery',
  'four-node-parallel-implementation',
  'reviewer-injected-integration-defect',
  'acceptance-revision',
  'external-workspace-conflict',
];
const manifest = {
  commit: 'test-commit',
  repeats: 5,
  runner: ['moss-evidence-runner'],
  scenarios: scenarioIds.map((id) => ({
    id,
    task: `${id} task`,
    environment: 'fixture-v1',
    model: 'same-model',
    budget: { tokens: 1000, wallTimeMs: 5000 },
  })),
};

test('delivery evidence lab enforces seven locked scenarios and five paired runs', async () => {
  const report = await runDeliveryEvidenceLab(manifest, {
    execute: async ({ scenario, variant, run }) => ({
      success: true,
      tokens: 100,
      costUsd: 0.01,
      retryCount: 0,
      humanInterventions: 0,
      recoverySuccess: scenario.id === 'restart-recovery',
      reviewerDefects: variant === 'treatment' ? 1 : 0,
      wallTimeMs: run,
      stdoutDigest: 'fixture',
      stderrDigest: 'fixture',
    }),
  });
  assert.equal(report.runs.length, 70);
  assert.equal(report.runs.filter((run) => run.variant === 'control').length, 35);
  assert.equal(report.runs.filter((run) => run.variant === 'treatment').length, 35);
  assert.equal(new Set(report.runs.map((run) => run.model)).size, 1);
});

test('delivery evidence lab rejects fewer than five runs', () => {
  assert.throws(() => validateDeliveryEvidenceManifest({ ...manifest, repeats: 4 }), /five runs/);
});
