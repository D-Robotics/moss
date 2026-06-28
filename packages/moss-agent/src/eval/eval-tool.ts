














import type { Tool } from '../core/tools/tool-types.js';
import { EvalSuite, EvalRunner, type EvalCase } from './eval-runner.js';
import {
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  semanticSimilarityMetric,
  toolUsageMetric,
  jsonSchemaMetric,
} from './metrics.js';

export interface EvalToolInput {
  
  action: 'define' | 'run' | 'auto' | 'report';
  
  suiteName?: string;
  
  suiteDefinition?: {
    description?: string;
    cases: Array<{
      id: string;
      description: string;
      input: string;
      expected: unknown;
      metrics?: Array<{
        name: string;
        type:
          | 'exactMatch'
          | 'containsAll'
          | 'containsAny'
          | 'semanticSimilarity'
          | 'toolUsage'
          | 'jsonSchema';
        weight?: number;
      }>;
    }>;
  };
  
  response?: string;
  
  expected?: unknown;
  
  metrics?: Array<{
    name: string;
    type:
      | 'exactMatch'
      | 'containsAll'
      | 'containsAny'
      | 'semanticSimilarity'
      | 'toolUsage'
      | 'jsonSchema';
    weight?: number;
  }>;
  



  responses?: Array<{
    caseId: string;
    response: string;
    toolCalls?: string[];
    durationMs?: number;
  }>;
}

const METRIC_MAP: Record<string, any> = {
  exactMatch: exactMatchMetric,
  containsAll: containsAllMetric,
  containsAny: containsAnyMetric,
  semanticSimilarity: semanticSimilarityMetric,
  toolUsage: toolUsageMetric,
  jsonSchema: jsonSchemaMetric,
};






