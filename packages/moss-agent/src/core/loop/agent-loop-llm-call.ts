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
import type { CompactHookRegistry } from './compact-hooks.js';
import { isContextOverflowError, describeError } from '../../provider/errors.js';
import {
  classifyMossErrorCategory,
  llmRequestAttributes,
  startSpan,
} from '../../observability/tracing.js';
import { mossMetrics } from '../../observability/index.js';
import { redactSensitiveData } from '../../observability/redact.js';
import {
  MOSS_LEGACY_ATTRIBUTE_ALIASES,
  MOSS_OBSERVABILITY_ATTRIBUTES,
  MOSS_SPAN_NAMES,
  type MossOutcome,
} from '../../observability/contract.js';
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
  recordLlmUsage: (record: {
    runId: string;
    providerId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }) => Promise<void>;
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

function measuredTokenCount(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
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
    recordLlmUsage,
    lastMessageNeedsToolFollowUpLlm,
    suppressVisibleDeltas,
  } = params;

  const llmTurnStartedAt = Date.now();
  const llmSpan = startSpan(
    MOSS_SPAN_NAMES.llmRequest,
    llmRequestAttributes(
      runId,
      String(modelDef.id),
      undefined,
      sessionKey,
      state.turns,
      String(modelDef.provider)
    )
  );
  let spanOutcome: MossOutcome = 'incomplete';
  let spanErrorCategory: ReturnType<typeof classifyMossErrorCategory> | undefined;

  try {
    const llmTurn = await llmSpan.runInSpanContext(async () => {
      const span = llmSpan.span;
      span.addEvent('prompt_window', {
        messages: messagesForModel.length,
        tools: toolsForRun.length,
      });
      const turn = await runAgentLoopLlmTurn({
        stream: { push },
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
        turn: state.turns,
        runStartMs,
        firstTokenMs: state.firstTokenMs,
        suppressVisibleDeltas,
        logDebug: () => {},
      });
      if (turn.usage) {
        const inputTokens = measuredTokenCount(turn.usage.inputTokens);
        const outputTokens = measuredTokenCount(turn.usage.outputTokens);
        if (inputTokens !== undefined) {
          span.setAttribute(MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageInputTokens, inputTokens);
          span.setAttribute(MOSS_LEGACY_ATTRIBUTE_ALIASES.inputTokens, inputTokens);
        }
        if (outputTokens !== undefined) {
          span.setAttribute(MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageOutputTokens, outputTokens);
          span.setAttribute(MOSS_LEGACY_ATTRIBUTE_ALIASES.outputTokens, outputTokens);
        }
        if (inputTokens !== undefined || outputTokens !== undefined) {
          span.addEvent('usage', {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
        }
      }
      return turn;
    });

    if (llmTurn.responseModel?.trim()) {
      llmSpan.span.setAttribute(
        MOSS_OBSERVABILITY_ATTRIBUTES.genAiResponseModel,
        llmTurn.responseModel
      );
    }
    if (abortSignal.aborted || llmTurn.streamStopReason === 'aborted') {
      spanOutcome = 'cancelled';
      spanErrorCategory = 'aborted';
    } else if (llmTurn.streamStopReason === 'error') {
      spanOutcome = 'error';
      spanErrorCategory = 'provider';
    } else {
      spanOutcome = llmTurn.streamStopReason === undefined ? 'incomplete' : 'ok';
    }

    state.firstTokenMs = llmTurn.firstTokenMs;
    if (llmTurn.usage) {
      state.lastReportedPromptTokens = totalPromptTokens(llmTurn.usage);
      state.lastReportedMessageCount = messagesForModel.length;
      push({
        type: 'llm_usage',
        inputTokens: llmTurn.usage.inputTokens,
        outputTokens: llmTurn.usage.outputTokens,
        cacheReadTokens: llmTurn.usage.cacheReadTokens,
        cacheCreationTokens: llmTurn.usage.cacheCreationTokens,
      });
      await recordLlmUsage({
        runId,
        providerId: String(modelDef.provider),
        model: String(modelDef.id),
        inputTokens: llmTurn.usage.inputTokens,
        outputTokens: llmTurn.usage.outputTokens,
        cacheReadTokens: llmTurn.usage.cacheReadTokens,
        cacheCreationTokens: llmTurn.usage.cacheCreationTokens,
        durationMs: Date.now() - llmTurnStartedAt,
        success: true,
      });
      // Metrics (noop when metrics disabled)
      const _llmModel = String(modelDef.id);
      const inputTokens = measuredTokenCount(llmTurn.usage.inputTokens);
      const outputTokens = measuredTokenCount(llmTurn.usage.outputTokens);
      if (inputTokens !== undefined) {
        mossMetrics.llmTokens.add(inputTokens, {
          direction: 'input',
          model: _llmModel,
          outcome: spanOutcome,
        });
      }
      if (outputTokens !== undefined) {
        mossMetrics.llmTokens.add(outputTokens, {
          direction: 'output',
          model: _llmModel,
          outcome: spanOutcome,
        });
      }
    }
    mossMetrics.llmDuration.record(Date.now() - llmTurnStartedAt, {
      model: String(modelDef.id),
      outcome: spanOutcome,
    });

    return {
      control: 'continue',
      assistantContent: llmTurn.assistantContent,
      messageThinkingChunks: llmTurn.messageThinkingChunks,
      toolCalls: llmTurn.toolCalls,
      turnTextParts: llmTurn.turnTextParts,
      streamStopReason: llmTurn.streamStopReason,
    };
  } catch (llmError) {
    const errorCategory = classifyMossErrorCategory(llmError);
    const incompleteStream =
      /stream incomplete|premature close|stream closed prematurely|ended without.*finish_reason/i.test(
        describeError(llmError)
      );
    spanOutcome =
      abortSignal.aborted || errorCategory === 'aborted'
        ? 'cancelled'
        : incompleteStream
          ? 'incomplete'
          : 'error';
    spanErrorCategory =
      spanOutcome === 'cancelled'
        ? 'aborted'
        : errorCategory === 'unknown'
          ? 'provider'
          : errorCategory;
    await recordLlmUsage({
      runId,
      providerId: String(modelDef.provider),
      model: String(modelDef.id),
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - llmTurnStartedAt,
      success: false,
      error: String(redactSensitiveData(describeError(llmError))),
    });
    // Metrics: record failed LLM call
    mossMetrics.llmDuration.record(Date.now() - llmTurnStartedAt, {
      model: String(modelDef.id),
      outcome: spanOutcome,
    });
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
  } finally {
    llmSpan.endOutcome(
      spanOutcome,
      spanErrorCategory,
      spanOutcome === 'error' ? 'llm_request_failed' : undefined
    );
  }
}
