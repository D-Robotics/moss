#!/usr/bin/env node
/**
 * schema-validator — depth guard + key-order-insensitive equality.
 *
 * The subsystem previously had zero tests. These pin down two fixes:
 *  (1) `validateJsonSchema` is purely recursive with no depth limit — a
 *      pathologically deep LLM-provided schema overflowed the call stack
 *      (RangeError). Now capped at MAX_SCHEMA_DEPTH (64).
 *  (2) `deepEqual` used JSON.stringify, so `enum`/`const` checks were
 *      key-order-sensitive — `{a:1,b:2}` and `{b:2,a:1}` compared unequal and
 *      valid output was falsely rejected. Now a proper structural compare.
 */
import assert from 'node:assert/strict';
import {
  validateJsonSchema,
  validateJsonSchemaDefinition,
  MAX_SCHEMA_DEPTH,
} from '../dist/structured-output/schema-validator.js';

// ─── 1. deepEqual is key-order-insensitive (enum / const) ───────────────────
{
  // Same object, different key order — must match.
  const schema = { enum: [{ a: 1, b: 2 }] };
  const result = validateJsonSchema({ b: 2, a: 1 }, schema);
  assert.equal(result.valid, true, 'enum match is key-order-insensitive');
}
{
  // const with nested object, different key order.
  const schema = { const: { outer: { x: 1, y: 2 } } };
  const result = validateJsonSchema({ outer: { y: 2, x: 1 } }, schema);
  assert.equal(result.valid, true, 'const match is key-order-insensitive (nested)');
}
{
  // Genuinely different objects still mismatch.
  const result = validateJsonSchema({ a: 1, b: 3 }, { enum: [{ a: 1, b: 2 }] });
  assert.equal(result.valid, false, 'a real value mismatch still fails');
}

// ─── 2. pathologically deep schema does not overflow the stack ─────────────
{
  // Build a schema + value nested far deeper than MAX_SCHEMA_DEPTH. Without
  // the depth guard this would recurse ~1000 frames and hit RangeError; with
  // the guard it returns a clean "max depth" error at depth 64.
  let schema = { type: 'string' };
  let value = 'x';
  for (let i = 0; i < 1000; i++) {
    schema = { type: 'object', properties: { a: schema } };
    value = { a: value };
  }
  const result = validateJsonSchema(value, schema);
  assert.equal(result.valid, false, 'over-depth schema is rejected, not stack-overflowed');
  assert.ok(
    /max depth/i.test(result.errors.map((e) => e.message).join(' ')),
    'error message mentions max depth',
  );
}

// ─── 3. schemas at the boundary (<= MAX_SCHEMA_DEPTH) still validate ───────
{
  // A schema exactly at the limit must NOT trip the guard.
  let schema = { type: 'string' };
  let value = 'ok';
  for (let i = 0; i < MAX_SCHEMA_DEPTH; i++) {
    schema = { type: 'object', properties: { a: schema } };
    value = { a: value };
  }
  const result = validateJsonSchema(value, schema);
  assert.equal(result.valid, true, `schema at depth ${MAX_SCHEMA_DEPTH} validates normally`);
}

// ─── 4. declared JSON Schema features are enforced, not silently ignored ──
{
  const schema = {
    $ref: '#/$defs/Profile',
    $defs: {
      Profile: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  };
  assert.equal(validateJsonSchema({ name: 'Ada' }, schema).valid, true);
  assert.equal(
    validateJsonSchema({ age: 30 }, schema).valid,
    false,
    'local $ref applies the referenced schema',
  );
  assert.equal(
    validateJsonSchema({}, { $ref: '#/$defs/Missing', $defs: {} }).valid,
    false,
    'an unresolved local $ref fails closed',
  );
  assert.equal(
    validateJsonSchema(null, schema).valid,
    false,
    'a referenced non-null schema cannot be bypassed by the null fast path',
  );
}
{
  assert.equal(
    validateJsonSchema({ unexpected: true }, { type: 'object', additionalProperties: false }).valid,
    false,
    'additionalProperties false rejects every property when none are declared',
  );
  assert.equal(
    validateJsonSchema(
      [{ a: 1, b: 2 }, { b: 2, a: 1 }],
      { type: 'array', uniqueItems: true },
    ).valid,
    false,
    'uniqueItems compares objects independent of key order',
  );
  assert.equal(
    validateJsonSchema(
      ['first', 42, { unconstrained: true }],
      { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
    ).valid,
    true,
    'tuple items do not incorrectly reuse the final schema for extra elements',
  );
}
{
  assert.equal(validateJsonSchemaDefinition({ type: 'string', pattern: '[' }).valid, false);
  assert.equal(validateJsonSchemaDefinition({ type: 'string', format: 'custom' }).valid, false);
  assert.equal(validateJsonSchemaDefinition({ type: 'object', minProperties: 1 }).valid, false);
  assert.equal(
    validateJsonSchemaDefinition({ type: 'object', 'x-provider-hint': true }).valid,
    true,
    'extension annotations remain allowed',
  );
  assert.equal(
    validateJsonSchema('value', { type: 'string', format: 'custom' }).valid,
    false,
    'the public validator rejects unsupported constraints instead of ignoring them',
  );
}
{
  assert.equal(validateJsonSchema(null, { type: 'null' }).valid, true);
  assert.equal(validateJsonSchema(null, { type: ['string', 'null'] }).valid, true);
  assert.equal(validateJsonSchema(null, { type: 'string' }).valid, false);
  assert.equal(validateJsonSchema(3, { type: 'integer' }).valid, true);
  assert.equal(
    validateJsonSchema(3.5, { type: 'integer' }).valid,
    false,
    'integer rejects fractional numbers',
  );
}
{
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: { type: 'number' },
  };
  assert.equal(validateJsonSchema({ name: 'Ada', score: 10 }, schema).valid, true);
  assert.equal(
    validateJsonSchema({ name: 'Ada', score: 'high' }, schema).valid,
    false,
    'schema-valued additionalProperties validates unknown properties',
  );
}

console.log('  [PASS] schema-validator: depth, equality, refs, integers, and additional properties');
