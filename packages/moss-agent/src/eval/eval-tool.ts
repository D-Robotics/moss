














import type { Tool } from '../core/tools/tool-types.js';
import { EvalSuite, EvalRunner, type EvalCase } from './eval-runner.js';
import {
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  tokenOverlapMetric,
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
          | 'tokenOverlap'
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
      | 'tokenOverlap'
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
  tokenOverlap: tokenOverlapMetric,
  toolUsage: toolUsageMetric,
  jsonSchema: jsonSchemaMetric,
};






export function createEvalTool(): Tool<EvalToolInput> {
  
  const suites = new Map<string, EvalSuite>();

  return {
    name: 'eval',
    description:
      'Measure agent response quality against test cases and metrics. ' +
      'Workflows:\n' +
      '  Batch: (1) "define" suite, (2) "auto" to list inputs, (3) "run" with responses array\n' +
      '  Ad-hoc: "run" with single response+expected+metrics\n' +
      'Metrics: exactMatch, containsAll, containsAny, tokenOverlap, toolUsage, jsonSchema',
    metadata: {
      // 'define' mutates an internal suites Map; 'readonly' would classify this
      // tool as parallel-safe (race on the Map) and skip approval. runtime_state
      // matches plan_step (also internal state) — serial execution + approval.
      sideEffectClass: 'runtime_state',
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
                            'tokenOverlap',
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
                  'tokenOverlap',
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
          // Batch mode: responses array for a suite
          if (input.responses && input.responses.length > 0) {
            if (!input.suiteName) {
              return 'Error: suiteName is required when using responses array. Example: eval(action="run", suiteName="my_suite", responses=[...])';
            }
            const suite = suites.get(input.suiteName);
            if (!suite) {
              return `Error: eval suite "${input.suiteName}" not found. Run eval(action="define",...) first to create it.`;
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

          // Ad-hoc mode: single response with metrics
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

          // Suite ready, waiting for responses
          if (input.suiteName) {
            const suite = suites.get(input.suiteName);
            if (!suite) {
              return `Error: eval suite "${input.suiteName}" not found. Run eval(action="define",...) first.`;
            }

            return (
              `Suite "${input.suiteName}" ready: ${suite.cases.length} cases.\n` +
              `Next: eval(action="auto", suiteName="${input.suiteName}") to list all test inputs.`
            );
          }

          // No parameters provided
          return (
            'Error: incomplete "run" action. Choose:\n' +
            '  Batch: eval(action="run", suiteName="...", responses=[{caseId, response}, ...])\n' +
            '  Ad-hoc: eval(action="run", response="...", expected=..., metrics=[...])'
          );
        }

        case 'report': {
          if (!input.suiteName) {
            return 'Error: suiteName is required for "report" action. Usage: eval(action="report", suiteName="...")';
          }

          const suite = suites.get(input.suiteName);
          if (!suite) {
            return `Error: eval suite "${input.suiteName}" not found. Define it first: eval(action="define", suiteName="...", suiteDefinition={...})`;
          }

          return (
            `Suite "${input.suiteName}": ${suite.cases.length} cases.\n` +
            `Workflow:\n` +
            `  1. eval(action="auto", suiteName="${input.suiteName}") — list test inputs\n` +
            `  2. Generate a response for each case\n` +
            `  3. eval(action="run", suiteName="${input.suiteName}", responses=[...]) — score and report`
          );
        }

        default:
          return `Error: unknown action "${(input as any).action}". Use "define", "run", "auto", or "report".`;
      }
    },
  };
}






export const evalTool: Tool<EvalToolInput> = createEvalTool();
