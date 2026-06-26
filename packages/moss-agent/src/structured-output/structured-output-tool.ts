/**
 * Structured output generation tool — produces JSON output conforming to a schema.
 *
 * The agent can call this tool to generate structured data (JSON) that must
 * conform to a provided JSON Schema. The tool validates the output and
 * provides feedback if the output doesn't match.
 *
 * Note: This tool's primary role is to declare the schema requirement and
 * validate the output. The actual enforcement of structured output at the
 * LLM provider level is handled by the output enforcer.
 *
 * @public
 */
import type { Tool } from '../core/tools/tool-types.js';
import { validateJsonSchema, generateSchemaDescription, type JsonSchema } from './schema-validator.js';
import { errorMessage } from '../errors.js';

export interface StructuredOutputInput {
  /** JSON Schema that the output must conform to. */
  schema: Record<string, unknown>;
  /** Description of what to generate (the prompt). */
  prompt: string;
  /** The generated JSON output (as a string — will be parsed and validated). */
  output?: string;
  /** Whether to only validate an existing output (default: generate and validate). */
  validateOnly?: boolean;
}

export interface StructuredOutputResult {
  /** Whether the output is valid per the schema. */
  valid: boolean;
  /** The parsed JSON output (if valid). */
  data?: unknown;
  /** Schema validation errors (if invalid). */
  errors?: Array<{ path: string; message: string }>;
  /** Human-readable schema description for prompt injection. */
  schemaDescription: string;
  /** The raw JSON output string. */
  raw?: string;
}

export interface StructuredOutputToolOptions {
  /** Maximum number of retry attempts for invalid output (default 3). */
  maxRetries?: number;
}

function toolError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${errorMessage(err)}`);
}

/**
 * Create a structured output generation tool.
 *
 * @public
 */
export function createStructuredOutputTool(options: StructuredOutputToolOptions = {}): Tool<StructuredOutputInput> {
  const maxRetries = options.maxRetries ?? 3;

  return {
    name: 'generate_structured',
    description:
      'Generate structured JSON output that must conform to a specified JSON Schema. ' +
      'Use this when you need to produce structured data (e.g., lists, summaries, configurations) ' +
      'with guaranteed format correctness. ' +
      'Provide a JSON Schema and a prompt describing what to generate. ' +
      'The output will be validated against the schema automatically.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'object',
          description: 'JSON Schema object that defines the expected output structure. Must include "type" at minimum.',
        },
        prompt: {
          type: 'string',
          description: 'Description of what structured data to generate.',
        },
        output: {
          type: 'string',
          description: 'Pre-generated JSON output string to validate (for validateOnly mode).',
        },
        validateOnly: {
          type: 'boolean',
          description: 'If true, only validate the provided output against the schema (default: false).',
        },
      },
      required: ['schema', 'prompt'],
    },
    async execute(input, _ctx) {
      try {
        const schema = input.schema as JsonSchema;
        if (!schema || typeof schema !== 'object') {
          return 'Error: schema must be a valid JSON Schema object.';
        }

        const schemaDescription = generateSchemaDescription(schema);

        // If validateOnly mode, just validate the provided output
        if (input.validateOnly && input.output) {
          try {
            const parsed = JSON.parse(input.output);
            const result = validateJsonSchema(parsed, schema);
            if (result.valid) {
              return `[generate_structured: valid]\nSchema: ${schemaDescription}\n\nThe provided output is valid JSON matching the schema.`;
            }
            const errorDetails = result.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
            return `[generate_structured: invalid]\nSchema: ${schemaDescription}\n\nValidation errors:\n${errorDetails}\n\nPlease regenerate the output to fix these errors.`;
          } catch (parseErr) {
            return `[generate_structured: invalid JSON]\nSchema: ${schemaDescription}\n\nError: The output is not valid JSON — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n\nPlease regenerate as valid JSON.`;
          }
        }

        // Generate mode: return the schema and prompt for the LLM to act on
        const lines: string[] = [];
        lines.push('[generate_structured: ready]');
        lines.push('');
        lines.push('## Expected Schema');
        lines.push('```json');
        lines.push(JSON.stringify(schema, null, 2));
        lines.push('```');
        lines.push('');
        lines.push('## Schema Description');
        lines.push(schemaDescription);
        lines.push('');
        lines.push('## Generation Prompt');
        lines.push(input.prompt);
        lines.push('');
        lines.push('## Instructions');
        lines.push('Generate a JSON object that conforms to the schema above. ');
        lines.push('Wrap your JSON output in a ```json code block. ');
        lines.push('Ensure all required fields are present and types match the schema.');
        if (maxRetries > 1) {
          lines.push(`You have up to ${maxRetries} attempts to produce valid output.`);
        }

        return lines.join('\n');
      } catch (err) {
        throw toolError('Structured output generation failed', err);
      }
    },
  };
}

/**
 * Default structured output tool instance.
 *
 * @public
 */
export const structuredOutputTool: Tool<StructuredOutputInput> = createStructuredOutputTool();
