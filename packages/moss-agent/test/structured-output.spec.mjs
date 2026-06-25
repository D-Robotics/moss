#!/usr/bin/env node
/**
 * Test: Structured Output module — schema validation, enforcer, and tool.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/structured-output.spec.mjs
 */
import assert from 'node:assert/strict';
import { builtinTools } from '../dist/tools/builtin.js';
import {
  validateJsonSchema,
  generateSchemaDescription,
  mergeSchemas,
  StructuredOutputEnforcer,
  createStructuredOutputTool,
  buildStructuredOutputSystemPrompt,
} from '../dist/structured-output/index.js';

// 1. Tool is in builtin tools
const names = builtinTools.map((t) => t.name);
assert.ok(names.includes('generate_structured'), 'builtin tools should include generate_structured');

// 2. Schema validation — basic types
assert.equal(validateJsonSchema('hello', { type: 'string' }).valid, true);
assert.equal(validateJsonSchema(42, { type: 'string' }).valid, false);
assert.equal(validateJsonSchema(42, { type: 'number' }).valid, true);
assert.equal(validateJsonSchema(true, { type: 'boolean' }).valid, true);
assert.equal(validateJsonSchema(null, { type: 'null' }).valid, true);
assert.equal(validateJsonSchema([1, 2, 3], { type: 'array' }).valid, true);
assert.equal(validateJsonSchema({ a: 1 }, { type: 'object' }).valid, true);

// 3. Schema validation — object with required properties
const personSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
  required: ['name'],
};

assert.equal(validateJsonSchema({ name: 'Alice', age: 30 }, personSchema).valid, true);
const missingName = validateJsonSchema({ age: 30 }, personSchema);
assert.equal(missingName.valid, false);
assert.ok(missingName.errors.some((e) => e.message.includes('name')), 'should report missing name');

// 4. Schema validation — enum
const colorSchema = { type: 'string', enum: ['red', 'green', 'blue'] };
assert.equal(validateJsonSchema('red', colorSchema).valid, true);
assert.equal(validateJsonSchema('yellow', colorSchema).valid, false);

// 5. Schema validation — array with items
const stringArraySchema = { type: 'array', items: { type: 'string' } };
assert.equal(validateJsonSchema(['a', 'b'], stringArraySchema).valid, true);
assert.equal(validateJsonSchema(['a', 1], stringArraySchema).valid, false);

// 6. Schema validation — string constraints
assert.equal(validateJsonSchema('ab', { type: 'string', minLength: 3 }).valid, false);
assert.equal(validateJsonSchema('abc', { type: 'string', minLength: 3 }).valid, true);
assert.equal(validateJsonSchema('test@example.com', { type: 'string', format: 'email' }).valid, true);
assert.equal(validateJsonSchema('not-an-email', { type: 'string', format: 'email' }).valid, false);

// 7. Schema validation — number constraints
assert.equal(validateJsonSchema(5, { type: 'number', minimum: 10 }).valid, false);
assert.equal(validateJsonSchema(15, { type: 'number', minimum: 10, maximum: 20 }).valid, true);

// 8. Schema validation — additionalProperties
const strictSchema = {
  type: 'object',
  properties: { name: { type: 'string' } },
  additionalProperties: false,
};
assert.equal(validateJsonSchema({ name: 'Alice', extra: true }, strictSchema).valid, false);

// 9. generateSchemaDescription
const desc = generateSchemaDescription(personSchema);
assert.ok(desc.includes('name'), 'should describe name property');
assert.ok(desc.includes('required'), 'should mark required fields');

// 10. mergeSchemas
const schemaA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
const schemaB = { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] };
const merged = mergeSchemas([schemaA, schemaB]);
assert.ok(merged.properties?.a, 'should have property a');
assert.ok(merged.properties?.b, 'should have property b');
assert.ok(merged.required?.includes('a'), 'should require a');
assert.ok(merged.required?.includes('b'), 'should require b');

// 11. StructuredOutputEnforcer
const enforcer = new StructuredOutputEnforcer({
  schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
});

// Valid response
const validResult = enforcer.enforce('```json\n{"result": "success"}\n```');
assert.equal(validResult.valid, true);
assert.deepEqual(validResult.data, { result: 'success' });

// Invalid response (missing required field)
const invalidResult = enforcer.enforce('```json\n{"other": "value"}\n```');
assert.equal(invalidResult.valid, false);
assert.ok(invalidResult.retryFeedback, 'should provide retry feedback');
assert.ok(invalidResult.retryFeedback.includes('result'), 'feedback should mention missing field');

// No JSON response
const noJsonResult = enforcer.enforce('This is just plain text with no JSON.');
assert.equal(noJsonResult.valid, false);

// Auto-repair: add defaults
const repairEnforcer = new StructuredOutputEnforcer({
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', default: 'unknown' },
    },
    required: ['name'],
  },
  autoRepair: true,
});
const repairResult = repairEnforcer.enforce('```json\n{}\n```');
assert.equal(repairResult.valid, true);
assert.deepEqual(repairResult.data, { name: 'unknown' });

// 12. Structured output tool
const tool = builtinTools.find((t) => t.name === 'generate_structured');
assert.ok(tool, 'generate_structured tool should be registered');

const toolResult = await tool.execute(
  {
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    prompt: 'What is 2+2?',
  },
  { workspaceDir: '/tmp', sessionKey: 'structured-test' },
);
assert.ok(toolResult.includes('Expected Schema'), 'should include schema');
assert.ok(toolResult.includes('Generation Prompt'), 'should include prompt');

// Validate-only mode
const validateResult = await tool.execute(
  {
    schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    prompt: 'test',
    output: '{"x": 42}',
    validateOnly: true,
  },
  { workspaceDir: '/tmp', sessionKey: 'structured-validate' },
);
assert.ok(validateResult.includes('valid'), 'should indicate validity');

// 13. System prompt
const prompt = buildStructuredOutputSystemPrompt({ structuredOutputEnabled: true });
assert.ok(prompt.includes('generate_structured'), 'prompt should mention generate_structured');
assert.ok(prompt.includes('JSON Schema'), 'prompt should mention JSON Schema');

console.log('[PASS] Structured Output module: validation, enforcement, and tool work correctly');
