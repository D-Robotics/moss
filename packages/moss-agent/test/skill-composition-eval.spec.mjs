#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildSkillCompositionEvalReport,
  buildSkillCompositionShadowComparison,
  collectSkillCompositionEvalSample,
  evaluateSkillCompositionPromotion,
} from '../dist/eval/index.js';

const collected = collectSkillCompositionEvalSample(
  {
    events: [
      {
        type: 'skill_composition',
        subtype: 'active',
        trace: {
          provider: 'rules',
          candidateScores: [
            { stableId: 'skill:auto', score: 0.9, reasonCodes: ['trigger'] },
            { stableId: 'skill:manual', score: 0.2, reasonCodes: ['tfidf'] },
          ],
          finalOrder: ['skill:auto'],
          finalNames: ['auto'],
          cardinality: 1,
          rejected: false,
          latencyMs: 7,
          injectedChars: 400,
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'load-1',
              name: 'load_skill',
              input: { name: 'skill:manual' },
            },
          ],
        },
      },
    ],
    downstreamPassed: true,
  },
  {
    id: 'collector-separation',
    expectedSkillIds: ['skill:auto'],
    language: 'en',
    taskClass: 'single',
    environment: 'host',
  }
);
assert.deepEqual(collected.composedSkillIds, ['skill:auto']);
assert.deepEqual(collected.explicitLoadSkillIds, ['skill:manual']);
assert.equal(
  buildSkillCompositionEvalReport([collected]).overall.setF1,
  1,
  'manual load does not alter automatic composition scoring'
);
assert.throws(
  () =>
    collectSkillCompositionEvalSample(
      { events: [] },
      {
        id: 'missing-trace',
        expectedSkillIds: [],
      }
    ),
  /No active skill_composition event/
);

const nameBased = collectSkillCompositionEvalSample(
  {
    events: [
      {
        type: 'skill_composition',
        subtype: 'active',
        trace: {
          provider: 'rules',
          candidateScores: [
            { stableId: 'workspace:auto', name: 'auto', score: 1, reasonCodes: [] },
          ],
          finalOrder: ['workspace:auto'],
          finalNames: ['auto'],
          cardinality: 1,
          rejected: false,
        },
      },
    ],
  },
  {
    id: 'name-based-existing-harness',
    expectedSkillNames: ['auto'],
  }
);
assert.deepEqual(nameBased.expectedSkillIds, ['auto']);
assert.deepEqual(nameBased.composedSkillIds, ['auto']);

const samples = [
  {
    id: 'zh-board-multi',
    provider: 'rules',
    expectedSkillIds: ['rdk:board', 'rdk:device'],
    composedSkillIds: ['rdk:board', 'rdk:device'],
    candidateSkillIds: ['rdk:board', 'rdk:device', 'builtin:planning'],
    explicitLoadSkillIds: [],
    dependencyViolations: 0,
    latencyMs: 8,
    injectedChars: 800,
    downstreamPassed: true,
    language: 'zh',
    deploymentMode: 'board',
    skillSource: 'bundled-rdk',
    taskClass: 'multi',
    environment: 'board',
  },
  {
    id: 'en-reject',
    provider: 'rules',
    expectedSkillIds: [],
    composedSkillIds: [],
    candidateSkillIds: [],
    explicitLoadSkillIds: ['manual:help'],
    latencyMs: 2,
    injectedChars: 0,
    downstreamPassed: true,
    language: 'en',
    deploymentMode: 'host',
    skillSource: 'workspace',
    taskClass: 'none',
    environment: 'host',
  },
];

const report = buildSkillCompositionEvalReport(samples, [
  'provider',
  'language',
  'deploymentMode',
  'skillSource',
  'taskClass',
  'environment',
]);
assert.equal(report.overall.setF1, 1);
assert.equal(report.overall.setExactMatch, 1);
assert.equal(report.overall.recallAt5, 1);
assert.equal(report.overall.mrr, 1);
assert.equal(report.overall.ndcgAt5, 1);
assert.equal(report.overall.cardinalityError, 0);
assert.equal(report.overall.dependencyViolationRate, 0);
assert.equal(report.overall.rejectionAccuracy, 1);
assert.equal(report.overall.averageLatencyMs, 5);
assert.equal(report.overall.injectedTokenEstimate, 200);
assert.equal(report.overall.downstreamPassRate, 1);
assert.equal(report.overall.manualLoadCount, 1, 'manual loads are reported separately');
assert.equal(report.segments.language.zh.sampleCount, 1);
assert.equal(report.segments.environment.board.sampleCount, 1);

const comparison = buildSkillCompositionShadowComparison(
  samples,
  samples.map((sample) => ({
    ...sample,
    provider: 'remote-model',
    latencyMs: (sample.latencyMs ?? 0) + 10,
  }))
);
assert.equal(comparison.delta.setF1, 0);
assert.equal(comparison.delta.averageLatencyMs, 10);
assert.throws(
  () => buildSkillCompositionShadowComparison(samples, samples.slice(0, 1)),
  /same case IDs/
);

const review = evaluateSkillCompositionPromotion(report.overall, {
  minimumSetF1: 0.95,
  minimumRejectionAccuracy: 0.99,
  minimumDownstreamPassRate: 0.95,
  maximumAverageLatencyMs: 20,
  maximumDependencyViolationRate: 0,
});
assert.equal(review.eligibleForReview, true);
assert.equal(review.requiresExplicitApproval, true, 'passing gates never auto-promotes a provider');

console.error('skill-composition-eval: plan scoring, segmentation, and manual review gates ✓');
