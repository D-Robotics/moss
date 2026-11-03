import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  RsiEngine,
  RsiError,
  MossError,
  RSI_BASELINE,
  createRsiLearningProvider,
  createRsiTaskEvaluator,
  rsiProviderIdentityDigest,
  MossAgent,
  InMemorySessionStore,
} from '../dist/index.js';

const roots = [];
const scope = { ownerKey: 'operator:a', environment: 'test' };
const budget = { maxModelCalls: 18, maxOutputTokens: 256 };
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function provider(mode = 'gain', extra = {}) {
  return {
    model: 'fixed',
    evaluatorVersion: 'task.v1',
    identityDigest: 'endpoint',
    async propose() {
      throw new Error('Not used');
    },
    async evaluate({ cases }) {
      return {
        model: this.model,
        evaluatorVersion: this.evaluatorVersion,
        results: cases.map((c) => ({
          caseId: c.id,
          split: c.split,
          baselinePassed: mode !== 'gain' || c.split !== 'holdout',
          candidatePassed: true,
          baselineMetrics: { toolCalls: 3 },
          candidateMetrics: { toolCalls: mode === 'tie' ? 3 : 1 },
          reason: 'verified',
        })),
        spend: { modelCalls: 6 },
      };
    },
    ...extra,
  };
}
function engine(extra = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-engine-'));
  roots.push(rootDir);
  return new RsiEngine({ rootDir, learning: provider(), ...extra });
}
function observation(target, runId, selected = target.captureAdapter(scope)) {
  const observer = target.createRunObserver({ scope, runId, adapter: selected, model: 'fixed' });
  assert.ok(observer);
  observer.onEvent({
    type: 'turn_start',
    turn: 1,
    ...(selected.harnessAdapter
      ? {
          harnessAdapter: {
            id: selected.harnessAdapter.id,
            version: selected.harnessAdapter.version,
            sha256: selected.harnessAdapter.sha256,
          },
        }
      : {}),
  });
  observer.onEvent({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'device_file_read',
    args: { password: 'private-args' },
  });
  observer.onEvent({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'device_file_read',
    result: 'private-result',
    isError: true,
  });
  observer.onEvent({ type: 'thinking_delta', delta: 'private-thought' });
  observer.finish('error');
  return target.getRun(scope, runId);
}
function cases(target, suffix = '') {
  return ['training', 'validation', 'holdout'].map((split, index) => {
    const runId = `fixture-${suffix}-${index}`;
    observation(target, runId);
    return target.enrollCase(scope, {
      runId,
      input: `Task ${index}`,
      expectedOutcome: 'task_oracle_passed',
      split,
    });
  });
}
function candidate(target, version = '1.0.0') {
  return target.importCandidate(scope, {
    id: 'recovery',
    version,
    instructions: 'Use observed evidence and batch independent read-only probes when relevant.',
  });
}
function evaluate(target, value, selected, criterion) {
  return target.evaluate(scope, value.adapter.digest, {
    caseIds: selected.map((c) => c.id),
    budget,
    criterion,
  });
}

test('RSI remains optional, scoped, guarded, and records metadata only after native admission', () => {
  const target = engine();
  assert.equal(fs.readdirSync(target.store.rootDir).length, 0);
  assert.equal(target.status(scope).activeAdapter.applicationMode, 'baseline');
  const silent = target.createRunObserver({
    scope,
    runId: 'not-executed',
    adapter: target.captureAdapter(scope),
  });
  silent.onEvent({ type: 'thinking_delta', delta: 'never-persist' });
  silent.finish('completed');
  assert.deepEqual(target.listRuns(scope), []);
  const run = observation(target, 'actual-fixture');
  assert.equal(run.toolCalls, 1);
  assert.equal(run.toolFailures, 1);
  assert.equal(JSON.stringify(run).includes('private-'), false);
  assert.deepEqual(target.listRuns({ ...scope, ownerKey: 'operator:b' }), []);
  assert.deepEqual(target.listRuns({ ...scope, environment: 'development' }), []);
  const denied = engine({
    authorize() {
      throw new RsiError('host_denied', 403);
    },
  });
  assert.throws(
    () => denied.listCases(scope),
    (error) => error instanceof MossError && error.rsiCode === 'host_denied'
  );
  assert.equal(denied.captureAdapter(scope), null);
  assert.equal(
    denied.status(scope).policy.version,
    0,
    'a host may still project a disabled status'
  );
});

