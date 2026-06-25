/**
 * Eval tool — exposes the eval framework as a tool for the Moss agent.
 *
 * The agent can run eval suites against its own responses or against
 * predefined test cases to measure accuracy and quality.
 *
 * @public
 */
import type { Tool } from '../core/tools/tool-types.js';
import {
  EvalSuite,
  EvalRunner,
  type EvalCase,
} from './eval-runner.js';
import {
  exactMatchMetric,
  containsAllMetric,
  containsAnyMetric,
  semanticSimilarityMetric,
  toolUsageMetric,
  jsonSchemaMetric,
} from './metrics.js';

export interface EvalToolInput {
  /** Action to perform: "define", "run", or "report". */
  action: 'define' | 'run' | 'report';
  /** Suite name (for all actions). */
  suiteName?: string;
  /** Suite definition (for "define" action). */
  suiteDefinition?: {
    description?: string;
    cases: Array<{
      id: string;
      description: string;
      input: string;
      expected: unknown;
      metrics?: Array<{
        name: string;
        type: 'exactMatch' | 'containsAll' | 'containsAny' | 'semanticSimilarity' | 'toolUsage' | 'jsonSchema';
        weight?: number;
      }>;
    }>;
  };
  /** Response to evaluate (for "run" action, when evaluating a single response). */
  response?: string;
  /** Expected criteria (for "run" action with a single response). */
  expected?: unknown;
  /** Metrics to use (for "run" action with a single response). */
  metrics?: Array<{
    name: string;
    type: 'exactMatch' | 'containsAll' | 'containsAny' | 'semanticSimilarity' | 'toolUsage' | 'jsonSchema';
    weight?: number;
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

/**
 * Create an eval tool.
 *
 * @public
 */
export function createEvalTool(): Tool<EvalToolInput> {
  // In-memory suite storage for the tool session
  const suites = new Map<string, EvalSuite>();

  return {
    name: 'eval',
    description:
      'Run evaluation suites to measure agent response quality. ' +
      'Supports defining test suites with metrics, running them against responses, ' +
      'and generating reports. ' +
      'Metrics include: exactMatch, containsAll, containsAny, semanticSimilarity, toolUsage, jsonSchema.\n' +
      'Actions:\n' +
      '- "define": Create an eval suite with test cases and metrics\n' +
      '- "run": Execute an eval suite and score the responses\n' +
      '- "report": Generate a formatted report from eval results',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['define', 'run', 'report'],
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
                        type: { type: 'string', enum: ['exactMatch', 'containsAll', 'containsAny', 'semanticSimilarity', 'toolUsage', 'jsonSchema'] },
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
              type: { type: 'string', enum: ['exactMatch', 'containsAll', 'containsAny', 'semanticSimilarity', 'toolUsage', 'jsonSchema'] },
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

        case 'run': {
          // Single response evaluation
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

          // Suite evaluation — requires pre-defined suite
          if (!input.suiteName) {
            return 'Error: suiteName is required for "run" action. Either provide suiteName or response+metrics.';
          }

          const suite = suites.get(input.suiteName);
          if (!suite) {
            return `Error: eval suite "${input.suiteName}" not found. Use action "define" first.`;
          }

          // For suite runs, we need actual agent responses.
          // The tool can only score provided responses, not generate them.
          return `Eval suite "${input.suiteName}" has ${suite.cases.length} cases ready. ` +
            `To run, provide responses for each case or use the EvalRunner API directly. ` +
            `For single-response evaluation, use response+metrics parameters.`;
        }

        case 'report': {
          if (!input.suiteName) {
            return 'Error: suiteName is required for "report" action.';
          }

          const suite = suites.get(input.suiteName);
          if (!suite) {
            return `Error: eval suite "${input.suiteName}" not found. Use action "define" first.`;
          }

          return `Eval suite "${input.suiteName}": ${suite.cases.length} cases defined. ` +
            `Run the suite first to generate a report with scores.`;
        }

        default:
          return `Error: unknown action "${(input as any).action}". Use "define", "run", or "report".`;
      }
    },
  };
}

/**
 * Default eval tool instance.
 *
 * @public
 */
export const evalTool: Tool<EvalToolInput> = createEvalTool();
