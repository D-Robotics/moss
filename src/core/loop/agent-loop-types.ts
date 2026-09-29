import type { Model, StreamFunction, ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { ContextPruningSettings } from '../../context/pruning.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import type { Message } from '../session/session-jsonl.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { SteeringEngine } from './steering.js';
import type { PendingToolAbortStore } from './pending-tool-aborts.js';

export interface AgentLoopPlatformConfig {
  parallelSafeTools?: Set<string>;

  toolTimeoutMs?: number;

  toolHeartbeatIntervalMs?: number;

  skipHeartbeatToolNames?: Set<string>;

  loadToolsMetaName?: string;

  recordLlmUsage?: boolean;
  llmUsageLogPath?: string;

  quiet?: boolean;

  promptPrefixDebug?: boolean;
}

export interface AgentLoopIdentity {
  runId: string;
  sessionKey: string;
  agentId: string;
}

export interface AgentLoopPromptInput {
  currentMessages: Message[];
  compactionSummary: Message | undefined;
  systemPrompt: string;
  systemPromptParts?: { stable: string; dynamic?: string };
  systemPromptMeta?: { hashShort: string; layerCount: number };
}

export interface AgentLoopToolInput {
  toolsForRun: Tool[];
  getToolsForRun?: () => Tool[];
  toolCtx: ToolContext;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
    abortSignal: AbortSignal;
  }) => Promise<{ approved: boolean; decision: string; reason?: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  toolHooks?: ToolHookRegistry;
}

export interface AgentLoopProviderInput {
  modelDef: Model<any>;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  topP?: number;
  reasoning?: ThinkingLevel;
  /** Number of retries after the initial LLM request. */
  maxLLMRetries?: number;
  maxOutputTokens?: number;
}

export interface AgentLoopHardCaps {
  maxMessageCount?: number;
  maxTotalTokens?: number;
  maxConsecutiveTurnErrors?: number;
  maxOutputContinuations?: number;
}

export interface AgentLoopPolicy {
  maxTurns: number;
  maxToolCalls?: number;
  contextTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  platform?: AgentLoopPlatformConfig;
  hardCaps?: AgentLoopHardCaps;
}

export interface AgentLoopExtensions {
  getSteeringMessages?: () => Promise<Message[]>;
  getFollowUpMessages?: () => Promise<Message[]>;
  /** Per-agent-instance run-epoch store. When multiple MossAgent instances
   *  share a process (embedded hosts), each should provide its OWN Map so a
   *  bumpAgentLoopRunEpoch on one instance doesn't stomp the other's active
   *  runs for the same sessionKey. Omit for a process-wide singleton store
   *  (backwards-compatible; only correct for single-agent processes). */
  runEpochStore?: Map<string, number>;
  guardAssistantOutput?: (request: {
    sessionKey: string;
    runId: string;
    turn: number;
    response: string;
    stopReason?: string;
  }) => Promise<
    { approved: true; response?: string } | { approved: false; reason: string; response?: string }
  >;
  compactHooks?: CompactHookRegistry;
  steeringEngine?: SteeringEngine;
  completionGate?: (request: {
    sessionKey: string;
    runId: string;
    turn: number;
    response: string;
    stopReason?: string;
    messages: Message[];
    totalToolCalls: number;
    toolCallsByName: Record<string, number>;
  }) => Promise<
    { ok: true } | { ok: false; reason: string; correction?: string; retryLimit?: number }
  >;
  /**
   * When true, buffer assistant text_delta until the turn ends (so a
   * completion gate / output guardrail can rewrite or discard it).
   *
   * IMPORTANT: Do NOT derive this solely from `completionGate` being set —
   * MossAgent always installs a completionGate for optional structured-output
   * enforcement, and treating that as "always buffer" kills live streaming
   * for every normal coding turn. Callers should return true only when
   * buffering is actually required this turn (e.g. pending schema validation).
   */
  shouldBufferAssistantOutput?: () => boolean;
}

export interface AgentLoopDeps {
  pendingToolAborts?: PendingToolAbortStore;
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    includeThinking?: boolean;
    abortSignal?: AbortSignal;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
    usage?: AgentLoopLlmUsage[];
  }>;
  abortSignal: AbortSignal;
}

/** Unattended-run guardrails (v0.9 W3): exceeding any limit stops the run
 *  gracefully with a budget stop reason instead of burning tokens forever. */
export interface RunBudget {
  maxTokens?: number;
  maxToolCalls?: number;
  maxTurns?: number;
  maxWallMs?: number;
}

export function checkRunBudgetBreach(params: {
  budget: RunBudget | undefined;
  tokensUsed: number;
  toolCalls: number;
  turns: number;
  runStartMs: number;
}): string | null {
  const { budget } = params;
  if (!budget) return null;
  if (budget.maxTokens !== undefined && params.tokensUsed >= budget.maxTokens) {
    return 'budget_tokens_reached';
  }
  if (budget.maxToolCalls !== undefined && params.toolCalls >= budget.maxToolCalls) {
    return 'budget_tool_calls_reached';
  }
  if (budget.maxTurns !== undefined && params.turns >= budget.maxTurns) {
    return 'budget_turns_reached';
  }
  if (budget.maxWallMs !== undefined && Date.now() - params.runStartMs >= budget.maxWallMs) {
    return 'budget_wall_ms_reached';
  }
  return null;
}

export interface AgentLoopLlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** First-token latency of this call (ms). */
  ttftMs?: number;
  /** Wall time of this LLM call (ms). */
  generationMs?: number;
  /** Gap from the previous turn's last activity to this call (ms). */
  turnGapMs?: number;
}

/** v0.12 model routing tiers: same gateway/key, different price-power points. */
export interface ModelTiers {
  cheap?: string;
  balanced?: string;
  strong?: string;
}

/**
 * Pure routing rule: clean rounds ride the cheap tier; failure pressure
 * (verify streak / red-verify / turn errors) escalates to strong for the
 * next round; a run without a cheap tier keeps the configured model. The
 * default (balanced-less) configuration routes cheap<->strong only.
 */
export function resolveRoutedModel(params: {
  tiers: ModelTiers | undefined;
  defaultModel: string;
  pressure: boolean;
}): string {
  const { tiers } = params;
  if (!tiers || (!tiers.cheap && !tiers.strong && !tiers.balanced)) return params.defaultModel;
  const cheap = tiers.cheap ?? params.defaultModel;
  const strong = tiers.strong ?? tiers.balanced ?? cheap;
  return params.pressure ? strong : cheap;
}

/** Host-provided best-of-n fix escalation (v0.10 W2). Presence enables it. */
export type BestOfNFixFn = (failing: {
  command: string;
  outputTail: string;
}) => Promise<{ fixed: boolean; message: string }>;

export interface AgentLoopParams
  extends
    AgentLoopIdentity,
    AgentLoopPromptInput,
    AgentLoopToolInput,
    AgentLoopProviderInput,
    AgentLoopPolicy,
    AgentLoopExtensions,
    AgentLoopDeps {
  budget?: RunBudget;
  bestOfNFix?: BestOfNFixFn;
  /** v0.10 W4: adaptive reasoning — raise to high after observed failure
   *  signals, fall back when the run is clean. 'off' pins the configured
   *  level; 'high' pins high; default (undefined) = adaptive. */
  reasoningBudget?: 'off' | 'adaptive' | 'high';

  /** v0.12 model routing: per-round model tiers. Absent = fixed model. */
  modelTiers?: ModelTiers;
}
