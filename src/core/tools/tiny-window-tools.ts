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
