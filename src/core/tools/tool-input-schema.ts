import { Ajv, type ErrorObject, type Options, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const options: Options = {
  strict: false,
  strictNumbers: true,
  allErrors: false,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  addUsedSchema: false,
  logger: false,
};
const dialects = [new Ajv(options), new Ajv2019(options), new Ajv2020(options)];
for (const dialect of dialects) addFormats.default(dialect);

type Compiled = { ok: true; validate: ValidateFunction } | { ok: false };
const cache = new WeakMap<object, { fingerprint: string; compiled: Compiled }>();

function compile(schema: Record<string, unknown>): Compiled {
  try {
    const fingerprint = JSON.stringify(schema, (_key, value: unknown) => {
      if (['function', 'symbol', 'bigint'].includes(typeof value)) {
        throw new Error('Schema must be JSON serializable');
      }
      return value;
    });
    const cached = cache.get(schema);
    if (cached?.fingerprint === fingerprint) return cached.compiled;
    // Snapshot mutable host schemas, and do not retain dynamically registered
    // tool schemas in Ajv's process-wide cache after compilation.
    const snapshot = JSON.parse(fingerprint) as Record<string, unknown>;
    const dialectName = String(snapshot.$schema ?? '');
    const dialect = dialectName.includes('/2020-12/')
      ? dialects[2]
      : dialectName.includes('/2019-09/')
        ? dialects[1]
        : dialects[0];
    let compiled: Compiled;
    try {
      const validate = dialect.compile(snapshot);
      compiled = '$async' in validate ? { ok: false } : { ok: true, validate };
    } finally {
      dialect.removeSchema(snapshot);
    }
    cache.set(schema, { fingerprint, compiled });
    return compiled;
  } catch {
    // Neither schema content nor arbitrary compiler exception text is safe to
    // expose. Unresolved references fail here; no remote loader is configured.
    return { ok: false };
  }
}

function validationMessage(name: string, error: ErrorObject | undefined): string {
  // schemaPath identifies a declared field/rule. instancePath and params can
  // include user-controlled object keys; never copy rejected values or keys.
  const location = (error?.schemaPath ?? '#').slice(0, 200);
  const rule =
    error?.keyword === 'enum' ? 'must be one of the declared enum values' : error?.keyword;
  return `${name}: tool input violates JSON Schema at ${location} (${rule ?? 'validation'})`;
}

export function validateToolJsonSchema(
  name: string,
  schema: Record<string, unknown>,
  input: Record<string, unknown>
): { ok: true } | { ok: false; message: string } {
  const compiled = compile(schema);
  if (!compiled.ok) return { ok: false, message: `${name}: invalid or unsupported input schema` };
  try {
    if (!compiled.validate(input)) {
      return { ok: false, message: validationMessage(name, compiled.validate.errors?.[0]) };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: `${name}: tool input could not be validated` };
  }
}
