import type {
  Context as PiContext,
  Model,
  StopReason,
  StreamFunction,
  ThinkingLevel,
} from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import type { ContentBlock, Message } from '../session/session-jsonl.js';
import type { Tool } from '../tools/tool-types.js';
import type { AgentLoopMutableState } from './agent-loop-state.js';
import { resolveRoutedModel, type ModelTiers } from './agent-loop-types.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import { isContextOverflowError, describeError } from '../../provider/errors.js';
import { totalPromptTokens } from '../llm/usage.js';
import { runAgentLoopLlmTurn } from './agent-loop-stream-helpers.js';
import { runOverflowRecovery } from './overflow-recovery.js';
import type { LoopControlSignal } from './agent-loop-context-prep.js';
import type { AgentLoopLlmUsage } from './agent-loop-types.js';

export interface ExecuteLlmTurnParams {
  state: AgentLoopMutableState;
  modelDef: Model<any>;
  piContext: PiContext;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  reasoning?: ThinkingLevel;
  reasoningBudget?: 'off' | 'adaptive' | 'high';
  modelTiers?: ModelTiers;
  maxLLMRetries?: number;
  topP?: number;
  abortSignal: AbortSignal;
  messagesForModel: Message[];
  toolsForRun: Tool[];
  sessionKey: string;
  runId: string;
  runStartMs: number;
  push: (event: MiniAgentEvent) => void;
  currentMessages: Message[];
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
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  compactHooks?: CompactHookRegistry;
  lastMessageNeedsToolFollowUpLlm: (messages: Message[]) => boolean;
  suppressVisibleDeltas?: boolean;
}

export interface ExecuteLlmTurnResult {
  control: LoopControlSignal;
  assistantContent: ContentBlock[];
  messageThinkingChunks: string[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  turnTextParts: string[];
  streamStopReason: StopReason | undefined;
}

function emptyResult(control: LoopControlSignal): ExecuteLlmTurnResult {
  return {
    control,
    assistantContent: [],
    messageThinkingChunks: [],
    toolCalls: [],
    turnTextParts: [],
    streamStopReason: undefined,
  };
}

export async function executeLlmTurn(params: ExecuteLlmTurnParams): Promise<ExecuteLlmTurnResult> {
  const {
    state,
    modelDef,
    piContext,
    streamFn,
    apiKey,
    temperature,
    reasoning,
    maxLLMRetries,
    topP,
    abortSignal,
    messagesForModel,
    toolsForRun,
    sessionKey,
    runId,
    runStartMs,
    push,
    currentMessages,
    prepareCompaction,
    replaceMessages,
    compactHooks,
    lastMessageNeedsToolFollowUpLlm,
    suppressVisibleDeltas,
  } = params;

  const turnGapMs =
    state.lastLlmActivityMs !== undefined ? Date.now() - state.lastLlmActivityMs : undefined;

  // v0.12 model routing: same pressure signal as adaptive reasoning — cheap
  // tier on clean rounds, strong tier under pressure (per-round, at the
  // round boundary; absent tiers keep the configured model).
  const routedModel = resolveRoutedModel({
    tiers: params.modelTiers,
    defaultModel: modelDef.id,
    pressure:
      (state.failingVerifyStreak?.count ?? 0) >= 1 ||
      state.redVerifyNudgeAttempts > 0 ||
      state.consecutiveTurnErrors > 0,
  });
  const requestModel = routedModel === modelDef.id ? undefined : routedModel;

  // v0.10 W4 adaptive reasoning: failure signals (repeated verify failures,
  // red-verify attempts, turn errors) escalate to 'high' for the next call;
  // a clean run keeps the configured level.
  const budget = params.reasoningBudget ?? 'adaptive';
  let effectiveReasoning = reasoning;
  if (budget === 'high') {
    effectiveReasoning = 'high';
  } else if (budget === 'adaptive') {
    const underPressure =
      (state.failingVerifyStreak?.count ?? 0) >= 1 ||
      state.redVerifyNudgeAttempts > 0 ||
      state.consecutiveTurnErrors > 0;
    if (underPressure && reasoning !== undefined && reasoning !== null) {
      effectiveReasoning = 'high';
    }
  }
  try {
    const llmTurn = await runAgentLoopLlmTurn({
      requestModel,
      stream: { push },
      modelDef,
      piContext,
      streamFn,
      apiKey,
      temperature,
      reasoning: effectiveReasoning,
      maxLLMRetries,
      topP,
      abortSignal,
      messagesForModel,
      toolsForRun,
      sessionKey,
      turn: state.turns,
      runStartMs,
      firstTokenMs: state.firstTokenMs,
      suppressVisibleDeltas,
      logDebug: () => {},
    });

    state.firstTokenMs = llmTurn.firstTokenMs;
    state.lastLlmActivityMs = Date.now();
    if (llmTurn.usage) {
      state.budgetTokensUsed +=
        totalPromptTokens(llmTurn.usage) + (llmTurn.usage.outputTokens ?? 0);
      state.lastReportedPromptTokens = totalPromptTokens(llmTurn.usage);
      state.lastReportedMessageCount = messagesForModel.length;
      push({
        type: 'llm_usage',
        inputTokens: llmTurn.usage.inputTokens,
        outputTokens: llmTurn.usage.outputTokens,
        cacheReadTokens: llmTurn.usage.cacheReadTokens,
        cacheCreationTokens: llmTurn.usage.cacheCreationTokens,
        ttftMs: llmTurn.ttftMs,
        generationMs: llmTurn.generationMs,
        turnGapMs,
        model: routedModel,
      });
    }

    return {
      control: 'continue',
      assistantContent: llmTurn.assistantContent,
      messageThinkingChunks: llmTurn.messageThinkingChunks,
      toolCalls: llmTurn.toolCalls,
      turnTextParts: llmTurn.turnTextParts,
      streamStopReason: llmTurn.streamStopReason,
    };
  } catch (llmError) {
    const errorText = describeError(llmError);
    if (
      isContextOverflowError(errorText) &&
      state.overflowState.level < 3 &&
      !lastMessageNeedsToolFollowUpLlm(currentMessages)
    ) {
      const outcome = await runOverflowRecovery({
        state: state.overflowState,
        errorText,
        currentMessages,
        sessionKey,
        runId,
        prepareCompaction,
        compactHooks,
        push,
        replaceMessages,
        abortSignal,
      });
      if (outcome.kind === 'retry-same-turn') {
        if (outcome.replacedSummaryMessage) {
          state.compactionSummary = outcome.replacedSummaryMessage;
        }

        state.proactiveCompactionAttempted = false;
        state.promptPruneCompactionAttempted = false;

        state.lastReportedPromptTokens = 0;
        state.lastReportedMessageCount = 0;
        return emptyResult('retry');
      }
    }
    throw llmError;
  }
}
