/**
 * EvalDriver — fully automated evaluation pipeline.
 *
 * Orchestrates the complete eval workflow:
 *  1. Load or define an eval suite with test cases
 *  2. For each test case, invoke the agent to generate a response
 *  3. Score each response against the expected criteria
 *  4. Generate a comprehensive report
 *
 * Unlike the eval tool (which requires pre-provided responses), EvalDriver
 * calls the agent automatically for each test case. It is designed for use
 * by the CLI host (`moss eval run`) and by programmatic API consumers.
 *
 * Configuration:
 *  - `MOSS_EVAL_TIMEOUT_MS` — max time per case (default 60000)
 *  - `MOSS_EVAL_CONCURRENCY` — max concurrent cases (default 1, sequential)
 *  - `MOSS_EVAL_RETRIES` — retry failed cases (default 0)
 *
 * @public
 */
import {
  EvalSuite,
  EvalRunner,
  type EvalCase,
  type EvalResult,
  type EvalReport,
  type EvalRunnerOptions,
} from './eval-runner.js';
import {
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  semanticSimilarityMetric,
  toolUsageMetric,
  jsonSchemaMetric,
} from './metrics.js';
import { errorMessage } from '../errors.js';

export interface EvalDriverOptions extends EvalRunnerOptions {
  /** Max milliseconds per test case (default 60000). */
  timeoutMs?: number;
  /** Max concurrent test cases (default 1 = sequential). */
  concurrency?: number;
  /** Retry failed cases up to this many times (default 0). */
  retries?: number;
  /** Progress callback — receives (caseIndex, totalCases, caseId, status). */
  onProgress?: (index: number, total: number, caseId: string, status: 'running' | 'done' | 'failed' | 'retrying') => void;
}

export interface GenerateResponseResult {
  response: string;
  toolCalls?: string[];
  durationMs?: number;
}

/**
 * EvalDriver orchestrates the full automated evaluation pipeline.
 *
 * Usage:
 * ```typescript
 * const driver = new EvalDriver({ timeoutMs: 30000, concurrency: 2 });
 * const report = await driver.run(suite, async (input) => {
 *   const result = await myAgent.query(input);
 *   return { response: result.text, durationMs: result.durationMs };
 * });
 * console.log(EvalRunner.formatReport(report));
 * ```
 *
 * @public
 */
export class EvalDriver {
  private runner: EvalRunner;
  private timeoutMs: number;
  private concurrency: number;
  private retries: number;
  private onProgress?: EvalDriverOptions['onProgress'];

  constructor(options: EvalDriverOptions = {}) {
    this.runner = new EvalRunner({
      passThreshold: options.passThreshold,
      includeResponses: options.includeResponses,
    });
    this.timeoutMs = options.timeoutMs ??
      (process.env.MOSS_EVAL_TIMEOUT_MS ? Number.parseInt(process.env.MOSS_EVAL_TIMEOUT_MS, 10) : 60_000);
    this.concurrency = options.concurrency ??
      (process.env.MOSS_EVAL_CONCURRENCY ? Number.parseInt(process.env.MOSS_EVAL_CONCURRENCY, 10) : 1);
    this.retries = options.retries ??
      (process.env.MOSS_EVAL_RETRIES ? Number.parseInt(process.env.MOSS_EVAL_RETRIES, 10) : 0);
    this.onProgress = options.onProgress;
  }

  /**
   * Run a complete automated evaluation.
   *
   * @param suite — The eval suite to run.
   * @param generateResponse — Async function that takes a test case input and returns the agent's response.
   *   Called once per case (plus retries).
   */
  async run(
    suite: EvalSuite,
    generateResponse: (input: string, testCase: EvalCase) => Promise<GenerateResponseResult>,
  ): Promise<EvalReport> {
    const results: EvalResult[] = [];
    const totalCases = suite.cases.length;

    if (this.concurrency <= 1) {
      // Sequential execution for deterministic ordering
      for (let i = 0; i < totalCases; i++) {
        const result = await this.runSingleCase(suite.cases[i], i, totalCases, generateResponse);
        results.push(result);
      }
    } else {
      // Parallel execution with batch limiting
      for (let i = 0; i < totalCases; i += this.concurrency) {
        const batch = suite.cases.slice(i, i + this.concurrency);
        const batchResults = await Promise.all(
          batch.map((testCase, batchIndex) =>
            this.runSingleCase(testCase, i + batchIndex, totalCases, generateResponse),
          ),
        );
        results.push(...batchResults);
      }
    }

    return this.buildReport(suite, results);
  }

