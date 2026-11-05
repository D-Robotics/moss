/**
 * Prompt layer declarations shared by core and hosts.
 *
 * A layer is (id, stability, origin, text). `stability` is a cache contract, not
 * a formatting choice: stable text is the cached prefix, dynamic text is appended
 * after it. `origin` exists for attribution (debug report, per-layer telemetry).
 */
export type PromptLayerStability = 'stable' | 'dynamic';

/** Where a layer's text comes from. Used by reports, never by behavior. */
export type PromptLayerOrigin =
  | 'persona'
  | 'contract'
  | 'project'
  | 'environment'
  | 'tooling'
  | 'mode'
  | 'style'
  | 'host';

export interface PromptLayerSpec {
  /** Stable identity; setting the same id again replaces the text in place. */
  id: string;
  stability: PromptLayerStability;
  origin: PromptLayerOrigin;
  text: string;
  /** Optional one-line attribution shown by the debug report (e.g. skill catalog cost). */
  note?: string;
}

export interface PromptLayerReportEntry {
  id: string;
  stability: PromptLayerStability;
  origin: PromptLayerOrigin;
  chars: number;
  note?: string;
}

/**
 * The port a host hands to `MossAgentConfig.promptLayers`. The agent reads it on
 * every turn, so a mode switch or a late MCP handshake reaches runs that already
 * exist without rebuilding the agent.
 */
export interface PromptLayersPort {
  /** Stable-prefix texts in declaration order. */
  readonly stable: readonly string[];
  /** Volatile-suffix texts in declaration order. */
  readonly dynamic: readonly string[];
  /** Declared layers (text-trimmed), in declaration order. */
  specs(): readonly PromptLayerSpec[];
  report(): PromptLayerReportEntry[];
  formatReport(): string;
}
