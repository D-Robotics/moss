import { isOutputLimitStopReason } from '../../provider/output-limit.js';
import type { Model } from '../../provider/pi-ai-types.js';
import { redactEgress } from '../../safety/tool-output-redact.js';
import { createAssistantTextRedactor } from '../../safety/redact-stream.js';
import type { MiniAgentEvent, MiniAgentResult } from '../subagent/agent-events.js';
import type { ChatResult, MossAgentConfig, MossAgentEvent } from './moss-agent-types.js';
import type { ToolCall, ToolResult } from '../tools/tool-types.js';
import type { HarnessAdapterReceipt } from './harness-adapter.js';

type ModelBridgeConfig = Pick<
  MossAgentConfig,
  | 'contextTokens'
  | 'llmProvider'
  | 'maxTokens'
  | 'model'
  | 'reasoning'
  | 'roundTripAssistantThinking'
  | 'api'
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePublicStopReason(reason: string): string {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'toolUse' || reason === 'toolCall') return 'tool_use';
  return reason;
}

function isInterruptedOutput(reason: string | undefined): boolean {
  return (
    reason === 'error' ||
    reason === 'aborted' ||
    reason === 'aborted_by_user' ||
    reason === 'cancelled' ||
    reason === 'output_limit'
  );
}

export function createModelDefFromMossConfig(config: ModelBridgeConfig): Model<any> {
  const modelId = String(config.model || 'moss-default-model');
  const roundTripsThinkingHistory =
    config.roundTripAssistantThinking === true || Boolean(config.reasoning);
  return {
    id: modelId,
    name: modelId,
    api: config.api ?? 'openai-completions',
    provider: config.llmProvider.id,
    baseUrl: '',
    reasoning: roundTripsThinkingHistory,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextTokens ?? 200_000,
    maxTokens: config.maxTokens ?? 4096,
  };
}

export interface MossAgentLoopEventAdapter {
  onMiniEvent(event: MiniAgentEvent): MossAgentEvent[];
  getResult(result: MiniAgentResult): ChatResult;
  getDoneEvent(result: MiniAgentResult): Extract<MossAgentEvent, { type: 'done' }>;
}

export interface MossAgentLoopEventAdapterOptions {
  harnessAdapterReceipt?: HarnessAdapterReceipt;
  isAbortError?: (error: string) => boolean;
  isAborted?: () => boolean;

  contextTokens?: number;
  normalizeLeadingWhitespace?: boolean;
}