test('a correctness tie and a training-only gain cannot pass, including forged passed status', async () => {
  for (const mode of ['tie', 'training-only']) {
    const target = engine({
      learning: provider(
        mode,
        mode === 'training-only'
          ? {
              async evaluate({ cases }) {
                return {
                  model: this.model,
                  evaluatorVersion: this.evaluatorVersion,
                  results: cases.map((c) => ({
                    caseId: c.id,
                    split: c.split,
                    baselinePassed: c.split !== 'training',
                    candidatePassed: true,
                    reason: 'test',
                  })),
                };
              },
            }
          : {}
      ),
    });
    const selected = cases(target),
      value = candidate(target);
    const evaluated = await evaluate(target, value, selected);
    assert.equal(evaluated.status, 'failed');
    target.store.update(scope, (state) => {
      state.evaluations[0].status = 'passed';
    });
    assert.throws(
      () =>
        target.promote(scope, value.adapter.digest, {
          evaluationId: evaluated.id,
          expectedPolicyVersion: 0,
        }),
      /passing_evaluation_required/
    );
  }
});

test('efficiency is frozen, protects every case and needs heldout count reduction', async () => {
  const criterion = { kind: 'efficiency', metric: 'toolCalls', minimumAbsoluteGain: 1 };
  for (const mode of ['gain', 'tie', 'regression', 'missing']) {
    const target = engine({
      learning: provider(mode, {
        async evaluate(input) {
          assert.ok(Object.isFrozen(input.criterion));
          assert.ok(Object.isFrozen(input.budget));
          assert.ok(Object.isFrozen(input.cases));
          const result = await provider(mode).evaluate(input);
          for (const item of result.results) item.baselinePassed = true;
          if (mode === 'regression') result.results[0].candidateMetrics.toolCalls = 4;
          if (mode === 'missing') delete result.results[2].candidateMetrics;
          return result;
        },
      }),
    });
    const selected = cases(target),
      value = candidate(target);
    const evaluated = await evaluate(target, value, selected, criterion);
    assert.equal(evaluated.status, mode === 'gain' ? 'passed' : 'failed');
    assert.deepEqual(evaluated.criterion, criterion);
    if (mode === 'gain') {
      const policy = target.promote(scope, value.adapter.digest, {
        evaluationId: evaluated.id,
        expectedPolicyVersion: 0,
      });
      assert.equal(policy.version, 1);
      assert.equal(
        target.captureAdapter(scope, { model: 'fixed', providerIdentityDigest: 'endpoint' })
          .harnessAdapter.sha256,
        value.adapter.digest
      );
      assert.equal(
        target.captureAdapter(scope, { model: 'different', providerIdentityDigest: 'endpoint' })
          .reason,
        'adapter_model_mismatch'
      );
      assert.ok(
        Object.isFrozen(
          target.captureAdapter(scope, { model: 'different', providerIdentityDigest: 'endpoint' })
            .adapter
        )
      );
      assert.throws(() => target.rollback(scope, 0), /policy_version_conflict/);
      assert.equal(target.rollback(scope, 1).activeDigest, RSI_BASELINE.digest);
    }
  }
});

test('holdout consumption and split exposure survive deletion and failed evaluation', async () => {
  const target = engine({
    learning: provider('gain', {
      async evaluate() {
        throw new Error('private-provider-error');
      },
    }),
  });
  const selected = cases(target),
    value = candidate(target);
  const result = await evaluate(target, value, selected);
  assert.equal(result.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('private-provider-error'), false);
  await assert.rejects(evaluate(target, value, selected), /holdout_already_consumed/);
  target.deleteCase(scope, selected[2].id);
  const reenrolled = target.enrollCase(scope, {
    runId: selected[2].runId,
    input: 'Different annotation',
    expectedOutcome: 'other',
    split: 'holdout',
  });
  await assert.rejects(
    evaluate(target, value, [selected[0], selected[1], reenrolled]),
    /holdout_already_consumed/
  );
  target.deleteCase(scope, selected[0].id);
  assert.throws(
    () =>
      target.enrollCase(scope, {
        runId: selected[0].runId,
        input: 'Relabel',
        expectedOutcome: 'pass',
        split: 'holdout',
      }),
    /case_split_immutable/
  );
});

