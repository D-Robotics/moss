#!/usr/bin/env node
/**
 * Test: Eval module — metrics, suites, runner, and tool.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/eval.spec.mjs
 */
import assert from 'node:assert/strict';
import { builtinTools } from '../dist/tools/builtin.js';
import {
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  semanticSimilarityMetric,
  jsonSchemaMetric,
  EvalSuite,
  EvalRunner,
  createEvalTool,
} from '../dist/eval/index.js';

// 1. Tool is in builtin tools
const names = builtinTools.map((t) => t.name);
assert.ok(names.includes('eval'), 'builtin tools should include eval');

// 2. exactMatchMetric
assert.equal(exactMatchMetric('hello world', 'hello'), 1.0);
assert.equal(exactMatchMetric('hello world', 'goodbye'), 0.0);
assert.equal(exactMatchMetric('', 'test'), 0.0);

// 3. containsAllMetric
assert.equal(containsAllMetric('The quick brown fox', ['quick', 'fox']), 1.0);
assert.equal(containsAllMetric('The quick brown fox', ['quick', 'elephant']), 0.5);
assert.equal(containsAllMetric('hello', []), 0.0);

// 4. containsAnyMetric
assert.equal(containsAnyMetric('hello world', ['hello', 'goodbye']), 1.0);
assert.equal(containsAnyMetric('hello world', ['goodbye', 'farewell']), 0.0);

// 5. semanticSimilarityMetric
const sim = semanticSimilarityMetric('hello world', 'hello world');
assert.ok(sim > 0.5, 'identical strings should have high similarity');

const lowSim = semanticSimilarityMetric('hello world', 'completely different text here');
assert.ok(lowSim < 0.5, 'different strings should have low similarity');

// 6. jsonSchemaMetric
const schemaMetric = jsonSchemaMetric(
  '```json\n{"name": "Alice", "age": 30}\n```',
  {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number' } },
    required: ['name'],
  },
);
assert.equal(schemaMetric, 1.0);

const badSchemaMetric = jsonSchemaMetric(
  '```json\n{"wrong": "value"}\n```',
  { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
);
assert.equal(badSchemaMetric, 0.0);

// 7. EvalSuite
const suite = new EvalSuite({
  name: 'test-suite',
  description: 'A test eval suite',
  cases: [
    {
      id: 'case-1',
      description: 'Basic exact match',
      input: 'What is the capital of France?',
      expected: 'Paris',
      metrics: [{ name: 'exact', fn: exactMatchMetric }],
    },
    {
      id: 'case-2',
      description: 'Contains all keywords',
      input: 'Describe a cat',
      expected: ['feline', 'pet'],
      metrics: [{ name: 'contains', fn: containsAllMetric }],
    },
  ],
  defaultMetrics: [{ name: 'semantic', fn: semanticSimilarityMetric, weight: 0.5 }],
});

assert.equal(suite.name, 'test-suite');
assert.equal(suite.cases.length, 2);

const case1Metrics = suite.getMetricsForCase(suite.cases[0]);
assert.ok(case1Metrics.some((m) => m.name === 'exact'), 'should include case-specific metric');
assert.ok(case1Metrics.some((m) => m.name === 'semantic'), 'should include default metric');

// 8. EvalRunner — evaluate single case
const runner = new EvalRunner({ passThreshold: 0.5 });
const result = runner.evaluateCase(
  suite.cases[0],
  'The capital of France is Paris.',
);
assert.ok(result.passed, 'should pass with exact match');
assert.ok(result.overallScore > 0.5, 'should have a high score');

const failResult = runner.evaluateCase(
  suite.cases[0],
  'I do not know.',
);
assert.ok(!failResult.passed || failResult.overallScore < 0.5, 'should fail or have low score');

// 9. EvalRunner — run suite
const report = await runner.runSuite(suite, async (input, testCase) => {
  if (testCase.id === 'case-1') {
    return { response: 'The capital of France is Paris.' };
  }
  return { response: 'A cat is a small feline pet animal.' };
});

assert.equal(report.suiteName, 'test-suite');
assert.equal(report.summary.totalCases, 2);
assert.ok(report.summary.averageScore >= 0, 'average score should be non-negative');

// 10. EvalRunner.formatReport
const formatted = EvalRunner.formatReport(report);
assert.ok(formatted.includes('test-suite'), 'report should include suite name');
assert.ok(formatted.includes('Summary'), 'report should include summary');
assert.ok(formatted.includes('PASS') || formatted.includes('FAIL'), 'report should show pass/fail');

// 11. EvalRunner.formatReportJson
const json = EvalRunner.formatReportJson(report);
const parsed = JSON.parse(json);
assert.equal(parsed.suiteName, 'test-suite');

// 12. Eval tool
const tool = builtinTools.find((t) => t.name === 'eval');
assert.ok(tool, 'eval tool should be registered');
assert.equal(tool.metadata?.sideEffectClass, 'readonly');

// Define a suite
const defineResult = await tool.execute(
  {
    action: 'define',
    suiteName: 'my-suite',
    suiteDefinition: {
      description: 'Test suite',
      cases: [
        { id: 'c1', description: 'Test 1', input: 'hello', expected: 'hello' },
      ],
    },
  },
  { workspaceDir: '/tmp', sessionKey: 'eval-define' },
);
assert.ok(defineResult.includes('defined'), 'should confirm suite definition');

// Run single response eval
const runResult = await tool.execute(
  {
    action: 'run',
    response: 'The answer is Paris.',
    expected: 'Paris',
    metrics: [{ name: 'exact', type: 'exactMatch' }],
  },
  { workspaceDir: '/tmp', sessionKey: 'eval-run' },
);
assert.ok(runResult.includes('Score'), 'should show score');

console.log('[PASS] Eval module: metrics, suites, runner, and tool work correctly');
