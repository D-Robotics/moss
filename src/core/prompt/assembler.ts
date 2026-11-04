/**
 * Prompt layer assembler: one declarative table instead of ad-hoc string arrays.
 *
 * Why this lives in core, not cli: the stable/dynamic split is a cache contract
 * (Cursor's JSX section tree and Claude Code's
 * `__SYSTEM_PROMPT_STATIC_BREAKPOINT__` encode the same economy), so the table
 * belongs next to the agent that consumes it. Hosts declare text and stability;
 * the agent reads the table every turn.
 *
 * The two arrays are updated **in place** so sub-agents and hosts that received
 * them by reference keep seeing the current text: a `/mode` switch or a late MCP
 * handshake must not require a new agent.
 */
import type {
  PromptLayerOrigin,
  PromptLayerReportEntry,
  PromptLayerSpec,
  PromptLayerStability,
  PromptLayersPort,
} from '../../contracts/prompt-layer.js';

export class PromptAssembler implements PromptLayersPort {
  /** Stable-prefix texts, in declaration order. */
  readonly stable: string[] = [];

  /** Volatile-suffix texts, in declaration order. */
  readonly dynamic: string[] = [];

  private readonly specs_: PromptLayerSpec[] = [];

  /**
   * Declare or update one layer. An existing id keeps its position so a mode
   * switch or an MCP handshake cannot silently reorder the prompt (a reordered
   * block would invalidate the cached prefix for no behavioral reason).
   */
  set(spec: PromptLayerSpec): void {
    const text = spec.text.trim();
    const existing = this.specs_.find((entry) => entry.id === spec.id);
    if (existing) {
      existing.text = text;
      existing.stability = spec.stability;
      existing.origin = spec.origin;
    } else {
      this.specs_.push({ ...spec, text });
    }
    this.rebuild();
  }

  /** Drop a layer entirely (e.g. plan mode turned off and no placeholder wanted). */
  remove(id: string): boolean {
    const index = this.specs_.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.specs_.splice(index, 1);
    this.rebuild();
    return true;
  }

  /**
   * Declared layers with their text. The agent hashes these per turn so a change
   * is attributable to a layer id instead of only to the combined prompt.
   */
  specs(): readonly PromptLayerSpec[] {
    return this.specs_;
  }

  /** Current layer table, for debugging and startup notices. */
  report(): PromptLayerReportEntry[] {
    return this.specs_
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
    for (const entry of this.specs_) {
      if (!entry.text) continue;
      (entry.stability === 'stable' ? this.stable : this.dynamic).push(entry.text);
    }
  }
}

/** `MOSS_PROMPT_LAYERS=1` prints the layer table on startup (stderr, opt-in). */
export function promptLayersDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOSS_PROMPT_LAYERS === '1';
}

export type { PromptLayerOrigin, PromptLayerStability };
