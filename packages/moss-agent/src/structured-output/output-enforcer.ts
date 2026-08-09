import {
  validateJsonSchema,
  type JsonSchema,
  type SchemaValidationResult,
} from './schema-validator.js';
import { errorMessage } from '../errors.js';

export interface EnforcerConfig {
  schema: JsonSchema;

  maxRetries?: number;

  autoRepair?: boolean;

  errorPrefix?: string;
}

export interface EnforceResult {
  valid: boolean;

  data?: unknown;

  errors?: SchemaValidationResult['errors'];

  attempts: number;

  retryFeedback?: string;
}

export class StructuredOutputEnforcer {
  private config: Required<EnforcerConfig>;

  constructor(config: EnforcerConfig) {
    this.config = {
      schema: config.schema,
      maxRetries: config.maxRetries ?? 3,
      autoRepair: config.autoRepair ?? true,
      errorPrefix: config.errorPrefix ?? 'Your output must conform to this JSON Schema:',
    };
  }

  enforce(response: string, attempt: number = 1): EnforceResult {
    const extracted = this.extractJson(response);

    if (!extracted) {
      const feedback = this.buildRetryFeedback(
        'Could not find valid JSON in the response. Please output ONLY a JSON object, wrapped in a ```json code block.',
        attempt
      );
      return {
        valid: false,
        errors: [{ path: '$', message: 'No valid JSON found in response' }],
        attempts: attempt,
        retryFeedback: feedback,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted);
    } catch (err) {
      const feedback = this.buildRetryFeedback(
        `Invalid JSON syntax: ${errorMessage(err)}. Please ensure the JSON is syntactically correct.`,
        attempt
      );
      return {
        valid: false,
        errors: [{ path: '$', message: `JSON parse error: ${errorMessage(err)}` }],
        attempts: attempt,
        retryFeedback: feedback,
      };
    }

    if (this.config.autoRepair) {
      parsed = this.autoRepairObject(parsed, this.config.schema);
    }

    const result = validateJsonSchema(parsed, this.config.schema);

    if (!result.valid) {
      const feedback = this.buildRetryFeedback(
        `The JSON output does not match the required schema:\n${result.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}`,
        attempt
      );
      return {
        valid: false,
        errors: result.errors,
        attempts: attempt,
        retryFeedback: feedback,
      };
    }

    return {
      valid: true,
      data: parsed,
      attempts: attempt,
    };
  }

  extractJson(response: string): string | null {
    const jsonBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    const trimmed = response.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\' && inString) {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (char === '{' || char === '[') {
          depth++;
        }
        if (char === '}' || char === ']') {
          depth--;
          if (depth === 0) {
            return trimmed.slice(0, i + 1);
          }
        }
      }
    }

    return null;
  }

  private autoRepairObject(data: unknown, schema: JsonSchema): unknown {
    if (typeof data !== 'object' || data === null) return data;

    if (Array.isArray(data)) return data;

    const obj = data as Record<string, unknown>;

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj) && schema.properties?.[key]?.default !== undefined) {
          obj[key] = schema.properties[key].default;
        }
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      const knownKeys = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          delete obj[key];
        }
      }
    }

    return obj;
  }

  private buildRetryFeedback(errorDetail: string, attempt: number): string {
    const schemaJson = JSON.stringify(this.config.schema, null, 2);
    const lines: string[] = [];

    lines.push(`[Schema validation failed — attempt ${attempt}/${this.config.maxRetries}]`);
    lines.push('');
    lines.push(this.config.errorPrefix);
    lines.push('```json');
    lines.push(schemaJson);
    lines.push('```');
    lines.push('');
    lines.push('## Validation Errors');
    lines.push(errorDetail);
    lines.push('');
    lines.push('Please regenerate the JSON output ensuring it conforms to the schema above.');
    lines.push('Output ONLY the JSON object, wrapped in a ```json code block.');

    return lines.join('\n');
  }
}