test('selected validation survives telemetry expiry/deletion and model or evaluator drift blocks promotion', async () => {
  const learning = provider();
  const target = engine({ learning });
  const selected = cases(target),
    value = candidate(target);
  const result = await evaluate(target, value, selected);
  learning.evaluatorVersion = 'changed';
  assert.throws(
    () =>
      target.promote(scope, value.adapter.digest, {
        evaluationId: result.id,
        expectedPolicyVersion: 0,
      }),
    /evaluation_provider_changed/
  );
  learning.evaluatorVersion = 'task.v1';
  target.promote(scope, value.adapter.digest, {
    evaluationId: result.id,
    expectedPolicyVersion: 0,
  });
  const frozen = target.captureAdapter(scope, {
    model: 'fixed',
    providerIdentityDigest: 'endpoint',
  });
  assert.ok(Object.isFrozen(frozen.harnessAdapter));
  target.deleteCase(scope, selected[0].id);
  target.store.update(scope, (state) => {
    state.evaluations = [];
    state.transitions = [];
  });
  assert.equal(
    target.captureAdapter(scope, { model: 'fixed', providerIdentityDigest: 'endpoint' }).adapter
      .digest,
    value.adapter.digest
  );
  target.rollback(scope, 1);
  assert.equal(frozen.adapter.digest, value.adapter.digest);
});

test('the actual native MossAgent request and receipt match the selected version through rollback', async () => {
  const target = engine();
  const selected = cases(target),
    value = candidate(target);
  const result = await evaluate(target, value, selected);
  target.promote(scope, value.adapter.digest, {
    evaluationId: result.id,
    expectedPolicyVersion: 0,
  });
  const captured = target.captureAdapter(scope, {
    model: 'fixed',
    providerIdentityDigest: 'endpoint',
  });
  const observer = target.createRunObserver({
    scope,
    runId: 'native-execution',
    adapter: captured,
    model: 'fixed',
  });
  const requests = [];
  const agent = new MossAgent({
    model: 'fixed',
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    llmProvider: {
      id: 'test',
      capabilities: { streaming: false },
      async complete(request) {
        requests.push(request);
        target.rollback(scope, 1);
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'verified response' }] };
      },
    },
    sessionStore: new InMemorySessionStore(),
    onAgentLoopEvent(event, identity) {
      if (identity.runId === 'native-execution') observer.onEvent(event);
    },
  });
  try {
    const result = await agent.chat('native-session', 'Reply once.', {
      runId: 'native-execution',
      harnessAdapter: captured.harnessAdapter,
      taskFlow: false,
    });
    observer.finish('completed');
    assert.ok(requests[0].systemPrompt.endsWith(value.adapter.instructions));
    assert.equal(result.harnessAdapter.sha256, value.adapter.digest);
    assert.equal(target.getRun(scope, 'native-execution').adapter.applicationMode, 'native-sdk');
    assert.equal(target.getRun(scope, 'native-execution').adapter.digest, value.adapter.digest);
    assert.equal(target.status(scope).activeAdapter.applicationMode, 'baseline');
  } finally {
    await agent.close();
  }
  const wrong = target.createRunObserver({ scope, runId: 'wrong', adapter: captured });
  wrong.onEvent({ type: 'turn_start', turn: 1 });
  wrong.finish('completed');
  assert.throws(() => target.getRun(scope, 'wrong'), /run_not_found/);
});

