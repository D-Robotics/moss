import type {
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
} from '../llm/llm-provider.js';
import type { Message, ContentBlock } from '../session/session-jsonl.js';
import type { SessionStore } from '../session/session.js';
import type { Tool, ToolCall, ToolResult, ToolContentBlock } from '../tools/tool-types.js';
import type { ToolFilter } from '../tools/tool-filter.js';
import type { ContextPruningSettings } from '../../context/pruning.js';
import type { CompactionSettings } from '../../context/compaction.js';
import type { MicroCompactConfig } from '../../context/microcompact.js';
import type { TailToolSnipConfig } from '../../context/tail-tool-snip.js';
import type { FollowUpGuardConfig } from '../loop/follow-up-guard.js';
import type { CompactHookRegistry } from '../loop/compact-hooks.js';
import type { AgentHooks } from './agent-hooks.js';
import type { ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { SteeringRule } from '../loop/steering.js';
import type { AgentLoopExtensions } from '../loop/agent-loop-types.js';
import type {
  ApprovedPreflightAssignment,
  ApprovedPreflightProgress,
} from '../subagent/approved-preflight-subagents.js';

export interface ProviderConfig {
  llmProvider: LLMProvider;
  model?: string;
  maxTokens?: number;

  maxLLMRetries?: number;

  temperature?: number;

  topP?: number;

  reasoning?: ThinkingLevel | null;

  roundTripAssistantThinking?: boolean;

  api?: string;

  llmExtraBody?: Record<string, unknown>;
}

export interface ContextManagementConfig {
  contextTokens?: number;

  enableContextPruning?: boolean;

  pruningSettings?: Partial<ContextPruningSettings>;

  enableCompaction?: boolean;

  compactionSettings?: Partial<CompactionSettings>;

  enableMicrocompact?: boolean;

  microcompactConfig?: Partial<MicroCompactConfig>;

  enableTailToolSnip?: boolean;

  tailToolSnipConfig?: Partial<TailToolSnipConfig>;

  enableStaleReadInvalidation?: boolean;
}

export interface ToolExecutionConfig {
  toolTimeoutMs?: number;

  enableToolOutputTruncation?: boolean;
}

export interface PromptConfig {
  baseSystemPrompt?: string;

  domainPrompt?: (() => string) | false;

  extraPromptLayers?: string[];

  includeRegisteredKnowledgePrompts?: boolean;

  /**
   * Controls the agent-behavior layer of the system prompt.
   * - `true` / `undefined` (default): inject the compact behavior contract
   *   (`buildAgentBehaviorPromptQuick`) — safety-critical lines only, since
   *   modern LLMs already have the baseline communication and problem-solving
   *   skills the long-form prose teaches.
   * - `'full'`: inject the full long-form behavior contract
   *   (`buildAgentBehaviorPrompt`) — for hosts that want the complete prose.
   * - `false`: inject no behavior layer.
   */
  includeAgentBehaviorPrompt?: boolean | 'full';

  /**
   * Controls the software-engineering domain layer of the system prompt.
   * - `true` / `undefined` (default): inject the compact domain contract
   *   (`buildSoftwareEngineeringPromptQuick`) — same rules, a fraction of the
   *   tokens; matches what the CLI already injects.
   * - `'full'`: inject the long-form domain prompt
   *   (`buildSoftwareEngineeringPrompt`) — for hosts that want the full prose.
   * - `false`: inject no domain layer.
   */
  includeDomainPrompt?: boolean | 'full';

  includeLanguagePolicyPrompt?: boolean;
}

export interface PromptCacheConfig {
  enabled?: boolean;

  debug?: boolean;
}

export interface MossAgentConfig
  extends ProviderConfig, ContextManagementConfig, ToolExecutionConfig, PromptConfig {
  sessionStore: SessionStore;

  workspaceDir?: string;

  /** Shell-write confinement roots for exec tools (v0.9 W1). Undefined = unconstrained. */
  execWriteRoots?: string[];

  /** Unattended-run guardrails (v0.9 W3): token/tool-call/turn/wall-ms ceilings. */
  budget?: { maxTokens?: number; maxToolCalls?: number; maxTurns?: number; maxWallMs?: number };

  /** v0.10 W2: verification-gated best-of-n fix candidates (>=2 enables). */
  bestOfN?: number;

  /** v0.10 W4: reasoning budget policy. Default 'adaptive'. */
  reasoningBudget?: 'off' | 'adaptive' | 'high';

  /** v0.12 model routing tiers (same gateway/key). */
  modelTiers?: { cheap?: string; balanced?: string; strong?: string };

  maxAgentTurns?: number;

  hooks?: AgentHooks;

  /** Inject a custom async task registry (for background subagents, etc.).
   * Defaults to an in-memory implementation. Hosts that want persistent or
   * UI-visible task tracking should inject their own. */
  asyncTaskRegistry?: import('../../contracts/index.js').MossAsyncTaskRegistry;

  /** Inject a per-model context-window resolver for sub-agent model overrides.
   * When a sub-agent is spawned with a `model` override, the runner needs the
   * overridden model's context window (for compaction/pruning inside the
   * sub-agent). Core can't do provider API probes (that's a CLI/host concern),
   * so the host injects this. If absent, the parent's contextTokens is used. */
  resolveModelContextTokens?: (model: string) => Promise<number | undefined>;

  /** Instance-local declarative experts available to sub-agent tools. @beta */
  subagentExperts?: readonly import('../subagent/expert-registry.js').SubagentExpertDefinition[];
  /** Inject a plugin-populated, instance-local expert registry. @beta */
  subagentExpertRegistry?: import('../subagent/expert-registry.js').SubagentExpertRegistry;

  promptCache?: PromptCacheConfig;

  enableThinkingStream?: boolean;

  enableFollowUpGuard?: boolean;

  followUpGuardConfig?: Partial<FollowUpGuardConfig>;

  compactHooks?: CompactHookRegistry;

  /** Fired when a spawned sub-agent finishes (host wiring, e.g. CLI
   *  SubagentStop shell hooks). Failures are absorbed by the caller. */
  subagentStopHook?: (info: {
    sessionKey: string;
    goal: string;
    success: boolean;
    summary: string;
  }) => Promise<void>;

  enableSteering?: boolean;

  replaceDefaultSteeringRules?: boolean;

  steeringRules?: SteeringRule[];

  completionGate?: AgentLoopExtensions['completionGate'];
  /**
   * Force buffering of assistant text until turn end (disables live
   * message_delta streaming). Prefer leaving this unset: structured-output
   * pending state already enables buffering automatically. Only set when a
   * host completionGate rewrites the final answer text itself.
   */
  bufferAssistantUntilComplete?: boolean;
}

export interface ChatOptions {
  platform?: string;
  abortSignal?: AbortSignal;

  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  onStream?: (event: LLMStreamEvent) => void;

  ephemeralTools?: Tool[];
  /** Limit the tools visible and executable for this run. */
  toolFilter?: ToolFilter;

  extraContext?: string;

  /**
   * When true, omit `config.extraPromptLayers` from this run's system prompt
   * (project AGENTS/CLAUDE.md, runtime capability notes, etc.). Used for pure
   * chat / latency-sensitive turns that do not need workspace rules.
   */
  omitExtraPromptLayers?: boolean;

  attachments?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string; filename?: string }
  >;

  temperature?: number;

  topP?: number;

  /** Override configured reasoning for this run. Use `off` for simple,
   * latency-sensitive tasks such as formatting one bounded search result. */
  reasoning?: ThinkingLevel | null;

  /** Numeric per-tool input ceilings enforced by tool implementations. */
  toolInputLimits?: Record<string, Record<string, number>>;

  /** Per-tool arguments enforced for this run after model generation. */
  toolInputOverrides?: Record<string, Record<string, string | number | boolean>>;

  /**
   * Host-approved, deterministic expert research that must run before the lead
   * agent starts. Core accepts only read-only/device-read scopes and injects
   * the bounded outputs as untrusted evidence, never as executable instructions.
   */
  approvedPreflightSubagents?: ApprovedPreflightAssignment[];
  onApprovedPreflightProgress?: (event: ApprovedPreflightProgress) => void;

  maxTurns?: number;

  maxToolCalls?: number;

  /** Override the provider output-token ceiling for this run. */
  maxOutputTokens?: number;

  runId?: string;
}

