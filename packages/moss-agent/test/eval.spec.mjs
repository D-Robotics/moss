#!/usr/bin/env node
/**
 * eval — exactMatch correctness + defaultMetrics application.
 *
 * The eval module previously had zero tests. These pin down two fixes:
 *  (1) `exactMatchMetric` used `response.includes(expected)` — a substring
 *      test, so "pineapple" matched "apple" with score 1.0. Now an actual
 *      exact match (trim + ===); substring matching is what containsAll/
 *      containsAny are for.
 *  (2) `EvalRunner.runSuite` never applied `EvalSuite.defaultMetrics`: the
 *      `evaluateCase` lookup used `(testCase as any)._suite`, which nothing
 *      ever set, so suite-level default metrics were silently ignored.
 *      `evaluateCase` now takes the suite and merges via getMetricsForCase.
 */
import assert from 'node:assert/strict';
import { EvalSuite, EvalRunner } from '../dist/eval/eval-runner.js';
import { exactMatchMetric } from '../dist/eval/metrics.js';

// ─── 1. exactMatchMetric is exact, not substring ───────────────────────────
{
  assert.equal(exactMatchMetric('apple', 'apple'), 1.0, 'exact match passes');
  assert.equal(exactMatchMetric('pineapple', 'apple'), 0.0, 'substring is NOT exact match');
  assert.equal(exactMatchMetric('  apple  ', 'apple'), 1.0, 'surrounding whitespace ignored');
  assert.equal(exactMatchMetric('The answer is apple', 'apple'), 0.0, 'embedded substring is not exact');
  assert.equal(exactMatchMetric('apple', ''), 0, 'empty expected scores 0');
}

// ─── 2. defaultMetrics are applied to cases with no metrics of their own ───
{
  const suite = new EvalSuite({
    name: 's1',
    cases: [
      { id: 'c1', description: '', input: 'q', expected: 'hello', metrics: [] },
    ],
    defaultMetrics: [{ name: 'exact', fn: exactMatchMetric }],
  });
  const runner = new EvalRunner();
  // Stub responder returns the case's expected value → exactMatch scores 1.0.
  const report = await runner.runSuite(suite, async (_input, testCase) => ({
    response: String(testCase.expected),
  }));
  const result = report.results[0];
  assert.equal(result.metrics.length, 1, 'defaultMetrics applied (case had no metrics of its own)');
  assert.equal(result.metrics[0].name, 'exact', 'the default metric is present');
  assert.equal(result.overallScore, 1.0, 'default metric scored the matching response 1.0');
  assert.equal(result.passed, true, 'case passes when default metric scores 1.0');
}

// ─── 3. case-level metrics still override same-named default metrics ───────
{
  const suite = new EvalSuite({
    name: 's2',
    cases: [
      {
        id: 'c1',
        description: '',
        input: 'q',
        expected: 'hello',
        // case-level metric with a different weight overrides the default 'm'.
        metrics: [{ name: 'm', fn: exactMatchMetric, weight: 2.0 }],
      },
    ],
    defaultMetrics: [{ name: 'm', fn: exactMatchMetric, weight: 0.5 }],
  });
  const runner = new EvalRunner();
  const report = await runner.runSuite(suite, async (_input, testCase) => ({
    response: String(testCase.expected),
  }));
  const result = report.results[0];
  assert.equal(result.metrics.length, 1, 'case metric overrides same-named default (not duplicated)');
  assert.equal(result.metrics[0].weight, 2.0, 'case-level weight wins');
}

console.log('  [PASS] eval: exactMatch correctness + defaultMetrics application');
