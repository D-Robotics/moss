/**
 * Eval Runner — executes eval suites and produces reports.
 *
 * Supports multiple metrics per test case, weighted scoring,
 * and aggregate reporting across suites.
 *
 * @public
 */
import type { MetricFn, MetricConfig } from './metrics.js';

export interface EvalCase {
  /** Unique case identifier. */
  id: string;
  /** Human-readable description of what this case tests. */
  description: string;
  /** The input/prompt to send to the agent. */
  input: string;
  /** Expected output or criteria. */
  expected: unknown;
  /** Metrics to apply to this case. */
  metrics: Array<{
    name: string;
    fn: MetricFn;
    config?: MetricConfig;
    weight?: number;
  }>;
  /** Optional context: tool calls that should be made. */
  expectedToolCalls?: string[];
  /** Optional context: JSON Schema for structured output validation. */
  outputSchema?: Record<string, unknown>;
  /** Tags for filtering test cases. */
  tags?: string[];
}

export interface EvalSuiteConfig {
  /** Suite name. */
  name: string;
  /** Suite description. */
  description?: string;
  /** Test cases. */
  cases: EvalCase[];
  /** Default metrics applied to all cases. */
  defaultMetrics?: Array<{
    name: string;
    fn: MetricFn;
    config?: MetricConfig;
    weight?: number;
  }>;
}

export interface EvalMetric {
  name: string;
  score: number;
  weight: number;
}

export interface EvalResult {
  caseId: string;
  description: string;
  response: string;
  metrics: EvalMetric[];
  overallScore: number;
  passed: boolean;
  toolCallsUsed?: string[];
  durationMs?: number;
}

export interface EvalReport {
  suiteName: string;
  description?: string;
  timestamp: string;
  results: EvalResult[];
  summary: {
    totalCases: number;
    passed: number;
    failed: number;
    averageScore: number;
    minScore: number;
    maxScore: number;
    metrics: Record<string, { avg: number; min: number; max: number }>;
  };
}

export interface EvalRunnerOptions {
  /** Threshold for pass/fail (default 0.7). */
  passThreshold?: number;
  /** Whether to include response text in the report (default true). */
  includeResponses?: boolean;
}

/**
 * An eval suite bundles test cases with metrics and can be executed
 * against agent responses.
 *
 * @public
 */
export class EvalSuite {
  readonly name: string;
  readonly description: string;
  readonly cases: EvalCase[];
  readonly defaultMetrics: EvalSuiteConfig['defaultMetrics'];

  constructor(config: EvalSuiteConfig) {
    this.name = config.name;
    this.description = config.description ?? '';
    this.cases = config.cases;
    this.defaultMetrics = config.defaultMetrics;
  }

  /**
   * Get all metrics for a case, merging defaults with case-specific ones.
   */
  getMetricsForCase(testCase: EvalCase): Array<{ name: string; fn: MetricFn; config?: MetricConfig; weight: number }> {
    const metrics: Array<{ name: string; fn: MetricFn; config?: MetricConfig; weight: number }> = [];

    // Add default metrics first
    if (this.defaultMetrics) {
      for (const m of this.defaultMetrics) {
        metrics.push({ name: m.name, fn: m.fn, config: m.config, weight: m.weight ?? 1.0 });
      }
    }

    // Case-specific metrics override defaults with same name
    for (const m of testCase.metrics) {
      const idx = metrics.findIndex((existing) => existing.name === m.name);
      const entry = { name: m.name, fn: m.fn, config: m.config, weight: m.weight ?? 1.0 };
      if (idx >= 0) {
        metrics[idx] = entry;
      } else {
        metrics.push(entry);
      }
    }

    return metrics;
  }
}

/**
 * Runs eval suites and produces reports.
 *
 * @public
 */
export class EvalRunner {
  private passThreshold: number;
  private includeResponses: boolean;

  constructor(options: EvalRunnerOptions = {}) {
    this.passThreshold = options.passThreshold ?? 0.7;
    this.includeResponses = options.includeResponses ?? true;
  }