export function createEvalTool(): Tool<EvalToolInput> {
  
  const suites = new Map<string, EvalSuite>();

  return {
    name: 'eval',
    description:
      'Run evaluation suites to measure agent response quality. ' +
      'Supports defining test suites with metrics, running them against responses, ' +
      'and generating reports. ' +
      'Metrics include: exactMatch, containsAll, containsAny, semanticSimilarity, toolUsage, jsonSchema.\n' +
      'Auto-evaluation workflow:\n' +
      '  1. "define" a suite with test cases\n' +
      '  2. "auto" returns all test inputs — answer each one in subsequent messages\n' +
      '  3. "run" with responses array to score all at once\n' +
      '  4. "report" for a formatted summary\n' +
      'Alternative: use "run" with a single response+metrics for ad-hoc scoring.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['define', 'run', 'auto', 'report'],
          description: 'Action to perform.',
        },
        suiteName: {
          type: 'string',
          description: 'Name of the eval suite.',
        },
        suiteDefinition: {
          type: 'object',
          description: 'Suite definition for "define" action.',
          properties: {
            description: { type: 'string' },
            cases: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  description: { type: 'string' },
                  input: { type: 'string' },
                  expected: {},
                  metrics: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        type: {
                          type: 'string',
                          enum: [
                            'exactMatch',
                            'containsAll',
                            'containsAny',
                            'semanticSimilarity',
                            'toolUsage',
                            'jsonSchema',
                          ],
                        },
                        weight: { type: 'number' },
                      },
                      required: ['name', 'type'],
                    },
                  },
                },
                required: ['id', 'description', 'input', 'expected'],
              },
            },
          },
          required: ['cases'],
        },
        response: {
          type: 'string',
          description: 'Response text to evaluate (for "run" with a single response).',
        },
        expected: {
          description: 'Expected value for single response evaluation.',
        },
        metrics: {
          type: 'array',
          description: 'Metrics for single response evaluation.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: {
                type: 'string',
                enum: [
                  'exactMatch',
                  'containsAll',
                  'containsAny',
                  'semanticSimilarity',
                  'toolUsage',
                  'jsonSchema',
                ],
              },
              weight: { type: 'number' },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['action'],
    },
    async execute(input, _ctx) {
      const runner = new EvalRunner({ passThreshold: 0.7 });

      switch (input.action) {
        case 'define': {
          if (!input.suiteName || !input.suiteDefinition) {
            return 'Error: suiteName and suiteDefinition are required for "define" action.';
          }

          const def = input.suiteDefinition;
          const cases: EvalCase[] = def.cases.map((c) => ({
            id: c.id,
            description: c.description,
            input: c.input,
            expected: c.expected,
            metrics: (c.metrics ?? []).map((m) => ({
              name: m.name,
              fn: METRIC_MAP[m.type] ?? exactMatchMetric,
              weight: m.weight,
            })),
          }));

          const suite = new EvalSuite({
            name: input.suiteName,
            description: def.description,
            cases,
          });

          suites.set(input.suiteName, suite);
          return `Eval suite "${input.suiteName}" defined with ${cases.length} test cases.`;
        }

        case 'auto': {
          if (!input.suiteName) {
            return 'Error: suiteName is required for "auto" action.';
          }
          const suite = suites.get(input.suiteName);
          if (!suite) {
            return `Error: eval suite "${input.suiteName}" not found. Use action "define" first.`;
          }

          const lines: string[] = [
            `[eval auto] Suite "${input.suiteName}" — ${suite.cases.length} test cases.`,
            'Below are all test inputs. For each, generate the best response you can, ' +
              'then call eval with action "run" and the responses array to score them all at once.',
            '---',
          ];
          for (const c of suite.cases) {
            lines.push(
              `[Case ${c.id}] "${c.description}"\n` +
                `Input: ${c.input}\n` +
                `Expected: ${JSON.stringify(c.expected)}`
            );
          }
          return lines.join('\n\n');
        }

        case 'run': {
          
          if (input.responses && input.responses.length > 0) {
            if (!input.suiteName) {
              return 'Error: suiteName is required when using responses array.';
            }
            const suite = suites.get(input.suiteName);
            if (!suite) {
              return `Error: eval suite "${input.suiteName}" not found. Use action "define" first.`;
            }

            const caseMap = new Map(suite.cases.map((c) => [c.id, c]));
            const results: Array<{ caseId: string; passed: boolean; score: number }> = [];
            for (const entry of input.responses) {
              const testCase = caseMap.get(entry.caseId);
              if (!testCase) {
                results.push({ caseId: entry.caseId, passed: false, score: 0 });
                continue;
              }
              const result = runner.evaluateCase(
                testCase,
                entry.response,
                entry.toolCalls,
                entry.durationMs
              );
              results.push({
                caseId: entry.caseId,
                passed: result.passed,
                score: result.overallScore,
              });
            }

            const passed = results.filter((r) => r.passed).length;
            const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
            const lines: string[] = [
              `[eval report] Suite "${input.suiteName}"`,
              `Total: ${results.length} | Passed: ${passed} | Failed: ${results.length - passed}`,
              `Avg Score: ${(avgScore * 100).toFixed(1)}%`,
              '---',
            ];
            for (const r of results) {
              lines.push(
                `  ${r.caseId}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.score * 100).toFixed(0)}%)`
              );
            }
            return lines.join('\n');
          }

          
          if (input.response && input.metrics) {
            const testCase: EvalCase = {
              id: 'adhoc',
              description: 'Ad-hoc evaluation',
              input: '',
              expected: input.expected ?? '',
              metrics: input.metrics.map((m) => ({
                name: m.name,
                fn: METRIC_MAP[m.type] ?? exactMatchMetric,
                weight: m.weight,
              })),
            };

            const result = runner.evaluateCase(testCase, input.response);
            const lines: string[] = [];
            lines.push(`[eval: ${result.passed ? 'PASS' : 'FAIL'}]`);
            lines.push(`Score: ${(result.overallScore * 100).toFixed(1)}%`);
            for (const m of result.metrics) {
              lines.push(`  ${m.name}: ${(m.score * 100).toFixed(0)}% (weight: ${m.weight})`);
            }
            return lines.join('\n');
          }

          
          if (!input.suiteName) {
            return 'Error: suiteName is required for "run" action. Provide suiteName+responses for batch scoring, or response+metrics for ad-hoc scoring.';
          }

          const suite = suites.get(input.suiteName);
          if (!suite) {
            return `Error: eval suite "${input.suiteName}" not found. Use action "define" first.`;
          }

          return (
            `Eval suite "${input.suiteName}" has ${suite.cases.length} cases ready. ` +
            `To run the full suite:\n` +
            `  1. Call "auto" to get all test inputs\n` +
            `  2. Generate a response for each case\n` +
            `  3. Call "run" with the responses array to score all at once`
          );
        }

        case 'report': {
          if (!input.suiteName) {
            return 'Error: suiteName is required for "report" action.';
          }

          const suite = suites.get(input.suiteName);
          if (!suite) {
            return `Error: eval suite "${input.suiteName}" not found. Use action "define" first.`;
          }

          return (
            `Eval suite "${input.suiteName}": ${suite.cases.length} cases defined. ` +
            `Use "auto" to get test inputs, generate responses, then "run" with the responses array to score and get a report.`
          );
        }

        default:
          return `Error: unknown action "${(input as any).action}". Use "define", "run", "auto", or "report".`;
      }
    },
  };
}






export const evalTool: Tool<EvalToolInput> = createEvalTool();
