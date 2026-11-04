/**
 * Installs tool output declarations where the execution loop can read them.
 *
 * The budget and the recovery hint belong to the tool (`ToolMetadata`), not to a
 * table keyed by name: a table drifts the moment a name changes or a tool is
 * added, which is how `read_file` silently ran with the 4k default (audit B8).
 * This module is the only place that reads `maxResultTokens` / `truncationHint`
 * and pushes them into the inner context layer's registry.
 */
import type { Tool } from './tool-types.js';
import { registerToolOutputDeclarations } from '../../context/tool-output-truncate.js';

export interface ToolOutputDeclaration {
  name: string;
  maxTokens?: number;
  hint?: string;
}

/** The declaration a single tool makes, or `null` when it takes the default. */
export function toolOutputDeclarationFor(tool: Tool): ToolOutputDeclaration | null {
  const maxTokens = tool.metadata?.maxResultTokens;
  const hint = tool.metadata?.truncationHint;
  if (maxTokens === undefined && hint === undefined) return null;
  return {
    name: tool.name,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(hint ? { hint } : {}),
  };
}

/**
 * Copy every tool's output declaration into the context registry. Idempotent:
 * called once from `builtinTools` module init, so both the CLI and SDK hosts get
 * the declared budgets without a call site remembering to register them.
 */
export function installToolOutputDeclarations(tools: readonly Tool[]): void {
  const specs = tools
    .map((tool) => toolOutputDeclarationFor(tool))
    .filter((spec): spec is ToolOutputDeclaration => spec !== null);
  if (specs.length > 0) registerToolOutputDeclarations(specs);
}
