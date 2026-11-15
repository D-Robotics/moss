#!/usr/bin/env node
// Offline SDK protocol probe. Scripted outcomes prove gates, never actual learning efficacy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RsiEngine,
  RsiAssetStore,
  RSI_BASELINE,
  rsiDigest,
  rsiTaskScopeDigest,
} from '../../dist/index.js';
import { runProcess } from '../../dist/utils/run-process.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-protocol-'));
const scope = { ownerKey: 'probe-owner', environment: 'test' };
const identity = {
  projectId: 'official-project',
  repositoryRevision: 'a'.repeat(40),
  taskFamily: 'python-fix',
  taskFamilyVersion: '1',
  capabilitiesDigest: rsiDigest('tools-permissions'),
};
const runtimeConfig = {
  runnerVersion: 'probe-1',
  oracleVersion: 'probe-1',
  modelConfigDigest: rsiDigest('model-config'),
  tools: ['read_file', 'run_tests'],
  permissionsDigest: rsiDigest('permissions'),
};
let engine,
  failConfirmation = false,
  cancelConfirmation = false,
  revokeConfirmation = false,
  resultMode = 'positive',
  enabled = true;
const trustedRuns = new Set();
const provider = {
  hermit: {
    version: '0.2.0',
    commit: 'b'.repeat(40),
    method: 'gepa',
    configDigest: rsiDigest('hermit-config'),
    templateDigest: rsiDigest('template'),
  },
  model: 'scripted-offline',
  evaluatorVersion: 'business-oracle-1',
  providerIdentityDigest: rsiDigest('provider'),
  runtimeConfig,
  async verifyCandidate({ provenance }) {
    return trustedRuns.has(provenance.runId);
  },
  async confirm({ session, baseline, candidate }) {
    const persisted = engine
      .listTrainingConfirmations(scope)
      .find((item) => item.id === session.confirmationId);
    assert.equal(persisted.status, 'running', 'claim must precede callback');
    assert.equal(engine.store.read(scope).holdoutConsumptions.length > 0, true);
    if (failConfirmation) throw new Error('scripted disconnect');
    if (cancelConfirmation) {
      engine.cancelTrainingSession(scope, session.id);
      throw new Error('cancelled');
    }
    const results = [];
    for (const split of ['holdout', 'regression'])
      for (const task of session.cases[split])
        for (const repetition of [0, 1]) {
          const attempts = {};
          for (const arm of ['baseline', 'candidate']) {
            const reservation = engine.reserveTrainingCall(scope, session.id, {
              stage: 'confirmation',
              maxInputTokens: 100,
              maxOutputTokens: 20,
            });
            const usage = { inputTokens: 60, outputTokens: 10, cacheReadTokens: 20 };
            engine.settleTrainingCall(scope, session.id, reservation.id, usage);
            attempts[arm] = {
              runId: `${session.id}:${task.id}:${repetition}:${arm}`,
              adapterDigest: arm === 'baseline' ? baseline.digest : candidate.digest,
              taskScopeDigest: rsiTaskScopeDigest(session.taskScope),
              evidenceDigest: rsiDigest(`${task.id}:${arm}:${repetition}`),
              status: 'completed',
              functionalPassed: arm === 'candidate' || task.id !== session.cases.holdout[0].id,
              formatPassed: false,
              durationMs: 10,
              usage: { ...usage, modelCalls: 1 },
              toolCalls: 1,
            };
          }
          results.push({ caseId: task.id, split, repetition, ...attempts });
        }
    if (revokeConfirmation) enabled = false;
    if (resultMode === 'no-improvement')
      for (const row of results) row.baseline.functionalPassed = true;
    if (resultMode === 'format-only')
      for (const row of results) {
        row.candidate.functionalPassed = false;
        row.candidate.formatPassed = true;
      }
    if (resultMode === 'regression')
      results.find((row) => row.split === 'regression').candidate.functionalPassed = false;
    if (resultMode === 'duplicate-run') results[1].candidate.runId = results[0].candidate.runId;
    return {
      results,
      usage: { modelCalls: 32, inputTokens: 1920, outputTokens: 320, cacheReadTokens: 640 },
    };
  },
};
engine = new RsiEngine({
  rootDir: root,
  externalTraining: () => provider,
  authorize: () => {
    if (!enabled) throw new Error('revoked');
  },
});
function plan(prefix) {
  const stage = { maxModelCalls: 100, maxTokens: 10000, maxWallMs: 60000 };
  return {
    taskScope: { ...identity },
    seed: 42,
    budget: {
      totalTokens: 30000,
      training: { ...stage },
      confirmation: { ...stage },
      adoptionRollback: { ...stage },
      maxTaskModelCalls: 3,
      maxTaskToolCalls: 5,
      maxTaskWallMs: 1000,
      maxOutputTokens: 100,
    },
    cases: Object.fromEntries(
      ['training', 'validation', 'holdout', 'regression'].map((split) => [
        split,
        Array.from({ length: 4 }, (_, i) => ({
          id: `${prefix}-${split}-${i}`,
          groupDigest: rsiDigest(`${prefix}-group-${split}-${i}`),
          fixtureDigest: rsiDigest(`${prefix}-fixture-${split}-${i}`),
        })),
      ])
    ),
  };
}
async function enrolled(prefix, forged = false, taskScope = identity) {
  const session = engine.freezeTrainingSession(scope, { ...plan(prefix), taskScope });
  for (let step = 0; step < 2; step++) {
    const r = engine.reserveTrainingCall(scope, session.id, {
      stage: 'training',
      maxInputTokens: 100,
      maxOutputTokens: 20,
    });
    engine.settleTrainingCall(scope, session.id, r.id, {
      inputTokens: 60,
      outputTokens: 10,
      cacheReadTokens: 20,
    });
  }
  const instructions = `Read tests before editing ${prefix}.`;
  const provenance = {
    runId: `official-worker-${prefix}`,
    adapterCommit: 'c'.repeat(40),
    instructionsDigest: rsiDigest(instructions),
    steps: [1, 2].map((step) => ({
      step,
      adapterCommit: 'c'.repeat(40),
      instructionsDigest: rsiDigest(instructions),
    })),
    trainingUsage: { modelCalls: 2, inputTokens: 120, outputTokens: 20, cacheReadTokens: 40 },
  };
  if (!forged) trustedRuns.add(provenance.runId);
  const input = { id: `probe-${prefix}`, version: '1.0.0', instructions, provenance };
  return { session, input };
}
function rejected(action, code) {
  assert.throws(action, (error) => error.rsiCode === code, code);
}
try {
  const { session, input } = await enrolled('positive');
  // Official Trainer finalization creates a CARD commit even when instructions
  // are unchanged. Use actual Git objects, not invented intermediate hashes.
  const checkout = path.join(root, 'finalization-checkout');
  fs.mkdirSync(checkout);
  const git = async (...args) => {
    const result = await runProcess('git', { args, cwd: checkout, timeout: 10000 });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  await git('init');
  await git('config', 'user.name', 'Offline Probe');
  await git('config', 'user.email', 'probe@example.invalid');
  fs.writeFileSync(path.join(checkout, 'ADAPTER.md'), input.instructions);
  await git('add', 'ADAPTER.md');
  await git('commit', '-m', 'Two unchanged official steps use this actual adapter');
  const stepCommit = await git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(checkout, '.hermit'));
  fs.writeFileSync(path.join(checkout, '.hermit', 'CARD.md'), 'Final trainer metadata');
  await git('add', '.hermit/CARD.md');
  await git('commit', '-m', 'Finalize metadata only');
  input.provenance.adapterCommit = await git('rev-parse', 'HEAD');
  assert.notEqual(input.provenance.adapterCommit, stepCommit);
  for (const step of input.provenance.steps) {
    step.adapterCommit = stepCommit;
    await git('merge-base', '--is-ancestor', stepCommit, input.provenance.adapterCommit);
    assert.equal(await git('show', `${stepCommit}:ADAPTER.md`), input.instructions);
  }
  assert.equal(
    await git('show', `${input.provenance.adapterCommit}:ADAPTER.md`),
    input.instructions
  );
  await assert.rejects(
    engine.admitTrainingCandidate(scope, session.id, {
      ...input,
      provenance: { ...input.provenance, adapterCommit: 'invalid-final-commit' },
    }),
    { rsiCode: 'untrusted_training_provenance' }
  );
  const foreign = { ownerKey: 'another-account', environment: 'test' };
  rejected(
    () =>
      engine.reserveTrainingCall(foreign, session.id, {
        stage: 'training',
        maxInputTokens: 1,
        maxOutputTokens: 1,
      }),
    'training_session_invalid'
  );
  await assert.rejects(
    engine.admitTrainingCandidate(scope, session.id, {
      ...input,
      provenance: { ...input.provenance, runId: 'forged' },
    }),
    { rsiCode: 'untrusted_training_provenance' }
  );
  const candidate = await engine.admitTrainingCandidate(scope, session.id, input);
  await assert.rejects(engine.admitTrainingCandidate(scope, session.id, input), {
    rsiCode: 'training_champion_already_claimed',
  });
  rejected(
    () =>
      engine.promote(scope, candidate.digest, { evaluationId: 'fake', expectedPolicyVersion: 0 }),
    'external_training_protocol_required'
  );
  const confirmation = await engine.confirmTrainingCandidate(scope, session.id);
  assert.equal(confirmation.status, 'passed');
  assert.equal(confirmation.results.length, 16);
  assert.equal(
    confirmation.results.every((row) => row.candidate.formatPassed === false),
    true,
    'format does not replace functional scoring'
  );
  await assert.rejects(engine.confirmTrainingCandidate(scope, session.id), {
    rsiCode: 'confirmation_already_claimed',
  });
  rejected(() => engine.freezeTrainingSession(scope, plan('positive')), 'holdout_already_consumed');
  const promoted = engine.promoteTrainingCandidate(scope, session.id, {
    confirmationId: confirmation.id,
    expectedPolicyVersion: 0,
  });
  const expected = {
    model: provider.model,
    providerIdentityDigest: provider.providerIdentityDigest,
    taskScope: identity,
  };
  assert.equal(engine.captureAdapter(scope, expected).adapter.digest, candidate.digest);
  assert.equal(
    engine.captureAdapter(scope).adapter.digest,
    RSI_BASELINE.digest,
    'unknown task scope defaults to baseline'
  );
  for (const key of Object.keys(identity))
    assert.equal(
      engine.captureAdapter(scope, {
        ...expected,
        taskScope: {
          ...identity,
          [key]: key === 'capabilitiesDigest' ? rsiDigest('other') : 'other',
        },
      }).adapter.digest,
      RSI_BASELINE.digest
    );
  const oldPermission = provider.runtimeConfig.permissionsDigest;
  provider.runtimeConfig.permissionsDigest = rsiDigest('changed-permissions');
  assert.equal(
    engine.captureAdapter(scope, expected).adapter.digest,
    RSI_BASELINE.digest,
    'permission changes invalidate adoption'
  );
  provider.runtimeConfig.permissionsDigest = oldPermission;
  const otherIdentity = { ...identity, projectId: 'second-project' };
  const second = await enrolled('second-project', false, otherIdentity);
  const secondCandidate = await engine.admitTrainingCandidate(
    scope,
    second.session.id,
    second.input
  );
  const secondConfirmation = await engine.confirmTrainingCandidate(scope, second.session.id);
  const secondPolicy = engine.promoteTrainingCandidate(scope, second.session.id, {
    confirmationId: secondConfirmation.id,
    expectedPolicyVersion: 0,
  });
  assert.equal(
    engine.captureAdapter(scope, expected).adapter.digest,
    candidate.digest,
    'promoting another project cannot replace this project policy'
  );
  assert.equal(
    engine.captureAdapter(scope, { ...expected, taskScope: otherIdentity }).adapter.digest,
    secondCandidate.digest
  );
  engine.rollbackTrainingPolicy(scope, otherIdentity, secondPolicy.version);
  assert.equal(
    engine.captureAdapter(scope, expected).adapter.digest,
    candidate.digest,
    'rolling back another project cannot replace this project policy'
  );
  assert.equal(
    engine.captureAdapter(scope, { ...expected, taskScope: otherIdentity }).adapter.digest,
    RSI_BASELINE.digest
  );
  assert.equal(
    engine.status(scope).policy.activeDigest,
    RSI_BASELINE.digest,
    'external policies cannot mutate legacy global policy'
  );
  engine.rollbackTrainingPolicy(scope, identity, promoted.version);
  assert.equal(engine.captureAdapter(scope, expected).adapter.digest, RSI_BASELINE.digest);

  const legacy = engine.importCandidate(scope, {
    id: 'legacy',
    version: '1.0.0',
    instructions: 'legacy import',
  });
  engine.store.update(scope, (state) => {
    state.policy.activeDigest = legacy.adapter.digest;
    state.policy.version++;
  });
  assert.equal(
    engine.captureAdapter(scope, expected).adapter.digest,
    RSI_BASELINE.digest,
    'legacy import cannot bypass new scoped admission'
  );
  engine.store.update(scope, (state) => {
    state.policy.activeDigest = RSI_BASELINE.digest;
    state.policy.version++;
  });

  const unknown = engine.freezeTrainingSession(scope, plan('unknown'));
  const reservation = engine.reserveTrainingCall(scope, unknown.id, {
    stage: 'training',
    maxInputTokens: 100,
    maxOutputTokens: 20,
  });
  assert.equal(
    engine.settleTrainingCall(scope, unknown.id, reservation.id, null).status,
    'unknown'
  );
  rejected(
    () =>
      engine.reserveTrainingCall(scope, unknown.id, {
        stage: 'training',
        maxInputTokens: 1,
        maxOutputTokens: 1,
      }),
    'training_meter_blocked'
  );
  assert.equal(
    new RsiEngine({ rootDir: root }).listTrainingReservations(scope, unknown.id)[0].status,
    'unknown',
    'unknown reservations survive reload'
  );
  const priorUnknown = engine.listTrainingReservations(scope, unknown.id)[0];
  rejected(
    () =>
      engine.settleTrainingCall(scope, unknown.id, reservation.id, {
        inputTokens: 1,
        outputTokens: 1,
      }),
    'training_reservation_not_open'
  );
  assert.deepEqual(engine.listTrainingReservations(scope, unknown.id)[0], priorUnknown);

  for (const fixture of [
    {
      name: 'known-output-overrun',
      input: 8000,
      output: 4096,
      actual: { inputTokens: 5444, outputTokens: 4835 },
      reasons: ['output_tokens'],
    },
    {
      name: 'actual-exceeds-full-reserve',
      input: 100,
      output: 100,
      actual: { inputTokens: 101, outputTokens: 200 },
      reasons: ['input_tokens', 'output_tokens'],
    },
    {
      name: 'valid-usage-after-deadline',
      input: 100,
      output: 100,
      actual: { inputTokens: 1, outputTokens: 1 },
      reasons: ['stage_wall_time'],
      late: true,
    },
  ]) {
    const location = path.join(root, fixture.name);
    const metered = new RsiEngine({ rootDir: location, externalTraining: () => provider });
    const assets = new RsiAssetStore(location);
    const frozenPlan = plan(fixture.name);
    frozenPlan.budget.training.maxTokens = 40000;
    frozenPlan.budget.totalTokens = 60000;
    frozenPlan.budget.maxOutputTokens = 4096;
    const frozen = metered.freezeTrainingSession(scope, frozenPlan);
    const claim = metered.reserveTrainingCall(scope, frozen.id, {
      stage: 'training',
      maxInputTokens: fixture.input,
      maxOutputTokens: fixture.output,
    });
    if (fixture.late)
      metered.store.update(scope, (state) => {
        state.trainingReservations.find((item) => item.id === claim.id).createdAt -= 60001;
      });
    const backup = assets.backup(scope);
    const index = path.join(assets.status(scope).storageDirectory, 'state.json');
    const beforeSettlement = fs.readFileSync(index);
    const settled = metered.settleTrainingCall(scope, frozen.id, claim.id, fixture.actual);
    assert.equal(settled.status, 'unknown', 'overspend blocks further admission');
    assert.deepEqual(
      settled.usage,
      fixture.actual,
      'valid actual usage is never discarded or clamped'
    );
    assert.deepEqual(settled.budgetViolations, fixture.reasons);
    assert.equal(
      settled.maxInputTokens,
      fixture.input,
      'full reservation remains available for conservative charging'
    );
    assert.equal(settled.maxOutputTokens, fixture.output);
    rejected(
      () =>
        metered.reserveTrainingCall(scope, frozen.id, {
          stage: 'training',
          maxInputTokens: 1,
          maxOutputTokens: 1,
        }),
      'training_meter_blocked'
    );
    assert.equal(metered.store.read(scope).candidates.length, 0);
    assert.equal(metered.store.read(scope).holdoutConsumptions.length, 0);
    // Simulate interruption after signed journal commit but before index replacement.
    fs.writeFileSync(index, beforeSettlement);
    const reopened = new RsiEngine({ rootDir: location });
    assert.deepEqual(reopened.listTrainingReservations(scope, frozen.id)[0], settled);
    metered.cancelTrainingSession(scope, frozen.id);
    assets.restore(scope, backup, { expectedRevision: assets.status(scope).revision });
    assert.deepEqual(
      reopened.listTrainingReservations(scope, frozen.id)[0],
      settled,
      'old signed backup cannot refund known overrun or reopen the reservation'
    );
  }

  const exhaustedPlan = plan('exhausted');
  exhaustedPlan.budget.training.maxTokens = 120;
  const exhausted = engine.freezeTrainingSession(scope, exhaustedPlan);
  const exhaustedReservation = engine.reserveTrainingCall(scope, exhausted.id, {
    stage: 'training',
    maxInputTokens: 100,
    maxOutputTokens: 20,
  });
  rejected(
    () =>
      engine.reserveTrainingCall(scope, exhausted.id, {
        stage: 'training',
        maxInputTokens: 1,
        maxOutputTokens: 1,
      }),
    'training_budget_exhausted'
  );
  engine.settleTrainingCall(scope, exhausted.id, exhaustedReservation.id, {
    inputTokens: 60,
    outputTokens: 10,
    cacheReadTokens: 20,
  });
  engine.reserveTrainingCall(scope, exhausted.id, {
    stage: 'training',
    maxInputTokens: 40,
    maxOutputTokens: 10,
  });
  assert.equal(
    engine.listTrainingReservations(scope, exhausted.id).length,
    2,
    'cached input charged once, unused reserve released'
  );

  const baselineChanged = await enrolled('baseline-change');
  engine.store.update(scope, (state) => {
    state.trainingPolicies[rsiTaskScopeDigest(identity)].version++;
  });
  await assert.rejects(
    engine.admitTrainingCandidate(scope, baselineChanged.session.id, baselineChanged.input),
    { rsiCode: 'training_baseline_changed' }
  );

  for (const mode of ['failure', 'cancellation', 'revocation']) {
    const fixture = await enrolled(mode);
    await engine.admitTrainingCandidate(scope, fixture.session.id, fixture.input);
    failConfirmation = mode === 'failure';
    cancelConfirmation = mode === 'cancellation';
    revokeConfirmation = mode === 'revocation';
    const result = await engine.confirmTrainingCandidate(scope, fixture.session.id);
    enabled = true;
    assert.equal(result.status, 'unavailable');
    await assert.rejects(engine.confirmTrainingCandidate(scope, fixture.session.id));
    rejected(() => engine.freezeTrainingSession(scope, plan(mode)), 'holdout_already_consumed');
    rejected(
      () =>
        engine.promoteTrainingCandidate(scope, fixture.session.id, {
          confirmationId: result.id,
          expectedPolicyVersion: engine.getTrainingPolicy(scope, identity).version,
        }),
      mode === 'cancellation' ? 'training_session_cancelled' : 'passing_confirmation_required'
    );
    failConfirmation = cancelConfirmation = revokeConfirmation = false;
  }
  for (const mode of ['no-improvement', 'format-only', 'regression', 'duplicate-run']) {
    const fixture = await enrolled(mode);
    await engine.admitTrainingCandidate(scope, fixture.session.id, fixture.input);
    resultMode = mode;
    const result = await engine.confirmTrainingCandidate(scope, fixture.session.id);
    assert.equal(result.status, mode === 'duplicate-run' ? 'unavailable' : 'failed');
    rejected(
      () =>
        engine.promoteTrainingCandidate(scope, fixture.session.id, {
          confirmationId: result.id,
          expectedPolicyVersion: engine.getTrainingPolicy(scope, identity).version,
        }),
      'passing_confirmation_required'
    );
    await assert.rejects(engine.confirmTrainingCandidate(scope, fixture.session.id));
  }
  const malformed = engine.freezeTrainingSession(scope, plan('malformed-usage'));
  const malformedReservation = engine.reserveTrainingCall(scope, malformed.id, {
    stage: 'training',
    maxInputTokens: 100,
    maxOutputTokens: 20,
  });
  assert.equal(
    engine.settleTrainingCall(scope, malformed.id, malformedReservation.id, {
      inputTokens: -1,
      outputTokens: 0,
    }).status,
    'unknown'
  );
  rejected(
    () =>
      engine.reserveTrainingCall(scope, malformed.id, {
        stage: 'training',
        maxInputTokens: 1,
        maxOutputTokens: 1,
      }),
    'training_meter_blocked'
  );
  const oldLedgerPlan = plan('old-ledger');
  engine.store.update(scope, (state) =>
    state.holdoutConsumptions.push({
      digest: rsiDigest(
        JSON.stringify(['task-fixture', oldLedgerPlan.cases.holdout[0].fixtureDigest])
      ),
      at: Date.now(),
    })
  );
  rejected(() => engine.freezeTrainingSession(scope, oldLedgerPlan), 'holdout_already_consumed');
  console.log(
    'rsi-external-training: offline protocol positive path + admission/scope/permission/budget/claim/revocation negatives passed'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
