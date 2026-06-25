/**
 * Structured Output module — JSON Schema-constrained output generation.
 *
 * Enforces structured output from LLM responses through:
 * 1. A `generate_structured` tool that wraps LLM calls with JSON Schema constraints
 * 2. Response validation against provided schemas
 * 3. Automatic retry with error feedback when output doesn't match schema
 * 4. Support for both OpenAI-style `response_format` and prompt-based enforcement
 *
 * @module structured-output
 * @public
 */
export {
  createStructuredOutputTool,
  structuredOutputTool,
  type StructuredOutputInput,
  type StructuredOutputResult,
  type StructuredOutputToolOptions,
} from './structured-output-tool.js';

export {
  validateJsonSchema,
  generateSchemaDescription,
  mergeSchemas,
  type SchemaValidationResult,
  type JsonSchema,
} from './schema-validator.js';

export {
  buildStructuredOutputSystemPrompt,
  type StructuredOutputPromptOptions,
} from './structured-output-prompt.js';

export {
  StructuredOutputEnforcer,
  type EnforcerConfig,
  type EnforceResult,
} from './output-enforcer.js';
