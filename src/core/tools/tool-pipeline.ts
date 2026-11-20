import type { Tool } from './tool-types.js';
import { isDeepStrictEqual } from 'node:util';
import { validateToolJsonSchema } from './tool-input-schema.js';

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
  const schema = tool.inputSchema;
  if (!schema || schema.type !== 'object') {
    return { ok: false, message: `${tool.name}: invalid or unsupported input schema` };
  }
  const props = schema.properties as Record<string, JsonSchemaProperty>;
  // Alias compatibility precedes both parsers and recursive schema validation.
  let value = props ? snapParamAliases(obj, props) : obj;
  if (tool.inputZodSchema) {
    const parserFailure = () => {
      const jsonCheck = validateToolJsonSchema(tool.name, schema, value);
      return jsonCheck.ok
        ? { ok: false as const, message: `${tool.name}: tool input failed its input parser` }
        : jsonCheck;
    };
    try {
      const parsed = tool.inputZodSchema.safeParse(structuredClone(value));
      if (parsed && typeof parsed === 'object' && 'then' in parsed) {
        // JS hosts can violate the synchronous parser interface. Consume a
        // rejected promise without awaiting it or letting it reach execution.
        void Promise.resolve(parsed as unknown).catch(() => undefined);
        return parserFailure();
      }
      if (
        !parsed.success ||
        parsed.data === null ||
        typeof parsed.data !== 'object' ||
        Array.isArray(parsed.data)
      ) {
        return parserFailure();
      }
      const stable = tool.inputZodSchema.safeParse(structuredClone(parsed.data));
      if (stable && typeof stable === 'object' && 'then' in stable) {
        void Promise.resolve(stable as unknown).catch(() => undefined);
        return parserFailure();
      }
      if (!stable.success || !isDeepStrictEqual(parsed.data, stable.data)) {
        return { ok: false, message: `${tool.name}: input parser must be idempotent` };
      }
      value = parsed.data as Record<string, unknown>;
    } catch {
      return parserFailure();
    }
  }
  const checked = validateToolJsonSchema(tool.name, schema, value);
  if (!checked.ok) return checked;
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
