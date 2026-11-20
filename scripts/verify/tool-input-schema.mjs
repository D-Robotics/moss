#!/usr/bin/env node
/** Offline checks of the real tool execution boundary; no tool side effects or provider requests. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);
await load('safety/tool-output-redact.js');
const { validateToolInputObject, registerPreToolHook, clearPreToolHooksForTests } = await load(
  'core/tools/tool-pipeline.js'
);
const { executeOneToolCall } = await load('core/tools/execute-tool-call.js');
const { ToolHookRegistry } = await load('core/tools/tool-hooks.js');
const { buildProviderToolDeclarations } = await load('core/loop/agent-loop-context-prep.js');
let checks = 0;
const ok = (label) => console.log(`[tool-input-schema] ok ${++checks} ${label}`);
const make = (schema, extra = {}) => ({
  name: 'schema_probe',
  description: 'Validate an input without running any real action.',
  inputSchema: schema,
  execute: async () => 'probe_noop',
  ...extra,
});
const nested = {
  type: 'object',
  properties: {
    timeoutMs: { type: 'integer', minimum: 3, maximum: 20 },
    topics: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    image: {
      type: 'object',
      properties: { kind: { const: 'url' }, url: { type: 'string', format: 'uri' } },
      required: ['kind', 'url'],
      additionalProperties: false,
    },
  },
  required: ['timeoutMs', 'topics', 'image'],
  additionalProperties: false,
};
const good = {
  timeoutMs: 8,
  topics: ['/image_raw'],
  image: { kind: 'url', url: 'https://example.invalid/image' },
};
const tool = make(nested);
for (const input of [
  { ...good, topics: [123] },
  { ...good, topics: [''] },
  { ...good, timeoutMs: 2 },
  { ...good, timeoutMs: 21 },
  { ...good, image: {} },
  { ...good, image: { ...good.image, secret: 'credential-value' } },
  { ...good, image: { kind: 'url', url: 'not a URI' } },
  { ...good, unexpected: true },
])
  assert.equal(validateToolInputObject(tool, input).ok, false);
assert.equal(validateToolInputObject(tool, good).ok, true);
ok('recursive arrays, object fields, ranges, formats and extra properties');

const aliasTool = make({
  type: 'object',
  properties: { timeoutMs: { type: 'integer' }, path: { type: 'string' } },
  required: ['timeoutMs', 'path'],
  additionalProperties: false,
});
assert.deepEqual(validateToolInputObject(aliasTool, { timeout_ms: 5, file_path: 'a' }), {
  ok: true,
  value: { timeoutMs: 5, path: 'a' },
});
const permissive = make({ type: 'object', properties: {} });
assert.deepEqual(validateToolInputObject(permissive, { extra: 1 }).value, { extra: 1 });
const noMutation = make({ type: 'object', properties: { count: { type: 'integer', default: 2 } } });
const blank = {};
assert.equal(validateToolInputObject(noMutation, blank).ok, true);
assert.deepEqual(blank, {});
assert.equal(validateToolInputObject(noMutation, { count: '2' }).ok, false);
ok('aliases remain accepted; defaults, coercion and extra-key removal stay disabled');

const combinators = make({
  type: 'object',
  properties: {
    remotePath: { type: 'string' },
    remote_path: { type: 'string' },
    localPath: { type: 'string' },
    attachmentId: { type: 'string' },
  },
  allOf: [
    { anyOf: [{ required: ['remotePath'] }, { required: ['remote_path'] }] },
    { anyOf: [{ required: ['localPath'] }, { required: ['attachmentId'] }] },
  ],
});
assert.equal(validateToolInputObject(combinators, {}).ok, false);
assert.equal(
  validateToolInputObject(combinators, { remote_path: '/a', attachmentId: 'a' }).ok,
  true
);
assert.equal(
  validateToolInputObject(combinators, {
    remotePath: '/a',
    remote_path: '/b',
    localPath: 'a',
    attachmentId: 'a',
  }).ok,
  true
);
const union = make({
  type: 'object',
  properties: { value: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
});
assert.equal(validateToolInputObject(union, { value: true }).ok, false);
const refs = make({
  type: 'object',
  properties: { value: { $ref: '#/$defs/positive' } },
  $defs: { positive: { type: 'number', exclusiveMinimum: 0 } },
});
assert.equal(validateToolInputObject(refs, { value: 0 }).ok, false);
assert.equal(validateToolInputObject(refs, { value: 1 }).ok, true);
ok('anyOf/allOf/oneOf and document-local references');

for (const schema of [
  combinators.inputSchema,
  refs.inputSchema,
  {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'number' },
      workingDir: { type: 'string' },
    },
    minProperties: 3,
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { command: { type: 'string' }, workingDir: { type: 'string' } },
    propertyNames: { pattern: 'working|command' },
  },
  {
    type: 'object',
    properties: { command: { $dynamicRef: '#entry' }, workingDir: { type: 'string' } },
  },
  {
    type: 'object',
    properties: { command: { $recursiveRef: '#' }, workingDir: { type: 'string' } },
  },
  {
    type: 'object',
    properties: { command: { type: 'string' }, requiredByHost: { type: 'string' } },
    required: ['requiredByHost'],
  },
]) {
  const sameNameTool = { ...make(schema), name: 'exec' };
  for (const contextWindowTokens of [32000, 200000]) {
    const wire = buildProviderToolDeclarations([sameNameTool], { contextWindowTokens })[0]
      .parameters;
    assert.deepEqual(wire, schema);
  }
}
ok('lean and wide provider declarations retain composition, references and host-required fields');

for (const [dialect, props] of [
  ['https://json-schema.org/draft/2019-09/schema', { items: { type: 'integer' } }],
  [
    'https://json-schema.org/draft/2020-12/schema',
    { prefixItems: [{ type: 'integer' }], items: false },
  ],
]) {
  const dialectTool = make({
    $schema: dialect,
    type: 'object',
    properties: { values: { type: 'array', ...props } },
  });
  assert.equal(validateToolInputObject(dialectTool, { values: [1] }).ok, true);
  assert.equal(validateToolInputObject(dialectTool, { values: ['wrong'] }).ok, false);
}
ok('explicit 2019-09 and 2020-12 dialects are validated');

for (const schema of [
  { type: 'object', properties: { value: { type: 'not-a-type' } } },
  { type: 'object', properties: { value: { $ref: 'https://example.invalid/never-load' } } },
  { type: 'object', properties: {}, $async: true },
  { type: 'object', properties: { value: { type: () => 'string' } } },
])
  assert.equal(validateToolInputObject(make(schema), {}).ok, false);
const mutableSchema = { type: 'object', properties: { value: { type: 'string' } } };
const mutableTool = make(mutableSchema);
assert.equal(validateToolInputObject(mutableTool, { value: 'x' }).ok, true);
mutableSchema.properties.value.minLength = 2;
assert.equal(validateToolInputObject(mutableTool, { value: 'x' }).ok, false);
ok('invalid, asynchronous and unresolved schemas fail closed; changed schemas recompile');

const parser = {
  safeParse: (input) =>
    typeof input.value === 'string' || typeof input.value === 'number'
      ? { success: true, data: { ...input, value: Number(input.value) } }
      : { success: false, error: { issues: [{ message: 'credential-value' }] } },
};
const parsedTool = make(
  { type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'] },
  { inputZodSchema: parser }
);
assert.deepEqual(validateToolInputObject(parsedTool, { value: '2' }), {
  ok: true,
  value: { value: 2 },
});
assert.equal(validateToolInputObject(parsedTool, { value: '0' }).ok, false);
assert.match(
  validateToolInputObject(parsedTool, { value: false }).message,
  /properties\/value\/type/
);
const badParser = make(
  { type: 'object', properties: {} },
  {
    inputZodSchema: { safeParse: () => ({ success: false, error: new Error('credential-value') }) },
  }
);
assert.equal(validateToolInputObject(badParser, {}).ok, false);
assert.ok(!validateToolInputObject(badParser, {}).message.includes('credential-value'));
const thrownParser = make(
  { type: 'object', properties: {} },
  {
    inputZodSchema: {
      safeParse: () => {
        throw new Error('credential-value');
      },
    },
  }
);
assert.equal(validateToolInputObject(thrownParser, {}).ok, false);
assert.ok(!validateToolInputObject(thrownParser, {}).message.includes('credential-value'));
const asyncParser = make(
  { type: 'object', properties: {} },
  {
    inputZodSchema: {
      safeParse: async () => {
        throw new Error('credential-value');
      },
    },
  }
);
assert.equal(validateToolInputObject(asyncParser, {}).ok, false);
await new Promise((resolve) => setImmediate(resolve));
const driftParser = make(
  { type: 'object', properties: { value: { type: 'integer' } } },
  {
    inputZodSchema: { safeParse: (input) => ({ success: true, data: { value: input.value + 1 } }) },
  }
);
assert.equal(validateToolInputObject(driftParser, { value: 1 }).ok, false);
const mutatingParser = make(
  { type: 'object', properties: { value: { type: 'integer' } } },
  {
    inputZodSchema: {
      safeParse: (input) => {
        input.value++;
        return { success: true, data: input };
      },
    },
  }
);
const untouched = { value: 1 };
assert.equal(validateToolInputObject(mutatingParser, untouched).ok, false);
assert.deepEqual(untouched, { value: 1 });
ok('explicit pure parser normalization is checked against JSON Schema and must be idempotent');

let executed = 0;
const invoke = async (input, options = {}) =>
  executeOneToolCall(
    { id: 'schema-call', name: tool.name, input },
    {
      toolsForRun: [
        {
          ...tool,
          execute: async () => {
            executed++;
            return 'probe_noop';
          },
        },
      ],
      toolCtx: { workspaceDir: root, sessionKey: 'schema-probe' },
      sessionKey: 'schema-probe',
      abortSignal: new AbortController().signal,
      toolTimeoutMs: 1000,
      enableHeartbeat: false,
      heartbeatIntervalMs: 1000,
      skipHeartbeatToolNames: new Set(),
      push: () => {},
      ...options,
    }
  );
assert.equal((await invoke({ ...good, topics: [123] })).kind, 'pre-blocked');
const remove = registerPreToolHook(async () => ({ ok: true, input: { ...good, timeoutMs: 0 } }));
assert.equal((await invoke(good)).kind, 'pre-blocked');
remove();
const hooks = new ToolHookRegistry();
hooks.registerPre({
  name: 'rewrite',
  priority: 1,
  check: async () => ({ action: 'modify', input: { ...good, image: {} } }),
});
assert.equal((await invoke(good, { toolHooks: hooks })).kind, 'pre-blocked');
assert.equal(
  (
    await invoke(good, {
      checkToolApproval: async () => ({
        approved: true,
        decision: 'allow-once',
        updatedInput: { ...good, topics: [123] },
      }),
    })
  ).kind,
  'pre-blocked'
);
assert.equal(executed, 0);
assert.equal((await invoke(good)).isError, false);
assert.equal(executed, 1);
clearPreToolHooksForTests();
ok('direct calls and global/tool/approval rewrites are checked before execution');
console.log(`[tool-input-schema] ${checks} groups passed`);
