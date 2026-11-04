/**
 * The one place that names builtin tool families.
 *
 * `builtinTools` in `src/tools/builtin.ts` is the registration list. This module
 * is the naming contract shared by the run-visibility filter, the loop nudges
 * and the CLI/TUI renderers, so a rename cannot leave a stale string behind in
 * one of them. The surface decisions behind these lists are recorded in
 * `docs/design/tool-surface-rea.md`.
 */

/**
 * Names kept registered for SDK hosts and transcripts recorded before the
 * merge, but never offered to the model: each one duplicates a canonical tool
 * (`multi_edit` → `edit_file` with `edits[]`, `exec_background` → `exec` with
 * `run_in_background`).
 */
export const LEGACY_ALIAS_TOOL_NAMES = ['multi_edit', 'exec_background'] as const;

const LEGACY_ALIASES = new Set<string>(LEGACY_ALIAS_TOOL_NAMES);

export function isLegacyAliasToolName(name: string): boolean {
  return LEGACY_ALIASES.has(name);
}

/** The single shell entry point. Background runs are `exec` + `run_in_background`. */
export const EXEC_TOOL_NAMES = ['exec'] as const;

/** Tool names whose results are shell output, including retired render-only names. */
export const EXEC_LIKE_TOOL_NAMES = ['exec', 'exec_background', 'device_exec'] as const;

/** File mutation tools, in the order the loop should prefer them. */
export const EDIT_TOOL_NAMES = ['edit_file', 'multi_edit', 'apply_patch', 'write_file'] as const;

/** Tools that produce a structured verification verdict. */
export const VERIFY_TOOL_NAMES = ['run_tests'] as const;

export const EXEC_TOOL_NAME_SET: ReadonlySet<string> = new Set(EXEC_TOOL_NAMES);
export const EXEC_LIKE_TOOL_NAME_SET: ReadonlySet<string> = new Set(EXEC_LIKE_TOOL_NAMES);
export const EDIT_TOOL_NAME_SET: ReadonlySet<string> = new Set(EDIT_TOOL_NAMES);
export const VERIFY_TOOL_NAME_SET: ReadonlySet<string> = new Set(VERIFY_TOOL_NAMES);

/**
 * Family sets the builtin tool-surface spec cross-checks against the registered
 * tools. Every name here must exist in `builtinTools`.
 */
export const TOOL_FAMILY_NAMES: Readonly<Record<string, readonly string[]>> = {
  exec: EXEC_TOOL_NAMES,
  execLike: EXEC_LIKE_TOOL_NAMES,
  edit: EDIT_TOOL_NAMES,
  verify: VERIFY_TOOL_NAMES,
};