  /**
   * Run an eval suite, providing a function that generates agent responses.
   *
   * @param suite - The eval suite to run.
   * @param generateResponse - Async function that takes an input prompt and returns the agent's response.
   *   Also receives the case for context-aware evaluation.
   */
  async runSuite(
    suite: EvalSuite,
    generateResponse: (input: string, testCase: EvalCase) => Promise<{ response: string; toolCalls?: string[]; durationMs?: number }>,
  ): Promise<EvalReport> {
    const results: EvalResult[] = [];

    for (const testCase of suite.cases) {
      const startTime = Date.now();
      let response: string;
      let toolCalls: string[] | undefined;
      let durationMs: number | undefined;

      try {
        const generated = await generateResponse(testCase.input, testCase);
        response = generated.response;
        toolCalls = generated.toolCalls;
        durationMs = generated.durationMs ?? (Date.now() - startTime);
      } catch (err) {
        response = `[ERROR] ${err instanceof Error ? err.message : String(err)}`;
        durationMs = Date.now() - startTime;
      }

      const result = this.evaluateCase(testCase, response, toolCalls, durationMs);
      results.push(result);
    }

    return this.buildReport(suite, results);
  }

  /**
   * Evaluate a single test case response against its expected criteria.
   */
  evaluateCase(
    testCase: EvalCase,
    response: string,
    toolCallsUsed?: string[],
    durationMs?: number,
  ): EvalResult {
    const metrics = (testCase as any)._suite
      ? (testCase as any)._suite.getMetricsForCase(testCase)
      : testCase.metrics.map((m) => ({ name: m.name, fn: m.fn, config: m.config, weight: m.weight ?? 1.0 }));

    const metricResults: EvalMetric[] = [];
    let totalWeight = 0;
    let weightedSum = 0;

    for (const metric of metrics) {
      let score: number;
      try {
        score = metric.fn(response, testCase.expected, metric.config);
      } catch {
        score = 0;
      }
      score = Math.max(0, Math.min(1, score));
      metricResults.push({ name: metric.name, score, weight: metric.weight });
      weightedSum += score * metric.weight;
      totalWeight += metric.weight;
    }

    const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    return {
      caseId: testCase.id,
      description: testCase.description,
      response: this.includeResponses ? response : '[response omitted]',
      metrics: metricResults,
      overallScore,
      passed: overallScore >= this.passThreshold,
      toolCallsUsed,
      durationMs,
    };
  }

  /**
   * Build a structured report from eval results.
   */
  private buildReport(suite: EvalSuite, results: EvalResult[]): EvalReport {
    const scores = results.map((r) => r.overallScore);

    // Aggregate metrics by name
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

  /**
   * Format a report as a human-readable string.
   */
  static formatReport(report: EvalReport): string {
    const lines: string[] = [];

    lines.push(`# Eval Report: ${report.suiteName}`);
    if (report.description) lines.push(`${report.description}`);
    lines.push(`Timestamp: ${report.timestamp}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push(`  Total: ${report.summary.totalCases}`);
    lines.push(`  Passed: ${report.summary.passed}`);
    lines.push(`  Failed: ${report.summary.failed}`);
    lines.push(`  Average Score: ${(report.summary.averageScore * 100).toFixed(1)}%`);
    lines.push(`  Score Range: ${(report.summary.minScore * 100).toFixed(0)}% - ${(report.summary.maxScore * 100).toFixed(0)}%`);
    lines.push('');

    // Per-metric summary
    if (Object.keys(report.summary.metrics).length > 0) {
      lines.push('## Metrics');
      for (const [name, stats] of Object.entries(report.summary.metrics)) {
        lines.push(`  ${name}: avg=${(stats.avg * 100).toFixed(1)}%, min=${(stats.min * 100).toFixed(0)}%, max=${(stats.max * 100).toFixed(0)}%`);
      }
      lines.push('');
    }

    // Per-case results
    lines.push('## Cases');
    for (const result of report.results) {
      const status = result.passed ? 'PASS' : 'FAIL';
      lines.push(`  [${status}] ${result.caseId}: ${result.description}`);
      lines.push(`    Score: ${(result.overallScore * 100).toFixed(1)}%`);
      if (result.durationMs !== undefined) {
        lines.push(`    Duration: ${result.durationMs}ms`);
      }
      for (const metric of result.metrics) {
        lines.push(`    ${metric.name}: ${(metric.score * 100).toFixed(0)}% (weight: ${metric.weight})`);
      }
      if (result.toolCallsUsed && result.toolCallsUsed.length > 0) {
        lines.push(`    Tools used: ${result.toolCallsUsed.join(', ')}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format a report as JSON.
   */
  static formatReportJson(report: EvalReport): string {
    return JSON.stringify(report, null, 2);
  }
}