  private async runSingleCase(
    testCase: EvalCase,
    index: number,
    total: number,
    generateResponse: (input: string, testCase: EvalCase) => Promise<GenerateResponseResult>,
  ): Promise<EvalResult> {
    let lastError: unknown;
    const maxAttempts = this.retries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const isRetry = attempt > 0;
      if (isRetry) {
        this.onProgress?.(index, total, testCase.id, 'retrying');
      } else {
        this.onProgress?.(index, total, testCase.id, 'running');
      }

      try {
        const raceResult = await Promise.race([
          generateResponse(testCase.input, testCase).then((result) => ({ tag: 'response' as const, result })),
          new Promise<{ tag: 'timeout' }>((resolve) =>
            setTimeout(() => resolve({ tag: 'timeout' }), this.timeoutMs),
          ),
        ]);

        if (raceResult.tag === 'timeout') {
          lastError = new Error(`Test case "${testCase.id}" timed out after ${this.timeoutMs}ms`);
          if (attempt < maxAttempts - 1) continue;
          this.onProgress?.(index, total, testCase.id, 'failed');
          return this.runner.evaluateCase(
            testCase,
            `[TIMEOUT] ${errorMessage(lastError)}`,
            undefined,
            this.timeoutMs,
          );
        }

        const { response, toolCalls, durationMs } = raceResult.result;
        const result = this.runner.evaluateCase(testCase, response, toolCalls, durationMs);
        this.onProgress?.(index, total, testCase.id, 'done');
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts - 1) {
          // Brief delay before retry
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        this.onProgress?.(index, total, testCase.id, 'failed');
        return this.runner.evaluateCase(
          testCase,
          `[ERROR] ${errorMessage(err)}`,
          undefined,
        );
      }
    }

    // Unreachable (loop always returns), but TypeScript needs a return
    return this.runner.evaluateCase(testCase, `[ERROR] unexpected`, undefined);
  }

  private buildReport(suite: EvalSuite, results: EvalResult[]): EvalReport {
    const scores = results.map((r) => r.overallScore);

    const metricAggregates: Record<string, { scores: number[] }> = {};
    for (const result of results) {
      for (const metric of result.metrics) {
        if (!metricAggregates[metric.name]) {
          metricAggregates[metric.name] = { scores: [] };
        }
        metricAggregates[metric.name].scores.push(metric.score);
      }
    }

    const summary = {
      totalCases: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      averageScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      minScore: scores.length > 0 ? Math.min(...scores) : 0,
      maxScore: scores.length > 0 ? Math.max(...scores) : 0,
      metrics: Object.fromEntries(
        Object.entries(metricAggregates).map(([name, agg]) => [
          name,
          {
            avg: agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length,
            min: Math.min(...agg.scores),
            max: Math.max(...agg.scores),
          },
        ]),
      ),
    };

    return {
      suiteName: suite.name,
      description: suite.description,
      timestamp: new Date().toISOString(),
      results,
      summary,
    };
  }
}

/**
 * Load an eval suite from a JSON configuration object.
 *
 * Example config:
 * ```json
 * {
 *   "name": "my-suite",
 *   "description": "Tests for my agent",
 *   "cases": [
 *     {
 *       "id": "case-1",
 *       "description": "Basic greeting",
 *       "input": "Hello",
 *       "expected": "Hello",
 *       "metrics": [{"name": "contains", "type": "containsAny"}]
 *     }
 *   ]
 * }
 * ```
 *
 * @public
 */
export function loadEvalSuiteFromConfig(
  config: {
    name: string;
    description?: string;
    cases: Array<{
      id: string;
      description: string;
      input: string;
      expected: unknown;
      metrics?: Array<{
        name: string;
        type: string;
        weight?: number;
      }>;
      expectedToolCalls?: string[];
      outputSchema?: Record<string, unknown>;
      tags?: string[];
    }>;
  },
  metricMap: Record<string, (response: string, expected: unknown, config?: { weight?: number }) => number>,
): EvalSuite {
  const defaultMap: Record<string, any> = {
    exactMatch: exactMatchMetric,
    containsAll: containsAllMetric,
    containsAny: containsAnyMetric,
    semanticSimilarity: semanticSimilarityMetric,
    toolUsage: toolUsageMetric,
    jsonSchema: jsonSchemaMetric,
    ...metricMap,
  };

  return new EvalSuite({
    name: config.name,
    description: config.description,
    cases: config.cases.map((c) => ({
      id: c.id,
      description: c.description,
      input: c.input,
      expected: c.expected,
      metrics: (c.metrics ?? []).map((m) => ({
        name: m.name,
        fn: defaultMap[m.type] ?? exactMatchMetric,
        weight: m.weight,
      })),
      ...(c.expectedToolCalls ? { expectedToolCalls: c.expectedToolCalls } : {}),
      ...(c.outputSchema ? { outputSchema: c.outputSchema } : {}),
      ...(c.tags ? { tags: c.tags } : {}),
    })),
  });
}
