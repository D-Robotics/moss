/**
 * Capability declarations: the single shape every "thing that can be loaded into
 * a run" publishes (instruction rules, skills, slash commands, file-defined
 * agents, MCP servers).
 *
 * `activation` is the part Moss did not have: an instruction file was either
 * always injected or only reachable manually. Cursor's `.cursor/rules` model has
 * three classes (always / glob / model-decided), and a rule that only matters
 * while editing TypeScript files under src should not cost tokens while reading
 * docs.
 */
export type CapabilityKind = 'instruction' | 'skill' | 'command' | 'agent' | 'mcp_server';

/** Where the capability came from; the resolution order is documented per kind. */
export type CapabilityScope = 'user' | 'project' | 'workspace' | 'managed';

/** `always`: stable prompt layer; `{ globs }`: loaded when a matching path is touched; `manual`: menu/tool only. */
export type CapabilityActivation =
  | 'always'
  | { globs: readonly string[] }
  | 'manual'
  | 'description';

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  scope: CapabilityScope;
  activation: CapabilityActivation;
  /** Absolute path or MCP server name; for diagnostics, never shown to the model. */
  source: string;
  /** One-line description for `/skills`-style menus. */
  description?: string;
  /** Approximate prompt cost in characters when activated. */
  costChars?: number;
}
