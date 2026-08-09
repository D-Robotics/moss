import {
  EvalSuite,
  EvalRunner,
  buildEvalReport,
  type EvalCase,
  type EvalResult,
  type EvalReport,
  type EvalRunnerOptions,
} from './eval-runner.js';
import {
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  tokenOverlapMetric,
  toolUsageMetric,
  jsonSchemaMetric,
} from './metrics.js';
import { errorMessage } from '../errors.js';

export interface EvalDriverOptions extends EvalRunnerOptions {
  timeoutMs?: number;

  concurrency?: number;

  retries?: number;

  onProgress?: (
    index: number,
    total: number,
    caseId: string,
    status: 'running' | 'done' | 'failed' | 'retrying'
  ) => void;
}

export interface GenerateResponseResult {
  response: string;
  toolCalls?: string[];
  durationMs?: number;
}

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
    this.timeoutMs =
      options.timeoutMs ??
      (process.env.MOSS_EVAL_TIMEOUT_MS
        ? Number.parseInt(process.env.MOSS_EVAL_TIMEOUT_MS, 10)
        : 60_000);
    this.concurrency =
      options.concurrency ??
      (process.env.MOSS_EVAL_CONCURRENCY
        ? Number.parseInt(process.env.MOSS_EVAL_CONCURRENCY, 10)
        : 1);
    this.retries =
      options.retries ??
      (process.env.MOSS_EVAL_RETRIES ? Number.parseInt(process.env.MOSS_EVAL_RETRIES, 10) : 0);
    this.onProgress = options.onProgress;
  }

  async run(
    suite: EvalSuite,
    generateResponse: (input: string, testCase: EvalCase) => Promise<GenerateResponseResult>
  ): Promise<EvalReport> {
    const results: EvalResult[] = [];
    const totalCases = suite.cases.length;

    if (this.concurrency <= 1) {
      for (let i = 0; i < totalCases; i++) {
        const result = await this.runSingleCase(suite.cases[i], i, totalCases, generateResponse);
        results.push(result);
      }
    } else {
      for (let i = 0; i < totalCases; i += this.concurrency) {
        const batch = suite.cases.slice(i, i + this.concurrency);
        const batchResults = await Promise.all(
          batch.map((testCase, batchIndex) =>
            this.runSingleCase(testCase, i + batchIndex, totalCases, generateResponse)
          )
        );
        results.push(...batchResults);
      }
    }

    return buildEvalReport(suite, results);
  }

  private async runSingleCase(
    testCase: EvalCase,
    index: number,
    total: number,
    generateResponse: (input: string, testCase: EvalCase) => Promise<GenerateResponseResult>
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
          generateResponse(testCase.input, testCase).then((result) => ({
            tag: 'response' as const,
            result,
          })),
          new Promise<{ tag: 'timeout' }>((resolve) =>
            setTimeout(() => resolve({ tag: 'timeout' }), this.timeoutMs)
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
            this.timeoutMs
          );
        }

        const { response, toolCalls, durationMs } = raceResult.result;
        const result = this.runner.evaluateCase(testCase, response, toolCalls, durationMs);
        this.onProgress?.(index, total, testCase.id, 'done');
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        this.onProgress?.(index, total, testCase.id, 'failed');
        return this.runner.evaluateCase(testCase, `[ERROR] ${errorMessage(err)}`, undefined);
      }
    }

    return this.runner.evaluateCase(testCase, `[ERROR] unexpected`, undefined);
  }
}

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
  metricMap: Record<
    string,
    (response: string, expected: unknown, config?: { weight?: number }) => number
  >
): EvalSuite {
  const defaultMap: Record<string, any> = {
    exactMatch: exactMatchMetric,
    containsAll: containsAllMetric,
    containsAny: containsAnyMetric,
    tokenOverlap: tokenOverlapMetric,
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
