#!/usr/bin/env node
/**
 * Parameter names are matched across harness spellings. A model trained on
 * another harness emits `timeoutMs` / `multiSelect`; Moss declares
 * `timeout_ms` / `multi_select`. An ignored key used to mean the call silently
 * ran with the default the model thought it had overridden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateToolInputObject } from '../dist/core/tools/tool-pipeline.js';

function tool(properties, required = []) {
  return {
    name: 'demo',
    description: 'demo',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties, required },
    async execute() {
      return 'ok';
    },
  };
}

test('tool input: a declared key keeps its value and wins over the alias', () => {
  const spec = tool({ timeout_ms: { type: 'number' } });
  const declared = validateToolInputObject(spec, { timeout_ms: 5000 });
  assert.deepEqual(declared, { ok: true, value: { timeout_ms: 5000 } });

  const both = validateToolInputObject(spec, { timeout_ms: 5000, timeoutMs: 1 });
  assert.deepEqual(both, { ok: true, value: { timeout_ms: 5000, timeoutMs: 1 } });
});

test('tool input: casing and dash aliases snap onto the declared parameter', () => {
  const spec = tool({ timeout_ms: { type: 'number' }, multi_select: { type: 'boolean' } });
  const camel = validateToolInputObject(spec, { timeoutMs: 5000, multiSelect: true });
  assert.deepEqual(camel, { ok: true, value: { timeout_ms: 5000, multi_select: true } });

  const dashed = validateToolInputObject(spec, { 'timeout-ms': 700 });
  assert.deepEqual(dashed, { ok: true, value: { timeout_ms: 700 } });
});

test('tool input: aliasing satisfies a required parameter', () => {
  const spec = tool({ timeout_ms: { type: 'number' } }, ['timeout_ms']);
  const result = validateToolInputObject(spec, { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: true, value: { timeout_ms: 5000 } });

  const missing = validateToolInputObject(spec, { timeoutMilliseconds: 5000 });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /missing required parameter "timeout_ms"/);
});

test('tool input: a snapped value is still type-checked', () => {
  const spec = tool({ timeout_ms: { type: 'number' } });
  const bad = validateToolInputObject(spec, { timeoutMs: 'soon' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /parameter "timeout_ms" should be number/);
});

test('tool input: unrelated keys stay untouched', () => {
  const spec = tool({ path: { type: 'string' }, paths: { type: 'array' } });
  const result = validateToolInputObject(spec, { path: 'a', files: ['b'] });
  assert.deepEqual(result, { ok: true, value: { path: 'a', files: ['b'] } });
});

test('tool input: file_path and str_replace spellings snap onto the Moss names', () => {
  const read = tool({ path: { type: 'string' } }, ['path']);
  assert.deepEqual(validateToolInputObject(read, { file_path: 'src/a.ts' }), {
    ok: true,
    value: { path: 'src/a.ts' },
  });

  const edit = tool(
    { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    ['path', 'old_string', 'new_string']
  );
  assert.deepEqual(validateToolInputObject(edit, { path: 'a', old_str: 'x', new_str: 'y' }), {
    ok: true,
    value: { path: 'a', old_string: 'x', new_string: 'y' },
  });
});
