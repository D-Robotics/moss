import type { Tool } from './tool-types.js';

export type PreToolHookContext = {
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
};

export type PreToolHookResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; message: string };

export type PreToolHook = (ctx: PreToolHookContext) => Promise<PreToolHookResult>;

const preToolHooks: PreToolHook[] = [];

export function registerPreToolHook(hook: PreToolHook): () => void {
  preToolHooks.push(hook);
  return () => {
    const i = preToolHooks.indexOf(hook);
    if (i !== -1) preToolHooks.splice(i, 1);
  };
}

export function clearPreToolHooksForTests(): void {
  preToolHooks.length = 0;
}

type JsonSchemaProperty = {
  type?: string;
  enum?: unknown[];
};

/** `timeoutMs`, `timeout_ms`, and `TIMEOUT-MS` name the same parameter. */
function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

/**
 * Same parameter, different name — the normalization above cannot join these.
 * Claude Code's Read/Write/Edit declare `file_path`; Anthropic's str_replace_editor
 * declares `old_str`/`new_str`. Moss declares `path`/`old_string`/`new_string`,
 * so a model following the habit lost the whole turn to
 * `missing required parameter "path"`.
 */
const CROSS_HARNESS_PARAM_ALIASES: Record<string, string> = {
  filepath: 'path',
  oldstr: 'old_string',
  newstr: 'new_string',
};

/**
 * Models are trained across harnesses and emit the other harness's spelling
 * (Qoder asks for `multiSelect`; Moss declares `multi_select`). A misspelled key
 * is otherwise dropped silently, so the call runs with a default the model
 * believes it overrode. Snap an undeclared key onto the declared one it names.
 */
function snapParamAliases(
  input: Record<string, unknown>,
  props: Record<string, JsonSchemaProperty>
): Record<string, unknown> {
  const declared = Object.keys(props);
  if (declared.length === 0) return input;
  const byNormalized = new Map<string, string>();
  for (const name of declared) byNormalized.set(normalizeParamName(name), name);
  let snapped: Record<string, unknown> | null = null;
  for (const key of Object.keys(input)) {
    if (props[key]) continue;
    const normalized = normalizeParamName(key);
    const alias = CROSS_HARNESS_PARAM_ALIASES[normalized];
    const target = byNormalized.get(normalized) ?? (alias && props[alias] ? alias : undefined);
    if (!target || input[target] !== undefined) continue;
    snapped ??= { ...input };
    snapped[target] = input[key];
    delete snapped[key];
  }
  return snapped ?? input;
}

export function validateToolInputObject(
  tool: Tool,
  input: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: `${tool.name}: tool input must be a JSON object` };
  }
  const obj = input as Record<string, unknown>;
  const schema = tool.inputSchema as
    | {
        type?: string;
        required?: string[];
        properties?: Record<string, JsonSchemaProperty>;
      }
    | undefined;
  if (!schema || schema.type !== 'object') {
    return { ok: true, value: obj };
  }
  const props = schema.properties;
  // Snap before the required check so `{ timeOutMs: 5000 }` can satisfy
  // `required: ['timeout_ms']`.
  const value = props ? snapParamAliases(obj, props) : obj;
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      return { ok: false, message: `${tool.name}: missing required parameter "${key}"` };
    }
  }
  if (props) {
    for (const key of Object.keys(value)) {
      const spec = props[key];
      if (!spec) continue;
      const v = value[key];
      if (v === undefined) continue;
      if (spec.enum !== undefined && spec.enum.length > 0) {
        if (!spec.enum.some((e) => Object.is(e, v))) {
          // Name the allowed values: "must be one of the enum values" made the
          // model guess a second time.
          return {
            ok: false,
            message:
              `${tool.name}: parameter "${key}" must be one of ` +
              `${spec.enum.map((e) => JSON.stringify(e)).join(', ')} (got ${JSON.stringify(v)})`,
          };
        }
        continue;
      }
      if (!spec.type) continue;
      const t = spec.type;
      if (t === 'string' && typeof v !== 'string')
        return { ok: false, message: `${tool.name}: parameter "${key}" should be string` };
      if (t === 'number' && (typeof v !== 'number' || Number.isNaN(v)))
        return { ok: false, message: `${tool.name}: parameter "${key}" should be number` };
      if (t === 'integer' && (typeof v !== 'number' || !Number.isInteger(v)))
        return { ok: false, message: `${tool.name}: parameter "${key}" should be integer` };
      if (t === 'boolean' && typeof v !== 'boolean')
        return { ok: false, message: `${tool.name}: parameter "${key}" should be boolean` };
      if (t === 'array' && !Array.isArray(v))
        return { ok: false, message: `${tool.name}: parameter "${key}" should be array` };
      if (t === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v)))
        return { ok: false, message: `${tool.name}: parameter "${key}" should be object` };
    }
  }
  return { ok: true, value };
}

export async function runPreToolHookChain(
  toolName: string,
  input: Record<string, unknown>,
  sessionKey: string
): Promise<PreToolHookResult> {
  let current: Record<string, unknown> = { ...input };
  for (const hook of preToolHooks) {
    const r = await hook({ toolName, input: current, sessionKey });
    if (!r.ok) return r;
    current = { ...r.input };
  }
  return { ok: true, input: current };
}
