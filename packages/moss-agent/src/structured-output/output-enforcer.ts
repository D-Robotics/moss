/**
 * Structured Output Enforcer — validates and enforces JSON Schema constraints
 * on LLM responses, providing retry logic with error feedback.
 *
 * Works at the response-processing level to ensure structured outputs
 * from the LLM match the expected schema before being returned.
 *
 * @public
 */
import { validateJsonSchema, type JsonSchema, type SchemaValidationResult } from './schema-validator.js';

export interface EnforcerConfig {
  /** JSON Schema that output must conform to. */
  schema: JsonSchema;
  /** Maximum number of retry attempts on validation failure (default 3). */
  maxRetries?: number;
  /** Whether to attempt auto-repair of common JSON issues (default true). */
  autoRepair?: boolean;
  /** Custom error message prefix for retry feedback. */
  errorPrefix?: string;
}

export interface EnforceResult {
  /** Whether the output passed validation. */
  valid: boolean;
  /** The parsed data (if valid). */
  data?: unknown;
  /** Validation errors (if invalid). */
  errors?: SchemaValidationResult['errors'];
  /** Number of retry attempts used. */
  attempts: number;
  /** The retry feedback message to send back to the LLM (if invalid). */
  retryFeedback?: string;
}

/**
 * Structured Output Enforcer.
 *
 * Wraps the schema validator with retry logic and error feedback generation.
 * Designed to be called after each LLM response when structured output is requested.
 *
 * @public
 */
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

  /**
   * Enforce the schema on an LLM text response.
   *
   * Attempts to extract JSON from the response, parse it,
   * validate against the schema, and optionally auto-repair.
   *
   * @param response - The raw LLM response text.
   * @param attempt - Current attempt number (1-based).
   * @returns Enforcement result with data or retry feedback.
   */
  enforce(response: string, attempt: number = 1): EnforceResult {
    // Try to extract JSON from the response
    const extracted = this.extractJson(response);

    if (!extracted) {
      const feedback = this.buildRetryFeedback(
        'Could not find valid JSON in the response. Please output ONLY a JSON object, wrapped in a ```json code block.',
        attempt,
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
        `Invalid JSON syntax: ${err instanceof Error ? err.message : String(err)}. Please ensure the JSON is syntactically correct.`,
        attempt,
      );
      return {
        valid: false,
        errors: [{ path: '$', message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}` }],
        attempts: attempt,
        retryFeedback: feedback,
      };
    }

    // Auto-repair: try to fix common issues
    if (this.config.autoRepair) {
      parsed = this.autoRepairObject(parsed, this.config.schema);
    }

    // Validate against schema
    const result = validateJsonSchema(parsed, this.config.schema);

    if (!result.valid) {
      const feedback = this.buildRetryFeedback(
        `The JSON output does not match the required schema:\n${result.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}`,
        attempt,
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

  /**
   * Extract JSON from an LLM response, handling ```json code blocks.
   *
   * @public — exposed for testing and external use.
   */
  extractJson(response: string): string | null {
    // Try ```json block first
    const jsonBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    // Try to find a JSON object/array at the start
    const trimmed = response.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // Find matching closing bracket
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && inString) { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (char === '{' || char === '[') { depth++; }
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

  /**
   * Attempt to auto-repair common schema violations.
   */
  private autoRepairObject(data: unknown, schema: JsonSchema): unknown {
    if (typeof data !== 'object' || data === null) return data;

    if (Array.isArray(data)) return data;

    const obj = data as Record<string, unknown>;

    // Ensure required properties exist with defaults
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj) && schema.properties?.[key]?.default !== undefined) {
          obj[key] = schema.properties[key].default;
        }
      }
    }

    // Remove unexpected properties if additionalProperties is false
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

  /**
   * Build a retry feedback message for the LLM.
   */
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