test('task pairing withholds labels and IDs, counterbalances arms and allocates equal bounded budgets', async () => {
  const target = engine(),
    selected = cases(target),
    value = candidate(target);
  const calls = [];
  const evaluator = createRsiTaskEvaluator({
    model: 'fixed',
    evaluatorVersion: 'real-task.v1',
    async runCase(input) {
      calls.push(input);
      const text = JSON.stringify(input.task);
      for (const item of selected) assert.equal(text.includes(item.id), false);
      assert.doesNotMatch(text, /expectedOutcome|task_oracle_passed|holdout|training|validation/);
      assert.ok(Object.isFrozen(input.budget));
      return {
        passed: true,
        reason: 'independent-oracle',
        metrics: { toolCalls: input.adapter.instructions ? 1 : 3 },
        spend: { modelCalls: 2, inputTokens: 10, outputTokens: 2 },
      };
    },
  });
  const result = await evaluator({
    baseline: RSI_BASELINE,
    candidate: value.adapter,
    cases: selected,
    budget,
  });
  assert.equal(result.spend.modelCalls, 12);
  assert.deepEqual(
    calls.map((c) => c.adapter.id),
    [
      RSI_BASELINE.id,
      value.adapter.id,
      value.adapter.id,
      RSI_BASELINE.id,
      RSI_BASELINE.id,
      value.adapter.id,
    ]
  );
  assert.deepEqual(
    calls.map((c) => c.budget.maxModelCalls),
    [3, 3, 3, 3, 3, 3]
  );
  assert.deepEqual(calls[0].task, calls[1].task);
  assert.equal(result.results[2].candidateMetrics.toolCalls, 1);
  await assert.rejects(
    evaluator({
      baseline: RSI_BASELINE,
      candidate: value.adapter,
      cases: selected,
      budget: { ...budget, maxModelCalls: 5 },
    }),
    /learning_budget_insufficient/
  );
  assert.equal(calls.length, 6, 'insufficient budget is rejected before a runner call');
  const overspend = createRsiTaskEvaluator({
    model: 'fixed',
    evaluatorVersion: 'real-task.v1',
    async runCase() {
      return { passed: true, reason: 'oracle', spend: { modelCalls: 99 } };
    },
  });
  await assert.rejects(
    overspend({ baseline: RSI_BASELINE, candidate: value.adapter, cases: selected, budget }),
    /invalid_task_evaluation_result/
  );
});

test('portable model identity excludes credentials and rejects endpoints with embedded secrets', () => {
  const input = {
    provider: 'openai-compatible',
    model: 'fixed',
    baseUrl: 'https://model.example/v1',
  };
  assert.equal(
    rsiProviderIdentityDigest(input),
    rsiProviderIdentityDigest({ ...input, baseUrl: input.baseUrl + '/' })
  );
  assert.notEqual(
    rsiProviderIdentityDigest(input),
    rsiProviderIdentityDigest({ ...input, model: 'other' })
  );
  assert.throws(
    () => rsiProviderIdentityDigest({ ...input, baseUrl: input.baseUrl + '?key=private' }),
    /learner_configuration_invalid/
  );
});

test('the convenience learner remains label-withholding and can inject a task evaluator', async () => {
  const target = engine(),
    selected = cases(target);
  const requests = [];
  const custom = async () => ({ model: 'fixed', evaluatorVersion: 'tasks.v1', results: [] });
  const learner = createRsiLearningProvider({
    model: 'fixed',
    identityDigest: 'endpoint',
    objective: 'Improve tool efficiency without task regressions.',
    evaluatorVersion: 'tasks.v1',
    evaluate: custom,
    createProvider: () => ({
      id: 'nonstreaming-test',
      capabilities: { streaming: false },
      async complete(request) {
        requests.push(request);
        return {
          stopReason: 'end_turn',
          content: [
            {
              type: 'text',
              text: '{"instructions":"Batch independent read-only probes when relevant."}',
            },
          ],
        };
      },
    }),
  });
  const value = await learner.propose({
    baseline: RSI_BASELINE,
    cases: selected.slice(0, 1),
    budget,
  });
  assert.ok(value.instructions.includes('read-only'));
  assert.equal(learner.evaluate, custom);
  assert.equal(learner.evaluatorVersion, 'tasks.v1');
  assert.ok(requests[0].systemPrompt.includes('Improve tool efficiency'));
  assert.deepEqual(requests[0].tools, []);
  await assert.rejects(
    learner.propose({ baseline: RSI_BASELINE, cases: selected.slice(2), budget }),
    /holdout_disclosure_denied/
  );
});

