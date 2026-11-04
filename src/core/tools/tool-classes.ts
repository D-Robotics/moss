/**
 * Tool classification, read from the tool's own declaration.
 *
 * Six `new Set([...])` tables in `tool-loop-guard.ts` used to decide, by name,
 * which tools are discovery probes, surgical edits, verification shell calls,
 * file mutations, or shell calls. The sets drifted from the registry: 24 of the
 * discovery entries named tools this build does not register (codegraph_*,
 * memory_*, browser/vision tools) and `bash` never existed as a Moss tool. A new
 * tool silently fell into the generic bucket.
 *
 * Now the declaration is the source (`ToolMetadata.classification`), installed
 * here once from the builtin list. The optional-provider names stay as one
 * explicit list: they are not Moss tools, but an MCP server or an embedder can
 * register them, and dropping the classification for those names would make
 * loop-guard treat them as generic on the day they appear.
 */
import type { Tool } from './tool-types.js';

export interface ToolClassification {
  /** More than the generic 3 identical calls per turn are allowed (reads, edits). */
  singleCallExempt?: boolean;
  /** A discovery/observation probe: repeated failures should stop sooner. */
  discovery?: boolean;
  /** Surgical edit whose stale body thrashes per path (edit_file, apply_patch). */
  surgicalEdit?: boolean;
  /** Shell tool whose non-zero exit is a verification result, not a tool failure. */
  verifyShell?: boolean;
  /** Edit/write tool that can lock a path after a partial-read refusal. */
  fileMutation?: boolean;
  /** Carries a shell command string (same-command thrash detection). */
  shellCommand?: boolean;
}

/**
 * Names this build does not register but an optional provider might (MCP
 * servers, embedders, older transcripts). Classification is defensive.
 */
export const OPTIONAL_DISCOVERY_TOOL_NAMES: readonly string[] = [
  // CodeGraph navigation thrash (same failed hop / empty node spam).
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_trace',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_context',
  'codegraph_explore',
  'codegraph_files',
  'codegraph_status',
  // Skill catalog / load / install thrash.
  'skillhub_search',
  'skillhub_install',
  'install_skill',
  'load_skill',
  // Long-term memory thrash.
  'memory_read',
  'memory_write',
  'memory_delete',
  // Plan / eval / structured-output thrash.
  'plan',
  'plan_step',
  'eval',
  'generate_structured',
  // Browser control thrash.
  'web_browser_fetch',
  'web_browser_control',
  // Vision / screenshot thrash.
  'vision_analyze',
  'screenshot_capture',
  // Fleet batch thrash.
  'fleet_batch',
];

/** `bash` is not a Moss tool; kept for embedders that register one. */
export const OPTIONAL_SHELL_TOOL_NAMES: readonly string[] = ['bash'];

const EMPTY: ToolClassification = {};

const declared = new Map<string, ToolClassification>();
const optionalDiscovery = new Set(OPTIONAL_DISCOVERY_TOOL_NAMES);
const optionalShell = new Set(OPTIONAL_SHELL_TOOL_NAMES);

/** Install declarations from the registered tools. Idempotent. */
export function installToolClassifications(tools: readonly Tool[]): void {
  for (const tool of tools) {
    const classification = tool.metadata?.classification;
    if (classification) declared.set(tool.name, classification);
  }
}

/** The declaration for one tool, including the optional-provider fallbacks. */
export function toolClassification(name: string): ToolClassification {
  const own = declared.get(name);
  if (own) return own;
  if (optionalDiscovery.has(name)) return { discovery: true };
  if (optionalShell.has(name)) return { shellCommand: true };
  return EMPTY;
}

export function isSingleCallExemptTool(name: string): boolean {
  return toolClassification(name).singleCallExempt === true;
}

export function isDiscoveryTool(name: string): boolean {
  return toolClassification(name).discovery === true;
}

export function isSurgicalEditTool(name: string): boolean {
  return toolClassification(name).surgicalEdit === true;
}

export function isVerifyShellTool(name: string): boolean {
  return toolClassification(name).verifyShell === true;
}

export function isFileMutationTool(name: string): boolean {
  return toolClassification(name).fileMutation === true;
}

export function isShellCommandTool(name: string): boolean {
  return toolClassification(name).shellCommand === true;
}
