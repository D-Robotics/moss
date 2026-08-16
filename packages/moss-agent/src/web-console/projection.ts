import type { MossAgentEvent } from '../core/agent/moss-agent-types.js';
import type { MossPluginCompositionSnapshot } from '../core/plugins/plugin-host.js';

/** Presentation state of one tool call in the Web console. @beta */
export interface MossWebConsoleToolRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly input: Readonly<Record<string, unknown>>;
  readonly result?: string;
  readonly durationMs?: number;
}

/** React-free, serializable view of one running or completed Moss session. @beta */
export interface MossWebConsoleSnapshot {
  readonly sessionKey: string;
  readonly status: 'idle' | 'running' | 'completed' | 'failed';
  readonly turn: number;
  readonly text: string;
  readonly thinking: string;
  readonly tools: readonly MossWebConsoleToolRow[];
  readonly retries: number;
  readonly compactions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly plugins: MossPluginCompositionSnapshot;
  readonly updatedAt: number;
}

/** Deterministically folds agent events into a presentation snapshot. @beta */
export class MossWebConsoleProjection {
  private status: MossWebConsoleSnapshot['status'] = 'idle';
  private turn = 0;
  private text = '';
  private thinking = '';
  private retries = 0;
  private compactions = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private updatedAt = 0;
  private plugins: MossPluginCompositionSnapshot;
  private readonly tools = new Map<string, MossWebConsoleToolRow>();

  constructor(
    private readonly sessionKey: string,
    plugins: MossPluginCompositionSnapshot = { plugins: [] }
  ) {
    this.plugins = plugins;
  }

  /** Replace the redacted live plugin inventory without changing run history. */
  setPlugins(plugins: MossPluginCompositionSnapshot): void {
    this.plugins = plugins;
  }

  /** Apply one ordered event from `MossAgent.streamChat()`. */
  apply(event: MossAgentEvent, now = Date.now()): void {
    this.updatedAt = now;
    switch (event.type) {
      case 'turn_start':
        this.status = 'running';
        this.turn = event.turn;
        break;
      case 'text_delta':
        this.text += event.delta;
        break;
      case 'thinking_delta':
        this.thinking += event.delta;
        break;
      case 'tool_start':
        this.tools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          status: 'running',
          input: Object.freeze({ ...event.input }),
        });
        break;
      case 'tool_end': {
        const previous = this.tools.get(event.toolCallId);
        this.tools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          status: event.isError ? 'failed' : 'completed',
          input: previous?.input ?? {},
          result: event.result,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        });
        break;
      }
      case 'retry':
        this.retries++;
        break;
      case 'compaction':
        this.compactions++;
        break;
      case 'llm_usage':
        this.inputTokens += event.inputTokens;
        this.outputTokens += event.outputTokens;
        break;
      case 'error':
        this.status = 'failed';
        break;
      case 'done':
        this.status = 'completed';
        if (!this.text) this.text = event.result.response;
        break;
      case 'turn_end':
      case 'working_context_checkpoint':
      case 'microcompact':
      case 'cache_metrics':
        break;
    }
  }

  /** Read an immutable snapshot suitable for browser serialization. */
  snapshot(): MossWebConsoleSnapshot {
    return Object.freeze({
      sessionKey: this.sessionKey,
      status: this.status,
      turn: this.turn,
      text: this.text,
      thinking: this.thinking,
      tools: Object.freeze([...this.tools.values()]),
      retries: this.retries,
      compactions: this.compactions,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      plugins: this.plugins,
      updatedAt: this.updatedAt,
    });
  }
}
