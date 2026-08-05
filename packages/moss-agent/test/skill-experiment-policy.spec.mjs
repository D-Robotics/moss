import assert from 'node:assert/strict';
import {
  canonicalSkillExperimentJson,
  DEFAULT_SKILL_EXPERIMENT_THRESHOLDS,
  evaluateSkillExperimentWindow,
  resolveEffectiveSkillPolicy,
  skillExperimentDecisionKey,
  stableSkillRolloutBucket,
} from '../dist/skill-learning/skill-experiment-policy.js';

const start = '2026-01-01T00:00:00.000Z';
const end = '2026-01-09T00:00:00.000Z';

{
  const fixture = { z: 1, 'ä': 2, a: 3, A: { b: 4, B: 5 } };
  assert.equal(canonicalSkillExperimentJson(fixture), '{"A":{"B":5,"b":4},"a":3,"z":1,"ä":2}');
  assert.equal(
    skillExperimentDecisionKey(fixture),
    '52335b9e38daa6eb734cc09e7e490034a15349a6d02b18a426a8a4a114fd6432',
    'decision keys must remain stable across runtimes and locales',
  );
}

function observations(variant, count, passes, options = {}) {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1,
    experimentKey: 'exp-1',
    environmentFingerprint: 'env-1',
    runId: `${variant}-${index}`,
    variant,
    attribution: 'single-skill',
    evidenceBacked: true,
    verdict: index < passes ? 'passed' : 'failed',
    occurredAt: '2026-01-05T00:00:00.000Z',
    retryCount: options.retryCount ?? 1,
    durationMs: options.durationMs ?? 100,
    totalTokens: options.totalTokens ?? 100,
    toolCallCount: options.toolCallCount ?? 2,
    ...(index === count - 1 && options.failureSignature
      ? { failureSignature: options.failureSignature }
      : {}),
  }));
}

function windowWith(items, extra = {}) {
  return {
    experimentKey: 'exp-1',
    skillId: 'skill-1',
    environmentFingerprint: 'env-1',
    windowStartedAt: start,
    windowEndedAt: end,
    currentRolloutPercent: 5,
    observations: items,
    ...extra,
  };
}

{
  const input = windowWith([
    ...observations('control', 100, 70),
    ...observations('treatment', 100, 90),
  ]);
  const first = evaluateSkillExperimentWindow(input);
  const second = evaluateSkillExperimentWindow({ ...input, observations: [...input.observations] });
  assert.equal(first.decision, 'promote');
  assert.equal(first.recommendedRolloutPercent, 25);
  assert.equal(first.reasonCode, 'promotion_gates_passed');
  assert.deepEqual(second, first, 'frozen input must produce a deterministic decision');
}

{
  const result = evaluateSkillExperimentWindow(
    windowWith([
      ...observations('control', 100, 70),
      ...observations('treatment', 100, 90, { totalTokens: 200 }),
    ]),
  );
  assert.equal(result.decision, 'hold');
  assert.equal(result.reasonCode, 'cost_regression');
  assert.deepEqual(result.costRegressions, ['total_tokens']);
}

{
  const result = evaluateSkillExperimentWindow(
    windowWith([
      ...observations('control', 100, 90),
      ...observations('treatment', 100, 60),
    ]),
  );
  assert.equal(result.decision, 'rollback');
  assert.equal(result.reasonCode, 'significant_outcome_harm');
}

{
  const result = evaluateSkillExperimentWindow(
    windowWith(
      [
        ...observations('control', 100, 70),
        ...observations('treatment', 100, 90, { failureSignature: 'critical-device-write' }),
      ],
      {
        thresholds: {
          ...DEFAULT_SKILL_EXPERIMENT_THRESHOLDS,
          criticalFailureSignatures: ['critical-device-write'],
        },
      },
    ),
  );
  assert.equal(result.decision, 'rollback');
  assert.equal(result.reasonCode, 'critical_treatment_failure');
}

{
  const base = observations('control', 10, 8);
  const invalid = [
    { ...base[0], runId: 'legacy', schemaVersion: 0 },
    { ...base[1], runId: 'multi', attribution: 'multi-skill' },
    { ...base[2], runId: 'unknown', environmentFingerprint: 'unknown' },
    { ...base[3], runId: 'claim', evidenceBacked: false },
    { ...base[4], runId: 'inconclusive', verdict: 'inconclusive' },
    { ...base[5] },
    { ...base[6], runId: 'wrong-environment', environmentFingerprint: 'env-2' },
    { ...base[7], runId: 'late', occurredAt: '2026-01-10T00:00:00.000Z' },
  ];
  const result = evaluateSkillExperimentWindow(windowWith([...base, ...invalid]));
  assert.equal(result.decision, 'hold');
  assert.equal(result.reasonCode, 'insufficient_evidence');
  assert.equal(result.exclusions.wrongSchema, 1);
  assert.equal(result.exclusions.nonSingleSkill, 1);
  assert.equal(result.exclusions.unknownEnvironment, 1);
  assert.equal(result.exclusions.notEvidenceBacked, 1);
  assert.equal(result.exclusions.inconclusive, 1);
  assert.equal(result.exclusions.duplicateRun, 1);
  assert.equal(result.exclusions.wrongEnvironment, 1);
  assert.equal(result.exclusions.outsideWindow, 1);
}

{
  const result = evaluateSkillExperimentWindow(windowWith([
    ...observations('control', 100, 70),
    ...observations('treatment', 100, 90),
  ], { currentRolloutPercent: 25 }));
  assert.equal(result.recommendedRolloutPercent, 50, 'promotion advances exactly one configured stage');
}

{
  const bucket = stableSkillRolloutBucket('exp-1', 'account-1');
  const atFive = bucket < 5;
  const atTwentyFive = bucket < 25;
  assert.equal(atFive && !atTwentyFive, false, 'rollout expansion must be monotonic');
  assert.deepEqual(
    resolveEffectiveSkillPolicy({ policy: null, stableSubjectKey: 'account-1', localEligible: true }),
    { allowed: true, reason: 'local_ineligible' },
  );
  assert.equal(
    resolveEffectiveSkillPolicy({
      policy: {
        schemaVersion: 1,
        skillId: 'skill-1',
        experimentKey: 'exp-1',
        environmentFingerprint: 'env-1',
        status: 'promoted',
        rolloutPercent: 100,
        policyVersion: 1,
        decisionKey: 'decision-1',
        updatedAt: end,
      },
      stableSubjectKey: 'account-1',
      globalKillSwitch: true,
    }).allowed,
    false,
  );
  assert.equal(
    resolveEffectiveSkillPolicy({
      policy: null,
      stableSubjectKey: 'account-1',
      centralPolicyRequired: true,
    }).allowed,
    false,
  );
  for (const status of ['paused', 'rolled_back']) {
    assert.deepEqual(
      resolveEffectiveSkillPolicy({
        policy: {
          schemaVersion: 1,
          skillId: 'skill-1',
          experimentKey: 'exp-1',
          environmentFingerprint: 'env-1',
          status,
          rolloutPercent: 100,
          policyVersion: 1,
          decisionKey: 'decision-1',
          updatedAt: end,
        },
        stableSubjectKey: 'account-1',
      }),
      { allowed: false, reason: 'central_disabled' },
    );
  }
}

console.log('[PASS] skill experiment evaluator and rollout policy');