export interface ChatResult {
  response: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };

  thinking?: string[];

  compactions?: number;

  stopReason?: string;
}

export type MossAgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | {
      type: 'tool_end';
      toolName: string;
      toolCallId: string;
      result: string;
      isError: boolean;
      outcome?: ToolResult['outcome'];
      durationMs?: number;
      aborted?: { by: 'user' | 'timeout' };
      structuredContent?: ToolContentBlock[];
      error?: ToolResult['error'];
    }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason: string; totalToolCalls?: number }
  | { type: 'retry'; attempt: number; error: string }
  | {
      type: 'error';
      error: string;
      retriable: boolean;
      errorDetails?: import('../../errors.js').MossErrorOutcome;

      errorSurface?: import('../../provider/error-classify.js').ProviderErrorSurface;
    }
  | {
      type: 'compaction';
      summaryChars: number;
      droppedMessages: number;
      checkpointOutline?: string[];
      /** Context size before/after compaction (O2 metrics), when measurable. */
      tokensBefore?: number;
      tokensAfter?: number;
      /** Distinct tool names retained in the post-compaction context (summary
       * quality signal: did we keep the work-in-flight tool surface?). */
      keptToolNames?: number;
    }
  | { type: 'microcompact'; compressedCount: number; savedChars: number; savedTokens: number }
  | {
      type: 'llm_usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;

      contextTokens?: number;
      ttftMs?: number;
      generationMs?: number;
      turnGapMs?: number;
      model?: string;
    }
  | {
      type: 'cache_metrics';
      promptCacheEnabled: boolean;
      promptCacheDebug: boolean;
      stableChars: number;
      dynamicChars: number;
      eligible: boolean;
      eligibilityReason: string;
      minStableChars: number;
      maxDynamicCharsRatio: number;
      prefixChecks: number;
      prefixChanges: number;
      toolOrderChecks: number;
      toolOrderChanges: number;

      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { type: 'done'; result: ChatResult };

export type InternalContentBlock = Pick<
  ContentBlock,
  | 'type'
  | 'text'
  | 'data'
  | 'mimeType'
  | 'filename'
  | 'id'
  | 'name'
  | 'input'
  | 'tool_use_id'
  | 'content'
  | 'is_error'
  | '_synthetic'
  | 'structuredContent'
>;

export type InternalMessage = {
  role: 'user' | 'assistant';
  content: string | InternalContentBlock[];
  timestamp: number;
  thinking?: string[];
};

export function toSessionMessages(msgs: InternalMessage[]): Message[] {
  return msgs.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((b) => ({ ...b })),
    timestamp: m.timestamp,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}

export function fromSessionMessages(msgs: Message[]): InternalMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => ({
            type: b.type,
            ...(b.text !== undefined ? { text: b.text } : {}),
            ...(b.data !== undefined ? { data: b.data } : {}),
            ...(b.mimeType !== undefined ? { mimeType: b.mimeType } : {}),
            ...(b.filename !== undefined ? { filename: b.filename } : {}),
            ...(b.id !== undefined ? { id: b.id } : {}),
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.input !== undefined ? { input: b.input } : {}),
            ...(b.tool_use_id !== undefined ? { tool_use_id: b.tool_use_id } : {}),
            ...(b.content !== undefined ? { content: b.content } : {}),
            ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
            ...(b._synthetic !== undefined ? { _synthetic: b._synthetic } : {}),
            ...(b.structuredContent !== undefined
              ? { structuredContent: b.structuredContent }
              : {}),
          })),
    timestamp: m.timestamp,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}

export function toLLMMessages(msgs: InternalMessage[]): LLMMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b): LLMContentBlock => {
            if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
            if (b.type === 'image')
              return {
                type: 'image',
                data: b.data ?? '',
                mimeType: b.mimeType ?? 'application/octet-stream',
                ...(b.filename !== undefined ? { filename: b.filename } : {}),
              };
            if (b.type === 'tool_use')
              return { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} };
            return {
              type: 'tool_result',
              tool_use_id: b.tool_use_id ?? '',
              content: b.content ?? '',
              ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
              ...(b.structuredContent !== undefined
                ? { structuredContent: b.structuredContent }
                : {}),
            };
          }),
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}
