







import type { MetricFn, MetricConfig } from './metrics.js';
import { errorMessage } from '../errors.js';

export interface EvalCase {
  
  id: string;
  
  description: string;
  
  input: string;
  
  expected: unknown;
  
  metrics: Array<{
    name: string;
    fn: MetricFn;
    config?: MetricConfig;
    weight?: number;
  }>;
  
  expectedToolCalls?: string[];
  
  outputSchema?: Record<string, unknown>;
  
  tags?: string[];
}

export interface EvalSuiteConfig {
  
  name: string;
  
  description?: string;
  
  cases: EvalCase[];
  
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
  
  passThreshold?: number;
  
  includeResponses?: boolean;
}







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

  


  getMetricsForCase(
    testCase: EvalCase
  ): Array<{ name: string; fn: MetricFn; config?: MetricConfig; weight: number }> {
    const metrics: Array<{ name: string; fn: MetricFn; config?: MetricConfig; weight: number }> =
      [];

    
    if (this.defaultMetrics) {
      for (const m of this.defaultMetrics) {
        metrics.push({ name: m.name, fn: m.fn, config: m.config, weight: m.weight ?? 1.0 });
      }
    }

    
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






export class EvalRunner {
  private passThreshold: number;
  private includeResponses: boolean;

  constructor(options: EvalRunnerOptions = {}) {
    this.passThreshold = options.passThreshold ?? 0.7;
    this.includeResponses = options.includeResponses ?? true;
  }

  






  async runSuite(
    suite: EvalSuite,
    generateResponse: (
      input: string,
      testCase: EvalCase
    ) => Promise<{ response: string; toolCalls?: string[]; durationMs?: number }>
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
        durationMs = generated.durationMs ?? Date.now() - startTime;
      } catch (err) {
        response = `[ERROR] ${errorMessage(err)}`;
        durationMs = Date.now() - startTime;
      }

      const result = this.evaluateCase(testCase, response, toolCalls, durationMs, suite);
      results.push(result);
    }

    return buildEvalReport(suite, results);
  }

  


  evaluateCase(
    testCase: EvalCase,
    response: string,
    toolCallsUsed?: string[],
    durationMs?: number,
    suite?: EvalSuite
  ): EvalResult {
    // Use the suite (passed by runSuite) to merge defaultMetrics with the
    // case's own metrics. The previous `(testCase as any)._suite` lookup was
    // dead code — nothing ever set `_suite` on a case, so suite-level
    // defaultMetrics were silently ignored.
    const metrics = suite
      ? suite.getMetricsForCase(testCase)
      : testCase.metrics.map((m) => ({
          name: m.name,
          fn: m.fn,
          config: m.config,
          weight: m.weight ?? 1.0,
        }));

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

  


  static formatReport(report: EvalReport): string {
    const lines: string[] = [];

    lines.push(`# Eval Report: ${report.suiteName}`);
    if (report.description) lines.push(`${report.description}`);
    lines.push(`Timestamp: ${report.timestamp}`);
    lines.push('');

    
    lines.push('## Summary');
    lines.push(`  Total: ${report.summary.totalCases}`);
    lines.push(`  Passed: ${report.summary.passed}`);
    lines.push(`  Failed: ${report.summary.failed}`);
    lines.push(`  Average Score: ${(report.summary.averageScore * 100).toFixed(1)}%`);
    lines.push(
      `  Score Range: ${(report.summary.minScore * 100).toFixed(0)}% - ${(report.summary.maxScore * 100).toFixed(0)}%`
    );
    lines.push('');

    
    if (Object.keys(report.summary.metrics).length > 0) {
      lines.push('## Metrics');
      for (const [name, stats] of Object.entries(report.summary.metrics)) {
        lines.push(
          `  ${name}: avg=${(stats.avg * 100).toFixed(1)}%, min=${(stats.min * 100).toFixed(0)}%, max=${(stats.max * 100).toFixed(0)}%`
        );
      }
      lines.push('');
    }

    
    lines.push('## Cases');
    for (const result of report.results) {
      const status = result.passed ? 'PASS' : 'FAIL';
      lines.push(`  [${status}] ${result.caseId}: ${result.description}`);
      lines.push(`    Score: ${(result.overallScore * 100).toFixed(1)}%`);
      if (result.durationMs !== undefined) {
        lines.push(`    Duration: ${result.durationMs}ms`);
      }
      for (const metric of result.metrics) {
        lines.push(
          `    ${metric.name}: ${(metric.score * 100).toFixed(0)}% (weight: ${metric.weight})`
        );
      }
      if (result.toolCallsUsed && result.toolCallsUsed.length > 0) {
        lines.push(`    Tools used: ${result.toolCallsUsed.join(', ')}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  


  static formatReportJson(report: EvalReport): string {
    return JSON.stringify(report, null, 2);
  }
}

/** Build an EvalReport from suite metadata and per-case results.
 *  Shared by EvalRunner and EvalDriver. */
export function buildEvalReport(suite: EvalSuite, results: EvalResult[]): EvalReport {
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
      ])
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
