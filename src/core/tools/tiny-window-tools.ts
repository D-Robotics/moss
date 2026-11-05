/**
 * B66: a model whose window cannot even host the standard tool surface.
 *
 * Every tool declaration is paid on every request. On a 4k window (Ollama's
 * default for many local models) the full/lean surface alone is ~4.3k estimated
 * prompt tokens -- more than the whole window -- so the first turn dies on a
 * gateway context-length error before the model can do anything. Below the
 * threshold the run gets a core surface (read, search, edit, run, plan) and no
 * other builtin/MCP declarations; `tool_search` stays so a run that needs
 * something else can still reveal it, paying for that declaration only then.
 *
 * Reference: Cursor / Claude Code both ship reduced tool sets for constrained
 * contexts rather than failing the turn.
 */

/** Windows at or below which the minimal surface turns on by itself. */
export const TINY_WINDOW_AUTO_CONTEXT_TOKENS = 6_000;

/**
 * Tools that stay offered on a tiny window. Keep this list small: every entry is
 * paid per request, and the whole point is to leave room for the actual work.
 */
export const TINY_WINDOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  'exec',
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
]);

function envFlag(value: string | undefined): boolean | undefined {
  if (value == null || value === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Whether this run should offer only the tiny-window tool surface.
 * `MOSS_TINY_WINDOW_TOOLS=1|0` forces it on/off (probes, debugging).
 */
export function tinyWindowToolSurfaceEnabled(params: {
  effectiveContextTokens?: number;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const forced = envFlag((params.env ?? process.env).MOSS_TINY_WINDOW_TOOLS);
  if (forced !== undefined) return forced;
  const budget = params.effectiveContextTokens;
  return typeof budget === 'number' && budget > 0 && budget <= TINY_WINDOW_AUTO_CONTEXT_TOKENS;
}

export function toolAllowedOnTinyWindow(name: string): boolean {
  return TINY_WINDOW_TOOL_NAMES.has(name);
}

/**
 * B72: on a tiny window these five declarations are ~26% of the whole prompt,
 * and most of that is prose. Keep the constraint the model needs per tool and
 * drop the enumerations -- they mostly name tools this surface does not offer.
 */
const TINY_WINDOW_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  exec: 'Run a shell command (cwd does not persist; use absolute paths, no cd).',
  read_file:
    'Read a file with line numbers; page with offset (1-based) and limit. Do not copy the line numbers into edits.',
  write_file: 'Create or overwrite a file with the full content.',
  edit_file:
    'Replace an exact string in an existing file. read_file it first; include no line-number prefixes.',
  list_directory: 'List one directory level.',
};

export function tinyWindowToolDescription(name: string, description: string | undefined): string {
  return TINY_WINDOW_TOOL_DESCRIPTIONS[name] ?? description ?? '';
}

/**
 * B73: the wire schema is the other half of the declaration cost. On a tiny
 * window the exec/edit_file schemas spend most of their bytes advertising
 * optional modes (background runs, batched edits) that B71's small-context
 * guidance tells the model not to use. Keep the parameters a one-step-at-a-time
 * run needs; the tool still accepts the others when a caller passes them.
 */
const TINY_WINDOW_TOOL_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  exec: ['command', 'timeout_ms'],
  edit_file: ['path', 'old_string', 'new_string', 'replace_all'],
  list_directory: ['path', 'depth'],
};

export function tinyWindowToolSchema(
  name: string,
  schema: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const keep = TINY_WINDOW_TOOL_PROPERTIES[name];
  if (!keep || !schema || typeof schema !== 'object') return schema;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') return schema;
  const pruned: Record<string, unknown> = {};
  for (const key of keep) {
    const value = (properties as Record<string, unknown>)[key];
    if (value !== undefined) pruned[key] = value;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key) => typeof key === 'string' && key in pruned)
    : undefined;
  return {
    ...schema,
    properties: pruned,
    ...(required && required.length > 0 ? { required } : { required: undefined }),
  };
}
