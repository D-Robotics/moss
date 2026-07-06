












import type { Tool } from '../core/tools/tool-types.js';
import {
  validateJsonSchema,
  generateSchemaDescription,
  type JsonSchema,
} from './schema-validator.js';
import { errorMessage } from '../errors.js';

/**
 * Module-level registry of pending structured-output validations, keyed by
 * sessionKey. When `generate_structured` is called non-validateOnly, the
 * schema + prompt are stored here. The MossAgent completion gate reads (and
 * clears) this to enforce host-side validation after the LLM produces JSON.
 */
const pendingValidations = new Map<string, { schema: JsonSchema; prompt: string; attempt: number }>();

export function takePendingStructuredValidation(sessionKey: string): { schema: JsonSchema; prompt: string; attempt: number } | undefined {
  const entry = pendingValidations.get(sessionKey);
  if (entry) {
    pendingValidations.delete(sessionKey);
    return entry;
  }
  return undefined;
}

export function peekPendingStructuredValidation(sessionKey: string): { schema: JsonSchema; prompt: string; attempt: number } | undefined {
  return pendingValidations.get(sessionKey);
}

export function setPendingStructuredValidation(sessionKey: string, schema: JsonSchema, prompt: string): void {
  pendingValidations.set(sessionKey, { schema, prompt, attempt: 1 });
}

export function bumpStructuredValidationAttempt(sessionKey: string): void {
  const entry = pendingValidations.get(sessionKey);
  if (entry) {
    entry.attempt += 1;
    pendingValidations.set(sessionKey, entry);
  }
}

export function clearPendingStructuredValidation(sessionKey: string): void {
  pendingValidations.delete(sessionKey);
}

export interface StructuredOutputInput {
  
  schema: Record<string, unknown>;
  
  prompt: string;
  
  output?: string;
  
  validateOnly?: boolean;
}

export interface StructuredOutputResult {
  
  valid: boolean;
  
  data?: unknown;
  
  errors?: Array<{ path: string; message: string }>;
  
  schemaDescription: string;
  
  raw?: string;
}

export interface StructuredOutputToolOptions {
  
  maxRetries?: number;
}

function toolError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${errorMessage(err)}`);
}






export function createStructuredOutputTool(
  options: StructuredOutputToolOptions = {}
): Tool<StructuredOutputInput> {
  const maxRetries = options.maxRetries ?? 3;

  return {
    name: 'generate_structured',
    description:
      'Generate structured JSON output that must conform to a specified JSON Schema. ' +
      'Use this when you need to produce structured data (e.g., lists, summaries, configurations) ' +
      'with guaranteed format correctness. ' +
      'Provide a JSON Schema and a prompt describing what to generate, then produce the JSON in a ```json block in your reply. ' +
      'Host-side enforcement is active: the agent loop validates your JSON against the schema automatically and, if invalid, feeds the errors back as a correction and re-prompts you (up to 3 retries) — you do NOT need to self-validate. ' +
      'Call this tool ONCE (without validateOnly), then emit the JSON. ' +
      'Use validateOnly: true only to pre-check existing JSON you already have on hand (optional).',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'object',
          description:
            'JSON Schema object that defines the expected output structure. Must include "type" at minimum.',
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
          description:
            'If true, only validate the provided output against the schema (default: false).',
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

        // Validate required schema fields
        if (!schema.type && !schema.$ref && !schema.anyOf && !schema.oneOf && !schema.allOf) {
          return [
            'Error: schema.type is required',
            '',
            'Your schema must specify at least one of:',
            '- type: "object", "array", "string", "number", "boolean", "null"',
            '- $ref: "#/$defs/SomeName" (reference to a definition)',
            '- anyOf, oneOf, allOf: for composite schemas',
            '',
            'Example schema:',
            JSON.stringify(
              {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  age: { type: 'number' },
                },
                required: ['name'],
              },
              null,
              2
            ),
          ].join('\n');
        }

        const schemaDescription = generateSchemaDescription(schema);


        if (input.validateOnly && input.output) {
          try {
            const parsed = JSON.parse(input.output);
            const result = validateJsonSchema(parsed, schema);
            if (result.valid) {
              return `[generate_structured: valid]\nSchema: ${schemaDescription}\n\nThe provided output is valid JSON matching the schema.`;
            }
            const errorDetails = result.errors
              .map((e) => {
                const lines = [`  - ${e.path}: ${e.message}`];
                if (e.expected) lines.push(`    Expected: ${e.expected}`);
                if (e.actual) lines.push(`    Got: ${e.actual}`);
                return lines.join('\n');
              })
              .join('\n');
            return [
              '[generate_structured: invalid]',
              '',
              'Schema:',
              schemaDescription,
              '',
              'Validation errors:',
              errorDetails,
              '',
              'Next steps:',
              '1. Review the errors above and the schema description',
              '2. Regenerate the output to fix all reported errors',
              '3. Retry validation with the corrected output',
            ].join('\n');
          } catch (parseErr) {
            return [
              '[generate_structured: invalid JSON]',
              '',
              'Error: The output is not valid JSON',
              `Detail: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
              '',
              'Next steps:',
              '1. Ensure your output is wrapped in valid JSON syntax',
              '2. Check for missing quotes, commas, or braces',
              '3. Regenerate as valid JSON matching the schema below',
              '',
              'Expected schema:',
              schemaDescription,
            ].join('\n');
          }
        }

        
        // Non-validateOnly path: return instructions AND register a pending
        // host-side validation. After the LLM produces JSON text in response,
        // the MossAgent completion gate will validate it automatically (up to
        // maxRetries). This is the host-side enforcement layer — the LLM no
        // longer needs to self-validate via a second validateOnly call.
        setPendingStructuredValidation(_ctx.sessionKey, schema, input.prompt);

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
        lines.push('Host-side enforcement is active: the agent loop validates your JSON');
        lines.push('automatically and feeds any errors back as a correction. Output the JSON');
        lines.push('once — no manual validateOnly call needed.');
        if (maxRetries > 1) {
          lines.push(`You have up to ${maxRetries} automatic retries before the gate gives up.`);
        }

        return lines.join('\n');
      } catch (err) {
        throw toolError('Structured output generation failed', err);
      }
    },
  };
}






export const structuredOutputTool: Tool<StructuredOutputInput> = createStructuredOutputTool();