export function createMossAgentLoopEventAdapter(
  options?: MossAgentLoopEventAdapterOptions
): MossAgentLoopEventAdapter {
  let response = '';
  let publishedResponse = '';
  const textRedactor = createAssistantTextRedactor({
    normalizeLeadingWhitespace: options?.normalizeLeadingWhitespace !== false,
  });
  let continuingOutput = false;
  const thinkingRedactor = createAssistantTextRedactor();
  const thinking: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  let usage:
    | {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      }
    | undefined;
  let compactions = 0;
  let stopReason = 'unknown';

  const publish = (delta: string): MossAgentEvent[] => {
    if (!delta) return [];
    publishedResponse += delta;
    return [{ type: 'text_delta', delta }];
  };

  const publishThinking = (delta: string): MossAgentEvent[] => {
    if (!delta) return [];
    thinking.push(delta);
    return [{ type: 'thinking_delta', delta }];
  };

  const getResult = (result: MiniAgentResult): ChatResult => {
    const toolBudgetReached = toolResults.some(
      (toolResult) =>
        toolResult.outcome === 'blocked' && /tool budget reached/i.test(toolResult.content)
    );
    const resolvedStopReason = toolBudgetReached
      ? 'tool_budget_reached'
      : options?.isAborted?.()
        ? 'aborted_by_user'
        : stopReason === 'unknown' && (response || result.finalText)
          ? 'end_turn'
          : stopReason;
    return {
      response:
        isInterruptedOutput(resolvedStopReason) || isOutputLimitStopReason(resolvedStopReason)
          ? publishedResponse
          : redactEgress(response || result.finalText),
      ...(options?.harnessAdapterReceipt ? { harnessAdapter: options.harnessAdapterReceipt } : {}),
      toolCalls,
      toolResults,
      ...(usage ? { usage } : {}),
      ...(thinking.length > 0 ? { thinking } : {}),
      ...(compactions > 0 ? { compactions } : {}),
      stopReason: resolvedStopReason,
    };
  };

  return {
    onMiniEvent(event) {
      switch (event.type) {
        case 'message_delta': {
          response += event.delta;
          // Public prose starts after the reasoning block has settled. Emit
          // its safe tail first so hosts keep the two channels chronological.
          if (options?.isAborted?.()) thinkingRedactor.reset();
          return [
            ...publishThinking(thinkingRedactor.flush()),
            ...(continuingOutput ? [] : publish(textRedactor.push(event.delta))),
          ];
        }
        case 'message_end': {
          response = event.text;
          if (isOutputLimitStopReason(event.stopReason)) {
            thinkingRedactor.reset();
            return [];
          }
          continuingOutput = false;
          if (isInterruptedOutput(event.stopReason) || options?.isAborted?.()) {
            textRedactor.reset();
            thinkingRedactor.reset();
            return [];
          }
          return [
            ...publishThinking(thinkingRedactor.flush()),
            ...publish(textRedactor.flush(response)),
          ];
        }
        case 'thinking_delta':
          return publishThinking(thinkingRedactor.push(event.delta));
        case 'tool_execution_start': {
          const input = asRecord(event.args);
          toolCalls.push({ id: event.toolCallId, name: event.toolName, input });
          return [
            {
              type: 'tool_start',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input,
            },
          ];
        }
        case 'tool_execution_progress':
          return [
            {
              type: 'tool_progress',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              elapsedSec: event.elapsed_sec,
              ...(event.chunk !== undefined ? { chunk: event.chunk } : {}),
            },
          ];
        case 'tool_execution_end': {
          const content = event.content ?? event.result;
          toolResults.push({
            toolUseId: event.toolCallId,
            content,
            isError: event.isError,
            ...(event.outcome ? { outcome: event.outcome } : {}),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(event.aborted ? { aborted: event.aborted } : {}),
            ...(event.structuredContent ? { structuredContent: event.structuredContent } : {}),
            ...(event.error ? { error: event.error } : {}),
          });
          return [
            {
              type: 'tool_end',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              ...(event.content !== undefined ? { content: redactEgress(event.content) } : {}),
              isError: event.isError,
              ...(event.outcome ? { outcome: event.outcome } : {}),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              ...(event.aborted ? { aborted: event.aborted } : {}),
              ...(event.structuredContent ? { structuredContent: event.structuredContent } : {}),
              ...(event.error ? { error: event.error } : {}),
              ...(event.protectedPathChanges
                ? { protectedPathChanges: event.protectedPathChanges }
                : {}),
            },
          ];
        }
        case 'turn_start':
          thinkingRedactor.reset();
          if (!continuingOutput) {
            textRedactor.reset();
            publishedResponse = '';
          }
          return [
            {
              type: 'turn_start',
              turn: event.turn,
              ...(event.harnessAdapter ? { harnessAdapter: event.harnessAdapter } : {}),
            },
          ];
        case 'output_continuation': {
          // A length cutoff is not an egress boundary. A secret may continue
          // in the next turn, so settle its combined text as a single reply.
          continuingOutput = !event.exhausted && Boolean(response);
          if (event.exhausted) textRedactor.reset();
          return [
            {
              type: 'output_continuation',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              ...(event.exhausted ? { exhausted: true } : {}),
            },
          ];
        }
        case 'turn_end': {
          // A rejected completion has no message_end; its unfinished
          // reasoning suffix must never escape through turn completion.
          thinkingRedactor.reset();
          const incomingStopReason = event.stopReason
            ? normalizePublicStopReason(event.stopReason)
            : undefined;
          const resolvedStopReason =
            incomingStopReason ?? (stopReason === 'unknown' && response ? 'end_turn' : stopReason);
          stopReason = resolvedStopReason;
          const interrupted = isInterruptedOutput(resolvedStopReason) || options?.isAborted?.();
          // Only message_end settles held text. A rejected completion also
          // ends a turn, but its pending bytes have no publication boundary.
          if (interrupted || (!continuingOutput && !isOutputLimitStopReason(resolvedStopReason))) {
            textRedactor.reset();
          }
          const endEvent: MossAgentEvent = {
            type: 'turn_end',
            turn: event.turn,
            stopReason: resolvedStopReason,
            ...(event.totalToolCalls !== undefined ? { totalToolCalls: event.totalToolCalls } : {}),
          };
          return [endEvent];
        }
        case 'turn_transition':
          stopReason = normalizePublicStopReason(event.reason);
          return [];
        case 'llm_usage': {
          const cacheReadTokens = (usage?.cacheReadTokens ?? 0) + (event.cacheReadTokens ?? 0);
          const cacheCreationTokens =
            (usage?.cacheCreationTokens ?? 0) + (event.cacheCreationTokens ?? 0);
          usage = {
            inputTokens: (usage?.inputTokens ?? 0) + event.inputTokens,
            outputTokens: (usage?.outputTokens ?? 0) + event.outputTokens,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
          };

          return [
            {
              type: 'llm_usage' as const,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              ...(event.ttftMs !== undefined ? { ttftMs: event.ttftMs } : {}),
              ...(event.generationMs !== undefined ? { generationMs: event.generationMs } : {}),
              ...(event.turnGapMs !== undefined ? { turnGapMs: event.turnGapMs } : {}),
              ...(event.model !== undefined ? { model: event.model } : {}),
              ...(event.servedModel ? { servedModel: event.servedModel } : {}),
              ...(event.cacheReadTokens !== undefined
                ? { cacheReadTokens: event.cacheReadTokens }
                : {}),
              ...(event.cacheCreationTokens !== undefined
                ? { cacheCreationTokens: event.cacheCreationTokens }
                : {}),
              ...(options?.contextTokens ? { contextTokens: options.contextTokens } : {}),
            },
          ];
        }
        case 'compaction':
          compactions += 1;
          return [
            {
              type: 'compaction',
              summaryChars: event.summaryChars,
              droppedMessages: event.droppedMessages,
              ...(event.checkpointOutline ? { checkpointOutline: event.checkpointOutline } : {}),
              ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}),
              ...(event.tokensAfter !== undefined ? { tokensAfter: event.tokensAfter } : {}),
              ...(event.keptToolNames !== undefined ? { keptToolNames: event.keptToolNames } : {}),
              ...(event.degraded ? { degraded: true } : {}),
            },
          ];
        case 'context_action': {
          const microcompact = event.actions.find((action) => action.kind === 'microcompact');
          if (!microcompact) return [];
          return [
            {
              type: 'microcompact',
              compressedCount: microcompact.count,
              savedChars: microcompact.savedChars,
              savedTokens: microcompact.savedTokens,
            },
          ];
        }
        case 'run_metrics':
          compactions = Math.max(compactions, event.metrics.contextCompactions);
          return [
            {
              type: 'cache_metrics',
              promptCacheEnabled: Boolean(event.metrics.promptCacheEnabled),
              promptCacheDebug: Boolean(event.metrics.promptCacheDebug),
              stableChars: event.metrics.promptCacheStableChars ?? 0,
              dynamicChars: event.metrics.promptCacheDynamicChars ?? 0,
              eligible: Boolean(event.metrics.promptCacheEligible),
              eligibilityReason:
                event.metrics.promptCacheEligibilityReason ?? 'missing_stable_prefix',
              minStableChars: event.metrics.promptCacheMinStableChars ?? 0,
              maxDynamicCharsRatio: event.metrics.promptCacheMaxDynamicCharsRatio ?? 0,
              prefixChecks: event.metrics.promptPrefixChecks ?? 0,
              prefixChanges: event.metrics.promptPrefixChanges ?? 0,
              toolOrderChecks: event.metrics.promptToolOrderChecks ?? 0,
              toolOrderChanges: event.metrics.promptToolOrderChanges ?? 0,
              ...(event.metrics.systemPromptHashShort
                ? { systemPromptHashShort: event.metrics.systemPromptHashShort }
                : {}),
              systemPromptLayerCount: event.metrics.systemPromptLayerCount,
              ...(typeof event.metrics.promptReadyMs === 'number'
                ? { promptReadyMs: event.metrics.promptReadyMs }
                : {}),
              ...(typeof event.metrics.firstTokenProviderMs === 'number'
                ? { firstTokenProviderMs: event.metrics.firstTokenProviderMs }
                : {}),
              ...(event.metrics.systemPromptLayerHashes
                ? { systemPromptLayerHashes: event.metrics.systemPromptLayerHashes }
                : {}),
              cacheReadTokens: usage?.cacheReadTokens ?? 0,
              cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
            },
          ];
        case 'retry':
          thinkingRedactor.reset();
          if (!continuingOutput) {
            textRedactor.reset();
            publishedResponse = '';
          }
          // Emit a retry event so the host/TUI can clear partial visible output
          // from the failed attempt before the new attempt streams fresh deltas.
          // Previously this was `return []` — the host saw no signal, so
          // retried-attempt deltas were appended to the failed attempt's
          // partial text, producing duplicated/garbled output.
          // (Found by moss self-iteration — glm-5.2 reviewed stream helpers.)
          return [{ type: 'retry' as const, attempt: event.attempt, error: event.error }];
        case 'context_overflow_compact':
          return [];
        case 'agent_error':
          textRedactor.reset();
          thinkingRedactor.reset();
          stopReason = options?.isAbortError?.(event.error) ? 'aborted_by_user' : 'error';
          return [
            {
              type: 'error',
              error: event.error,
              retriable: event.errorDetails?.recoverable ?? false,
              ...(event.errorDetails ? { errorDetails: event.errorDetails } : {}),
              ...(event.surface ? { errorSurface: event.surface } : {}),
            },
          ];
        default:
          return [];
      }
    },
    getResult,
    getDoneEvent(result) {
      return { type: 'done', result: getResult(result) };
    },
  };
}