test('frozen task definitions do not pretend to be native runs or leak verifier inputs', async () => {
  const target = engine();
  observation(target, 'real-training-observation');
  const fixture = (split, digest, extra = {}) =>
    target.enrollTaskCase(scope, {
      sourceKey: `source-${split}`,
      input: 'Analyze the configured board project.',
      expectedOutcome: 'oracle:board-v1',
      split,
      fixtureDigest: digest.repeat(64),
      oracleVersion: 'private-oracle-v1',
      ...extra,
    });
  const training = fixture('training', 'a', { observationRunId: 'real-training-observation' });
  const validation = fixture('validation', 'b');
  const holdout = fixture('holdout', 'c');
  assert.equal(training.evidence.source, 'task-fixture');
  assert.equal(training.evidence.observation.runId, 'real-training-observation');
  assert.equal(validation.evidence.observation, undefined);
  assert.equal(
    target.listRuns(scope).length,
    1,
    'unexecuted definitions never manufacture observed runs'
  );
  assert.notEqual(training.evidence.taskDefinitionDigest, training.evidenceDigest);
  assert.throws(
    () => fixture('training', 'd', { observationRunId: 'foreign-or-missing' }),
    /run_not_found/
  );
  const value = candidate(target);
  const calls = [];
  const taskEvaluator = createRsiTaskEvaluator({
    model: 'fixed',
    evaluatorVersion: 'task.v1',
    async runCase(input) {
      calls.push(input.task);
      assert.doesNotMatch(
        JSON.stringify(input.task),
        /oracle:board-v1|private-oracle-v1|source-training|source-validation|source-holdout|taskDefinitionDigest|fixtureDigest|fixture:/
      );
      return {
        passed: true,
        reason: 'oracle',
        metrics: { toolCalls: 1 },
        spend: { modelCalls: 1 },
      };
    },
  });
  await taskEvaluator({
    baseline: RSI_BASELINE,
    candidate: value.adapter,
    cases: [training, validation, holdout],
    budget,
  });
  assert.equal(calls[0].evidence.toolFailures, 1, 'authentic training metadata is retained');
  assert.equal(
    calls[2].evidence,
    undefined,
    'unexecuted fixture evidence is not passed as execution facts'
  );
  const evaluated = await evaluate(target, value, [training, validation, holdout]);
  assert.equal(evaluated.status, 'passed');
  target.deleteCase(scope, holdout.id);
  const relabelled = fixture('holdout', 'c', {
    sourceKey: 'changed-source',
    input: 'changed-input',
    expectedOutcome: 'changed-label',
    oracleVersion: 'changed-oracle',
  });
  await assert.rejects(
    evaluate(target, value, [training, validation, relabelled]),
    /holdout_already_consumed/
  );
  target.deleteCase(scope, training.id);
  assert.throws(
    () => fixture('holdout', 'a', { sourceKey: 'try-to-launder-source' }),
    /case_split_immutable/
  );
});

test('native observation exposure cannot cross splits through task fixtures or deletion', () => {
  const native = (target, runId, split) =>
    target.enrollCase(scope, {
      runId,
      input: 'Inspect the board project.',
      expectedOutcome: 'oracle:board-v1',
      split,
    });
  const fixture = (target, runId, split, digest) =>
    target.enrollTaskCase(scope, {
      sourceKey: 'board-project',
      input: 'Inspect the board project.',
      expectedOutcome: 'oracle:board-v1',
      split,
      fixtureDigest: digest.repeat(64),
      oracleVersion: 'board-v1',
      observationRunId: runId,
    });
  const target = engine();
  observation(target, 'native-holdout');
  const holdout = native(target, 'native-holdout', 'holdout');
  assert.throws(() => fixture(target, 'native-holdout', 'training', 'a'), /case_split_immutable/);
  target.deleteCase(scope, holdout.id);
  assert.throws(() => fixture(target, 'native-holdout', 'training', 'b'), /case_split_immutable/);

  observation(target, 'fixture-training');
  const training = fixture(target, 'fixture-training', 'training', 'c');
  assert.throws(() => native(target, 'fixture-training', 'holdout'), /case_split_immutable/);
  for (const split of ['validation', 'holdout']) {
    assert.throws(
      () => fixture(target, 'fixture-training', split, 'd'),
      /fixture_observation_training_required/
    );
  }
  const sameSplit = fixture(target, 'fixture-training', 'training', 'e');
  target.deleteCase(scope, training.id);
  target.deleteCase(scope, sameSplit.id);
  assert.throws(() => native(target, 'fixture-training', 'holdout'), /case_split_immutable/);
  assert.equal(native(target, 'fixture-training', 'training').split, 'training');
});

