import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARNESS_FLAKE_RETRY_LIMIT,
  benchmarkPassRate,
  isHarnessFlakeSample,
  scoredBenchmarkRows,
} from '../scripts/lib/bench-flake.mjs';

const zeroTurnError = {
  pass: false,
  subtype: 'error_during_execution',
  numTurns: 1,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

test('classifies only zero-turn, zero-usage execution errors as harness flakes', () => {
  assert.equal(isHarnessFlakeSample(zeroTurnError), true);
  assert.equal(isHarnessFlakeSample({ ...zeroTurnError, numTurns: 0 }), true);
  assert.equal(isHarnessFlakeSample({ ...zeroTurnError, subtype: 'success' }), false);
  assert.equal(isHarnessFlakeSample({ ...zeroTurnError, toolCalls: 1 }), false);
  assert.equal(isHarnessFlakeSample({ ...zeroTurnError, tokensIn: 12 }), false);
  assert.equal(isHarnessFlakeSample({ ...zeroTurnError, tokensOut: 3 }), false);
  assert.equal(isHarnessFlakeSample({ ...zeroTurnError, timedOut: true }), false);
  assert.equal(isHarnessFlakeSample({ ...zeroTurnError, numTurns: null }), false);
  assert.equal(isHarnessFlakeSample(undefined), false);
  assert.equal(HARNESS_FLAKE_RETRY_LIMIT, 2);
});

test('exhausted harness flakes leave the scored denominator', () => {
  const rows = [{ pass: true }, { pass: false, excludedAsHarnessFlake: true }, { pass: false }];
  assert.deepEqual(scoredBenchmarkRows(rows), [rows[0], rows[2]]);
  assert.equal(benchmarkPassRate(rows), 0.5);
  assert.equal(benchmarkPassRate([rows[1]]), null);
});
