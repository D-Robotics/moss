import assert from 'node:assert/strict';
import test from 'node:test';
import { PromotionCoordinator } from '../dist/acceptance/promotion-coordinator.js';

const candidate = (id, targetSkill = 'rdk-device') => ({
  id,
  targetSkill,
  provenance: {
    layer: 'L2',
    kind: 'explicit-proposal',
    source: 'test-fixture',
    proposalRef: `proposal://${id}`,
  },
});

const stats = (skill, proofCount, successRate) => ({
  skill,
  proofCount,
  passCount: Math.round(proofCount * successRate),
  failCount: proofCount - Math.round(proofCount * successRate),
  unknownCount: 0,
  successRate,
  averageConfidence: 0.9,
  signalSources: ['tool_exit'],
});

async function captureWarnings(run) {
  const write = process.stderr.write;
  const warnings = [];
  process.stderr.write = (chunk, ...args) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return warnings;
}

test('empty candidate source is a no-op', async () => {
  let downstreamCalls = 0;
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [],
    statsSource: () => { downstreamCalls += 1; },
    crossSignalVerifier: () => { downstreamCalls += 1; return true; },
    decisionSink: () => { downstreamCalls += 1; },
  });
  await coordinator.observeCompletion({ sessionKey: 's1' });
  assert.equal(downstreamCalls, 0);
});

test('missing statistics emits no fabricated decision', async () => {
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('a')],
    statsSource: () => undefined,
    crossSignalVerifier: () => true,
    decisionSink: (record) => records.push(record),
  });
  await coordinator.observeCompletion({});
  assert.deepEqual(records, []);
});

test('statistical rejection skips cross-signal verification and reaches sink', async () => {
  let verifierCalls = 0;
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('a')],
    statsSource: () => stats('rdk-device', 9, 1),
    crossSignalVerifier: () => { verifierCalls += 1; return true; },
    decisionSink: (record) => records.push(record),
  });
  await coordinator.observeCompletion({});
  assert.equal(verifierCalls, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision.promotable, false);
  assert.equal(records[0].decision.statisticalPassed, false);
});

test('statistical pass plus cross-signal failure emits one non-promotable record', async () => {
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('a')],
    statsSource: () => stats('rdk-device', 10, 0.7),
    crossSignalVerifier: () => false,
    decisionSink: (record) => records.push(record),
  });
  await coordinator.observeCompletion({});
  assert.equal(records.length, 1);
  assert.equal(records[0].decision.promotable, false);
  assert.equal(records[0].decision.crossSignalPassed, false);
});

test('both gates passing emits one promotable record', async () => {
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('a')],
    statsSource: () => stats('rdk-device', 10, 0.7),
    crossSignalVerifier: () => true,
    decisionSink: (record) => records.push(record),
  });
  await coordinator.observeCompletion({});
  assert.equal(records.length, 1);
  assert.equal(records[0].decision.promotable, true);
  assert.equal(records[0].decision.crossSignalPassed, true);
});

test('candidate-source failure resolves without throwing and warns', async () => {
  const coordinator = new PromotionCoordinator({
    candidateSource: () => { throw new Error('candidate failure'); },
    statsSource: () => stats('rdk-device', 10, 1),
    crossSignalVerifier: () => true,
    decisionSink: () => {},
  });
  const warnings = await captureWarnings(() => coordinator.observeCompletion({}));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /promotion candidate discovery failed/);
});

test('stats-source failure continues to the next candidate and warns', async () => {
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('bad'), candidate('good')],
    statsSource: (value) => {
      if (value.id === 'bad') throw new Error('stats failure');
      return stats('rdk-device', 10, 1);
    },
    crossSignalVerifier: () => true,
    decisionSink: (record) => records.push(record),
  });
  const warnings = await captureWarnings(() => coordinator.observeCompletion({}));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /promotion statistics lookup failed/);
  assert.deepEqual(records.map((record) => record.candidate.id), ['good']);
});

test('verifier failure continues to the next candidate and warns', async () => {
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('bad'), candidate('good')],
    statsSource: () => stats('rdk-device', 10, 1),
    crossSignalVerifier: (value) => {
      if (value.id === 'bad') throw new Error('verifier failure');
      return true;
    },
    decisionSink: (record) => records.push(record),
  });
  const warnings = await captureWarnings(() => coordinator.observeCompletion({}));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /promotion candidate evaluation failed/);
  assert.deepEqual(records.map((record) => record.candidate.id), ['good']);
});

test('sink failure continues to the next candidate and warns', async () => {
  const delivered = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('bad'), candidate('good')],
    statsSource: () => stats('rdk-device', 10, 1),
    crossSignalVerifier: () => true,
    decisionSink: (record) => {
      if (record.candidate.id === 'bad') throw new Error('sink failure');
      delivered.push(record);
    },
  });
  const warnings = await captureWarnings(() => coordinator.observeCompletion({}));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /promotion decision delivery failed/);
  assert.deepEqual(delivered.map((record) => record.candidate.id), ['good']);
});

test('candidates sharing a target skill receive outcomes based on their IDs', async () => {
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('reject', 'shared-skill'), candidate('accept', 'shared-skill')],
    statsSource: (value) => stats(value.targetSkill, 10, 1),
    crossSignalVerifier: (value) => value.id === 'accept',
    decisionSink: (record) => records.push(record),
  });
  await coordinator.observeCompletion({});
  assert.deepEqual(
    records.map((record) => [record.candidate.id, record.decision.promotable]),
    [['reject', false], ['accept', true]],
  );
});