test('task observation exposure survives expiry and rejects invalid stored fixture observations', async () => {
  const target = engine();
  observation(target, 'fixture-observation');
  const enrolled = target.enrollTaskCase(scope, {
    sourceKey: 'board-project',
    input: 'Inspect the board project.',
    expectedOutcome: 'oracle:board-v1',
    split: 'training',
    fixtureDigest: 'e'.repeat(64),
    oracleVersion: 'board-v1',
    observationRunId: 'fixture-observation',
  });
  target.store.update(scope, (state) => {
    state.cases.find((c) => c.id === enrolled.id).createdAt = 0;
  });
  assert.equal(target.listCases(scope).length, 0);
  assert.throws(
    () =>
      target.enrollCase(scope, {
        runId: 'fixture-observation',
        input: 'Relabel the expired observation.',
        expectedOutcome: 'other',
        split: 'holdout',
      }),
    /case_split_immutable/
  );

  const selected = cases(target),
    value = candidate(target);
  for (const split of ['validation', 'holdout']) {
    const invalid = target.enrollTaskCase(scope, {
      sourceKey: 'legacy-fixture',
      input: 'Inspect another board project.',
      expectedOutcome: 'oracle:board-v1',
      split,
      fixtureDigest: (split === 'validation' ? 'a' : 'b').repeat(64),
      oracleVersion: 'board-v1',
    });
    target.store.update(scope, (state) => {
      const item = state.cases.find((c) => c.id === invalid.id);
      item.evidence.observation = target.getRun(scope, 'fixture-observation');
    });
    await assert.rejects(
      target.propose(scope, {
        caseIds: [selected[0].id, invalid.id],
        budget,
      }),
      /fixture_observation_training_required/
    );
    await assert.rejects(
      evaluate(target, value, [...selected, invalid]),
      /fixture_observation_training_required/
    );
    assert.equal(target.listEvaluations(scope).length, 0);
    assert.equal(
      target.listCases(scope).find((c) => c.id === selected[2].id).holdoutConsumed,
      false
    );
    target.deleteCase(scope, invalid.id);
  }
  const missingExposure = target.enrollTaskCase(scope, {
    sourceKey: 'legacy-training-fixture',
    input: 'Inspect another board project.',
    expectedOutcome: 'oracle:board-v1',
    split: 'training',
    fixtureDigest: 'c'.repeat(64),
    oracleVersion: 'board-v1',
  });
  const passed = await evaluate(target, value, [missingExposure, selected[1], selected[2]]);
  assert.equal(passed.status, 'passed');
  target.store.update(scope, (state) => {
    const item = state.cases.find((c) => c.id === missingExposure.id);
    item.evidence.observation = target.getRun(scope, selected[2].runId);
  });
  await assert.rejects(
    target.propose(scope, { caseIds: [missingExposure.id], budget }),
    /case_exposure_changed/,
    'a legacy training fixture cannot disclose a native holdout observation'
  );
  await assert.rejects(
    evaluate(target, value, [missingExposure, selected[1], selected[2]]),
    /case_exposure_changed/
  );
  assert.throws(
    () =>
      target.promote(scope, value.adapter.digest, {
        evaluationId: passed.id,
        expectedPolicyVersion: 0,
      }),
    /case_exposure_changed/,
    'a historical passed evaluation cannot bypass the current source-exposure boundary'
  );
});

test('efficiency does not recast a baseline failure as a cheap successful task', async () => {
  const target = engine();
  const selected = cases(target),
    value = candidate(target);
  const result = await evaluate(target, value, selected, {
    kind: 'efficiency',
    metric: 'toolCalls',
    minimumAbsoluteGain: 1,
  });
  assert.equal(result.results[2].baselinePassed, false);
  assert.equal(result.status, 'failed');
});

test('async evaluation and long-lived observation capture their admitted namespace', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const target = engine({
    learning: provider('gain', {
      async evaluate(input) {
        await pending;
        return provider().evaluate(input);
      },
    }),
  });
  const selected = cases(target),
    value = candidate(target);
  const mutableScope = { ...scope };
  const evaluation = target.evaluate(mutableScope, value.adapter.digest, {
    caseIds: selected.map((c) => c.id),
    budget,
  });
  mutableScope.ownerKey = 'different-owner';
  release();
  assert.equal((await evaluation).status, 'passed');
  assert.equal(target.listEvaluations(scope).length, 1);
  assert.deepEqual(target.listEvaluations(mutableScope), []);
  const observerScope = { ...scope };
  const observerSelection = structuredClone(target.captureAdapter(scope));
  const observer = target.createRunObserver({
    scope: observerScope,
    runId: 'frozen-observer',
    adapter: observerSelection,
  });
  observerScope.ownerKey = 'different-owner';
  observerSelection.adapter.instructions = 'unrelated later edit';
  observer.onEvent({ type: 'turn_start', turn: 1 });
  observer.finish('completed');
  assert.equal(target.getRun(scope, 'frozen-observer').outcome, 'completed');
  assert.deepEqual(target.listRuns(observerScope), []);
});
