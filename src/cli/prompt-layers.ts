/**
 * The CLI's prompt layers, declared once instead of assembled as ad-hoc string
 * arrays.
 *
 * Why this exists: the stable/dynamic split is a cache contract (Cursor's JSX
 * section tree and Claude Code's `__SYSTEM_PROMPT_STATIC_BREAKPOINT__` are the
 * same idea), so every layer must say two things explicitly — is it part of the
 * cached prefix, and where did it come from. Before this module the answer lived
 * in call-site comments and in index arithmetic (`mcpPromptLayerIndex`,
 * `installPlanModeLayer`), which made a layer's stability invisible at the point
 * a new layer was added.
 *
 * The class keeps the two arrays that `MossAgentConfig.extraPromptLayers` /
 * `dynamicPromptLayers` have always taken, and updates them **in place**, so
 * sub-agents and hosts that received the arrays by reference keep seeing the
 * current text (a `/mode` switch or a late MCP handshake must not require a new
 * agent).
 */
export type PromptLayerStability = 'stable' | 'dynamic';

/** Where a layer's text comes from. Used by the debug report, not by behavior. */
export type PromptLayerOrigin =
  | 'persona'
  | 'contract'
  | 'project'
  | 'environment'
  | 'tooling'
  | 'mode'
  | 'host';

export interface PromptLayerSpec {
  /** Stable identity; setting the same id again replaces the text in place. */
  id: string;
  stability: PromptLayerStability;
  origin: PromptLayerOrigin;
  text: string;
}

export interface PromptLayerReportEntry {
  id: string;
  stability: PromptLayerStability;
  origin: PromptLayerOrigin;
  chars: number;
}

export class CliPromptLayers {
  /** Stable-prefix texts, in declaration order. Passed to the agent by reference. */
  readonly stable: string[] = [];

  /** Volatile-suffix texts, in declaration order. Passed to the agent by reference. */
  readonly dynamic: string[] = [];

  private readonly specs: PromptLayerSpec[] = [];

  /**
   * Declare or update one layer. An existing id keeps its position so a mode
   * switch or an MCP handshake cannot silently reorder the prompt (a reordered
   * block would invalidate the cached prefix for no behavioral reason).
   */
  set(spec: PromptLayerSpec): void {
    const text = spec.text.trim();
    const existing = this.specs.find((entry) => entry.id === spec.id);
    if (existing) {
      existing.text = text;
      existing.stability = spec.stability;
      existing.origin = spec.origin;
    } else {
      this.specs.push({ ...spec, text });
    }
    this.rebuild();
  }

  /** Drop a layer entirely (e.g. plan mode turned off and no placeholder is wanted). */
  remove(id: string): boolean {
    const index = this.specs.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.specs.splice(index, 1);
    this.rebuild();
    return true;
  }

  /** Current layer table, for debugging and startup notices. */
  report(): PromptLayerReportEntry[] {
    return this.specs
      .filter((entry) => entry.text.length > 0)
      .map((entry) => ({
        id: entry.id,
        stability: entry.stability,
        origin: entry.origin,
        chars: entry.text.length,
      }));
  }

  /** One human-readable block; empty when no layer is set. */
  formatReport(): string {
    const entries = this.report();
    if (entries.length === 0) return '';
    const stable = entries.filter((entry) => entry.stability === 'stable');
    const dynamic = entries.filter((entry) => entry.stability === 'dynamic');
    const lines = [
      `prompt layers — stable ${stable.length} / dynamic ${dynamic.length}`,
      ...entries.map(
        (entry) =>
          `  ${entry.stability.padEnd(7)} ${entry.origin.padEnd(11)} ${entry.id.padEnd(24)} ${entry.chars} chars`
      ),
    ];
    return lines.join('\n');
  }

  private rebuild(): void {
    this.stable.length = 0;
    this.dynamic.length = 0;
    for (const entry of this.specs) {
      if (!entry.text) continue;
      (entry.stability === 'stable' ? this.stable : this.dynamic).push(entry.text);
    }
  }
}

/** `MOSS_PROMPT_LAYERS=1` prints the layer table on startup (stderr, opt-in). */
export function promptLayersDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOSS_PROMPT_LAYERS === '1';
}
