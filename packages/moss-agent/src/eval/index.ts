/**
 * Eval module — built-in evaluation framework for Moss agents.
 *
 * Provides tools for:
 * 1. Defining eval suites with test cases and scoring criteria
 * 2. Running eval suites against agent responses
 * 3. Measuring accuracy, tool usage, and response quality
 * 4. Generating eval reports
 *
 * @module eval
 * @public
 */
export {
  EvalSuite,
  EvalRunner,
  type EvalSuiteConfig,
  type EvalCase,
  type EvalMetric,
  type EvalResult,
  type EvalReport,
  type EvalRunnerOptions,
} from './eval-runner.js';

export {
  createEvalTool,
  evalTool,
  type EvalToolInput,
} from './eval-tool.js';

export {
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  semanticSimilarityMetric,
  toolUsageMetric,
  jsonSchemaMetric,
  type MetricFn,
  type MetricConfig,
} from './metrics.js';
