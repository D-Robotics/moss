import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { RsiEngine, RSI_BASELINE, hashHarnessAdapter, rsiProtocolDigest } from '../dist/index.js';

const roots = [];
const scope = { ownerKey: 'protocol-operator', environment: 'test' };
const budget = { maxModelCalls: 18, maxOutputTokens: 256 };
const criterion = { kind: 'efficiency', metric: 'toolCalls', minimumAbsoluteGain: 1 };
const runtimeConfig = {
  runnerVersion: 'board-runner:1',
  oracleVersion: 'board-oracle:1',
  modelConfigDigest: 'a'.repeat(64),
  tools: ['device_file_read', 'device_exec'],
  permissionsDigest: 'b'.repeat(64),
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(extra = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-protocol-'));
  roots.push(rootDir);
  let proposals = 0;
  let evaluations = 0;
  const artifact = {
    id: 'learned-board-strategy',
    version: '1.0.0',
    instructions: 'Batch independent reads and verify the requested result.',
  };
  const learner = {
    model: 'fixed',
    evaluatorVersion: 'board-verifier:1',
    identityDigest: 'model-and-endpoint-identity',
    async propose({ cases }) {
      proposals++;
      assert.ok(cases.length > 0 && cases.every((c) => c.split === 'training'));
      return { ...artifact, digest: hashHarnessAdapter(artifact) };
    },
    async evaluate({ cases, criterion: gate }) {
      evaluations++;
      return {
        model: this.model,
        evaluatorVersion: this.evaluatorVersion,
        results: cases.map((c) => ({
          caseId: c.id,
          split: c.split,
          baselinePassed: gate.kind === 'efficiency' || c.split !== 'holdout',
          candidatePassed: true,
          baselineMetrics: { toolCalls: 3 },
          candidateMetrics: { toolCalls: 1 },
          reason: 'independent_oracle',
        })),
        spend: { modelCalls: 6 },
      };
    },
    ...extra,
  };
  const engine = new RsiEngine({ rootDir, learning: learner });
  const cases = ['training', 'validation', 'holdout'].map((split, i) =>
    engine.enrollTaskCase(scope, {
      sourceKey: `synthetic-${split}`,
      input: 'Read the referenced project files and return their verified summary.',
      expectedOutcome: 'independent-oracle',
      split,
      fixtureDigest: String(i + 1).repeat(64),
      oracleVersion: 'board-oracle:1',
    })
  );
  const planInput = { caseIds: cases.map((c) => c.id), budget, criterion, runtimeConfig };
  const freeze = () => engine.freezeProtocol(scope, planInput);
  const propose = (protocol, overrides = {}) =>
    engine.propose(scope, {
      caseIds: [cases[0].id],
      budget,
      protocolId: protocol.id,
      runtimeConfig,
      ...overrides,
    });
  const evaluate = (candidate, protocol, overrides = {}) =>
    engine.evaluate(scope, candidate.adapter.digest, {
      ...planInput,
      protocolId: protocol.id,
      ...overrides,
    });
  const promote = (candidate, evaluation, protocol, overrides = {}) =>
    engine.promote(scope, candidate.adapter.digest, {
      evaluationId: evaluation.id,
      expectedPolicyVersion: 0,
      protocolId: protocol.id,
      runtimeConfig,
      ...overrides,
    });
  return {
    engine,
    rootDir,
    cases,
    learner,
    artifact,
    planInput,
    freeze,
    propose,
    evaluate,
    promote,
    counts: () => ({ proposals, evaluations }),
  };
}

test('a persisted pre-generation protocol binds the native policy lifecycle without disclosing heldout cases', async () => {
  const f = fixture();
  const protocol = f.freeze();
  assert.deepEqual(f.counts(), { proposals: 0, evaluations: 0 });
  assert.equal(protocol.digest, rsiProtocolDigest(protocol));
  assert.equal(protocol.perArmBudget.maxModelCalls, 3);
  assert.deepEqual(protocol.validationIdentity, {
    model: 'fixed',
    evaluatorVersion: 'board-verifier:1',
    providerIdentityDigest: 'model-and-endpoint-identity',
  });
  assert.ok(Object.isFrozen(protocol.runtimeConfig.tools));
  assert.throws(() => protocol.runtimeConfig.tools.push('device_file_write'), TypeError);
  const projection = f.engine.listProtocols(scope);
  projection[0].budget.maxModelCalls = 64;
  assert.equal(f.engine.listProtocols(scope)[0].budget.maxModelCalls, budget.maxModelCalls);
  const candidate = await f.propose(protocol);
  assert.equal(candidate.protocolId, protocol.id);
  assert.equal(candidate.protocolDigest, protocol.digest);
  assert.deepEqual(candidate.caseIds, [f.cases[0].id]);
  const evaluation = await f.evaluate(candidate, protocol);
  assert.equal(evaluation.status, 'passed');
  assert.equal(evaluation.protocolId, protocol.id);
  assert.equal(evaluation.protocolDigest, protocol.digest);
  assert.throws(
    () => f.promote(candidate, evaluation, protocol, { protocolId: undefined }),
    /candidate_protocol_mismatch/
  );
  const selected = f.promote(candidate, evaluation, protocol);
  assert.equal(selected.activeDigest, candidate.adapter.digest);
  assert.equal(f.engine.listCandidates(scope)[0].validation.protocolDigest, protocol.digest);
  assert.equal(f.engine.captureAdapter(scope).harnessAdapter.sha256, candidate.adapter.digest);
  assert.equal(f.engine.rollback(scope, 1).activeDigest, RSI_BASELINE.digest);
});

test('bound evaluation rejects missing or changed protocol, runtime, cases, criterion and budget before spending holdout', async () => {
  const f = fixture(),
    protocol = f.freeze(),
    candidate = await f.propose(protocol);
  const changes = [
    { protocolId: undefined },
    { protocolId: 'another-plan' },
    { runtimeConfig: undefined },
    ...Object.entries({
      runnerVersion: 'runner:2',
      oracleVersion: 'oracle:2',
      modelConfigDigest: 'c'.repeat(64),
      tools: [...runtimeConfig.tools].reverse(),
      permissionsDigest: 'd'.repeat(64),
    }).map(([key, value]) => ({ runtimeConfig: { ...runtimeConfig, [key]: value } })),
    { budget: { ...budget, maxModelCalls: 17 } },
    { budget: { ...budget, maxOutputTokens: 512 } },
    { criterion: { kind: 'correctness' } },
    { criterion: { ...criterion, minimumAbsoluteGain: 2 } },
    { caseIds: [...f.planInput.caseIds].reverse() },
  ];
  for (const change of changes) {
    await assert.rejects(f.evaluate(candidate, protocol, change), /protocol/);
    assert.equal(f.engine.listEvaluations(scope).length, 0);
    assert.equal(
      f.engine.listCases(scope).find((c) => c.split === 'holdout').holdoutConsumed,
      false
    );
  }
  assert.equal(f.counts().evaluations, 0);
  assert.equal((await f.evaluate(candidate, protocol)).status, 'passed');
  await assert.rejects(f.evaluate(candidate, protocol), /holdout_already_consumed/);
});

test('all frozen training cases are required and invalid proposal declarations leave the proposal unclaimed', async () => {
  const f = fixture();
  const secondTraining = f.engine.enrollTaskCase(scope, {
    sourceKey: 'second-training',
    input: 'Inspect another training project.',
    expectedOutcome: 'independent-oracle',
    split: 'training',
    fixtureDigest: '4'.repeat(64),
    oracleVersion: 'board-oracle:1',
  });
  f.planInput.caseIds.splice(1, 0, secondTraining.id);
  const protocol = f.freeze();
  const trainingIds = [f.cases[0].id, secondTraining.id];
  for (const change of [
    { caseIds: [f.cases[0].id] },
    { caseIds: f.planInput.caseIds },
    { caseIds: [f.cases[1].id] },
    { caseIds: trainingIds, budget: { ...budget, maxModelCalls: 17 } },
    { caseIds: trainingIds, runtimeConfig: { ...runtimeConfig, tools: ['device_file_read'] } },
  ])
    await assert.rejects(f.propose(protocol, change), /protocol|training_cases_required/);
  assert.equal(f.counts().proposals, 0);
  assert.deepEqual(f.engine.store.read(scope).protocolProposals, []);
  await f.propose(protocol, { caseIds: trainingIds });
  await assert.rejects(f.propose(protocol, { caseIds: trainingIds }), /protocol_proposal_consumed/);
  assert.equal(f.counts().proposals, 1);
});

test('a proposal is claimed before awaiting the model and stays consumed after an upstream failure and restart', async () => {
  let release;
  let calls = 0;
  const f = fixture({
    async propose() {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
      throw new Error('upstream unavailable');
    },
  });
  const protocol = f.freeze();
  const first = f.propose(protocol);
  await assert.rejects(f.propose(protocol), /protocol_proposal_consumed/);
  release();
  await assert.rejects(first, /upstream unavailable/);
  f.engine.setLearningProvider(f.learner);
  const restarted = new RsiEngine({ rootDir: f.rootDir, learning: f.learner });
  await assert.rejects(
    restarted.propose(scope, {
      caseIds: [f.cases[0].id],
      budget,
      protocolId: protocol.id,
      runtimeConfig,
    }),
    /protocol_proposal_consumed/
  );
  assert.equal(calls, 1);
  assert.equal(f.engine.listCandidates(scope).length, 0);
});

test('model, verifier and endpoint identity drift prevents bound generation, evaluation and promotion', async () => {
  for (const key of ['model', 'evaluatorVersion', 'identityDigest']) {
    const f = fixture(),
      protocol = f.freeze();
    const original = f.learner[key];
    f.learner[key] = 'changed';
    await assert.rejects(f.propose(protocol), /protocol_validation_changed/);
    assert.equal(f.counts().proposals, 0);
    f.learner[key] = original;
    const candidate = await f.propose(protocol);
    f.learner[key] = 'changed';
    await assert.rejects(f.evaluate(candidate, protocol), /protocol_validation_changed/);
    assert.equal(f.counts().evaluations, 0);
    f.learner[key] = original;
    const evaluation = await f.evaluate(candidate, protocol);
    f.learner[key] = 'changed';
    assert.throws(() => f.promote(candidate, evaluation, protocol), /protocol_validation_changed/);
    assert.equal(f.engine.status(scope).policy.version, 0);
  }
});

test('provider identity is rechecked after async generation and async evaluation', async () => {
  const f = fixture({
    async propose() {
      f.engine.setLearningProvider({ ...f.learner, identityDigest: 'changed-endpoint' });
      return { ...f.artifact, digest: hashHarnessAdapter(f.artifact) };
    },
  });
  const protocol = f.freeze();
  await assert.rejects(f.propose(protocol), /protocol_validation_changed/);
  assert.equal(f.engine.listCandidates(scope).length, 0);
  const g = fixture(),
    other = g.freeze(),
    candidate = await g.propose(other);
  const evaluate = g.learner.evaluate;
  g.learner.evaluate = async function (input) {
    const result = await evaluate.call(this, input);
    g.engine.setLearningProvider({ ...g.learner, identityDigest: 'changed-endpoint' });
    return result;
  };
  const evaluation = await g.evaluate(candidate, other);
  assert.equal(evaluation.status, 'unavailable');
  assert.equal(evaluation.errorCode, 'protocol_validation_changed');
  assert.equal(g.engine.status(scope).policy.version, 0);
});

test('case and protocol edits cannot launder a preregistered result into promotion', async () => {
  for (const phase of ['before-propose', 'before-evaluate']) {
    const f = fixture(),
      protocol = f.freeze();
    const candidate = phase === 'before-evaluate' ? await f.propose(protocol) : undefined;
    f.engine.store.update(scope, (state) => {
      state.cases[0].expectedOutcome = 'changed-label';
    });
    await assert.rejects(
      candidate ? f.evaluate(candidate, protocol) : f.propose(protocol),
      /protocol_cases_changed/
    );
  }
  const f = fixture(),
    protocol = f.freeze();
  f.engine.store.update(scope, (state) => {
    state.protocols[0].budget.maxModelCalls = 64;
  });
  await assert.rejects(f.propose(protocol), /protocol_integrity_failed/);
  for (const edit of [
    (evaluation) => {
      evaluation.protocolDigest = 'f'.repeat(64);
    },
    (evaluation) => {
      evaluation.protocolId = 'another-plan';
    },
    (evaluation) => {
      evaluation.budget.maxModelCalls = 17;
    },
    (evaluation) => {
      evaluation.criterion.minimumAbsoluteGain = 2;
    },
    (evaluation) => {
      evaluation.caseDigests.reverse();
    },
  ]) {
    const g = fixture(),
      plan = g.freeze(),
      candidate = await g.propose(plan),
      evaluation = await g.evaluate(candidate, plan);
    g.engine.store.update(scope, (state) => {
      edit(state.evaluations[0]);
    });
    assert.throws(() => g.promote(candidate, evaluation, plan), /protocol/);
    assert.equal(g.engine.status(scope).policy.version, 0);
  }
});

test('legacy schema-2 evidence remains unbound and cannot be relabelled as a protocol-generated candidate', async () => {
  const f = fixture();
  const stateFile = path.join(f.rootDir, fs.readdirSync(f.rootDir)[0], 'state.json');
  const oldState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete oldState.protocols;
  delete oldState.protocolProposals;
  fs.writeFileSync(stateFile, JSON.stringify(oldState));
  assert.deepEqual(f.engine.listProtocols(scope), []);
  const legacy = f.engine.importCandidate(scope, f.artifact);
  const protocol = f.freeze();
  await assert.rejects(f.evaluate(legacy, protocol), /candidate_protocol_mismatch/);
  await assert.rejects(f.propose(protocol), /candidate_protocol_conflict/);
  const evaluated = await f.engine.evaluate(scope, legacy.adapter.digest, f.planInput);
  assert.equal(evaluated.status, 'passed');
  assert.equal(evaluated.protocolId, undefined);
  assert.equal(evaluated.protocolDigest, undefined);
  f.engine.promote(scope, legacy.adapter.digest, {
    evaluationId: evaluated.id,
    expectedPolicyVersion: 0,
  });
  assert.equal(f.engine.listCandidates(scope)[0].validation.protocolId, undefined);
});

test('protocol freezing refuses incomplete or consumed evidence and invalid trusted runtime declarations', async () => {
  const f = fixture();
  assert.throws(
    () => f.engine.freezeProtocol(scope, { ...f.planInput, caseIds: [f.cases[0].id] }),
    /nonoverlapping_splits_required/
  );
  assert.throws(
    () =>
      f.engine.freezeProtocol(scope, { ...f.planInput, budget: { ...budget, maxModelCalls: 5 } }),
    /learning_budget_insufficient/
  );
  for (const declared of [
    undefined,
    { ...runtimeConfig, tools: ['exec', 'exec'] },
    { ...runtimeConfig, modelConfigDigest: 'unfrozen' },
    { ...runtimeConfig, arbitraryOracleCode: 'ignored?' },
  ]) {
    assert.throws(
      () => f.engine.freezeProtocol(scope, { ...f.planInput, runtimeConfig: declared }),
      /invalid_protocol_runtime/
    );
  }
  const legacy = f.engine.importCandidate(scope, f.artifact);
  await f.engine.evaluate(scope, legacy.adapter.digest, f.planInput);
  assert.throws(f.freeze, /holdout_already_consumed/);
  const denied = new RsiEngine({
    rootDir: f.rootDir,
    authorize() {
      throw new Error('not admitted');
    },
  });
  assert.throws(() => denied.listProtocols(scope), /not admitted/);
  assert.throws(() => denied.freezeProtocol(scope, f.planInput), /not admitted/);
});
