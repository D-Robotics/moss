import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
  LLMSystemPromptParts,
} from '../core/llm/llm-provider.js';
import { envPreferMoss } from '../utils/env-compat.js';
import { getRootLogger } from '../logger.js';
import {
  convertMessages,
  defaultRepairToolCallUrl,
  hasAssistantThinkingHistory,
  hasProviderNativeThinkingHistory,
  hasThinkingModeConfigured,
  normalizePiAiModelInfo,
  rejectAnthropicOAuthToken,
  resolveToolFollowReasoningSuppress,
  type PiAiModelInfo,
  type PiAiStreamEvent,
} from './pi-ai-wire-format.js';
import { processEvent, convertStreamEvent } from './pi-ai-stream-parser.js';
import { PiAiFirstEventTimeoutError, startFirstEventWatchdog } from './pi-ai-watchdog.js';
import { createProviderErrorResponse, throwProviderErrorResponse } from './errors.js';

const log = getRootLogger().child('provider:pi-ai');

const DEFAULT_ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function buildAnthropicSplitSystemBlocks(
  parts: LLMSystemPromptParts,
  cacheControl: unknown
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'text',
      text: parts.stable,
      cache_control: cacheControl,
    },
  ];
  if (parts.dynamic) {
    blocks.push({ type: 'text', text: parts.dynamic });
  }
  return blocks;
}

function applyAnthropicSystemPromptPartsToPayload(
  payload: unknown,
  systemPrompt: string,
  parts?: LLMSystemPromptParts
): void {
  if (!parts?.stable || !isRecord(payload)) return;
  const system = payload.system;

  if (typeof system === 'string') {
    if (system !== systemPrompt) return;
    payload.system = buildAnthropicSplitSystemBlocks(parts, DEFAULT_ANTHROPIC_CACHE_CONTROL);
    return;
  }

  if (!Array.isArray(system)) return;
  const targetIndex = system.findIndex(
    (block) => isRecord(block) && block.type === 'text' && block.text === systemPrompt
  );
  if (targetIndex < 0) return;

  const targetBlock = system[targetIndex];
  const cacheControl =
    isRecord(targetBlock) && targetBlock.cache_control !== undefined
      ? targetBlock.cache_control
      : DEFAULT_ANTHROPIC_CACHE_CONTROL;
  system.splice(targetIndex, 1, ...buildAnthropicSplitSystemBlocks(parts, cacheControl));
}

export { PiAiFirstEventTimeoutError } from './pi-ai-watchdog.js';
export type { PiAiModelInfo, PiAiStreamEvent } from './pi-ai-wire-format.js';

export type PiAiStreamFunction = (
  model: PiAiModelInfo,
  context: unknown,
  options?: Record<string, unknown>
) => AsyncIterable<PiAiStreamEvent>;

export interface PiAiLLMProviderConfig {
  streamFn: PiAiStreamFunction;
  model: PiAiModelInfo;
  apiKey: string;
  baseUrl?: string;
  displayName?: string;

  reasoning?: string | null;

  repairToolCallUrl?: (url: string) => string;
}

export class PiAiLLMProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;

  private streamFn: PiAiStreamFunction;
  private model: PiAiModelInfo;
  private apiKey: string;
  private baseUrl?: string;
  private reasoning?: string | null;
  private repairToolCallUrl: (url: string) => string;

  constructor(config: PiAiLLMProviderConfig) {
    rejectAnthropicOAuthToken(config.apiKey, config.model?.api);
    this.streamFn = config.streamFn;
    this.model = normalizePiAiModelInfo(config.model, config.baseUrl);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.reasoning = config.reasoning;
    this.repairToolCallUrl = config.repairToolCallUrl ?? defaultRepairToolCallUrl;
    this.id = `pi-ai-${config.model.provider}`;
    this.displayName = config.displayName ?? `pi-ai (${config.model.provider})`;
  }

  private buildPiModelForCall(
    options: LLMRequestOptions,
    _toolFollowSuppress: boolean
  ): PiAiModelInfo {
    if (options.reasoning === '') {
      const m = { ...this.model } as PiAiModelInfo;
      delete m.reasoning;
      return m;
    }
    if (options.reasoning !== undefined && options.reasoning !== null) {
      return { ...this.model, reasoning: options.reasoning } as PiAiModelInfo;
    }
    return this.model;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const content: LLMContentBlock[] = [];

    const thinkingChunks: string[] = [];
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    let usage: NonNullable<LLMResponse['usage']> = { inputTokens: 0, outputTokens: 0 };

    const requestThinkingMode = hasThinkingModeConfigured(
      this.model,
      this.reasoning,
      options.reasoning
    );
    let convertedMessages = convertMessages(options.messages, this.model, requestThinkingMode);
    const toolFollowSuppress = resolveToolFollowReasoningSuppress(
      options.messages,
      convertedMessages
    );
    if (
      toolFollowSuppress &&
      !requestThinkingMode &&
      (hasProviderNativeThinkingHistory(this.model, this.reasoning) ||
        hasAssistantThinkingHistory(options.messages))
    ) {
      convertedMessages = convertMessages(options.messages, this.model, true);
    }
    const piContext = this.buildPiContext(options, convertedMessages);
    const watchdog = startFirstEventWatchdog(options.abortSignal, this.model);
    const piOptions = this.buildPiOptions(options, watchdog.signal, toolFollowSuppress);
    const piModel = this.buildPiModelForCall(options, toolFollowSuppress);

    try {
      for await (const event of this.streamFn(piModel, piContext, piOptions)) {
        watchdog.onActivity();
        const parsed = processEvent(event, content, this.repairToolCallUrl, thinkingChunks);
        if (parsed.stopReason) stopReason = parsed.stopReason;
        if (parsed.usage) usage = parsed.usage;
      }
    } catch (err) {
      throw watchdog.translateError(err);
    } finally {
      watchdog.dispose();
    }

    if (thinkingChunks.length > 0 && content.length === 0) {
      log.warn(
        'LLM completed (non-streaming) with only thinking content (no visible text, no tool_use); ' +
          'host should surface a placeholder via LLMResponse.thinking',
        {
          thinkingChars: thinkingChunks.join('').length,
          model: this.model.id,
          provider: this.model.provider,
        }
      );
    }

    return {
      stopReason,
      content,
      usage,
      ...(thinkingChunks.length > 0 ? { thinking: thinkingChunks } : {}),
    };
  }

  async stream(
    options: LLMRequestOptions,
    onEvent: (event: LLMStreamEvent) => void
  ): Promise<LLMResponse> {
    const content: LLMContentBlock[] = [];
    const thinkingChunks: string[] = [];
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    let usage: NonNullable<LLMResponse['usage']> = { inputTokens: 0, outputTokens: 0 };
    let incomplete: LLMResponse['incomplete'] | undefined;

    const requestThinkingMode = hasThinkingModeConfigured(
      this.model,
      this.reasoning,
      options.reasoning
    );
    let convertedMessages = convertMessages(options.messages, this.model, requestThinkingMode);
    const toolFollowSuppress = resolveToolFollowReasoningSuppress(
      options.messages,
      convertedMessages
    );
    if (
      toolFollowSuppress &&
      !requestThinkingMode &&
      (hasProviderNativeThinkingHistory(this.model, this.reasoning) ||
        hasAssistantThinkingHistory(options.messages))
    ) {
      convertedMessages = convertMessages(options.messages, this.model, true);
    }
    const piContext = this.buildPiContext(options, convertedMessages);
    const watchdog = startFirstEventWatchdog(options.abortSignal, this.model);
    const piOptions = this.buildPiOptions(options, watchdog.signal, toolFollowSuppress);
    const piModel = this.buildPiModelForCall(options, toolFollowSuppress);

    const tracePiAiStream =
      process.env.MOSS_TRACE_PI_AI_STREAM === '1' || process.env.MOSS_TRACE_PI_AI_STREAM === 'true';
    const eventTypeCounts: Record<string, number> = {};

    let streamError: Error | null = null;
    try {
      for await (const event of this.streamFn(piModel, piContext, piOptions)) {
        watchdog.onActivity();
        if (tracePiAiStream) {
          const et = String((event as PiAiStreamEvent).type ?? 'unknown');
          eventTypeCounts[et] = (eventTypeCounts[et] ?? 0) + 1;
        }
        const llmEvent = convertStreamEvent(event);
        if (llmEvent) onEvent(llmEvent);

        const parsed = processEvent(event, content, this.repairToolCallUrl, thinkingChunks);
        if (parsed.stopReason) stopReason = parsed.stopReason;
        if (parsed.usage) usage = parsed.usage;
      }
    } catch (err) {
      const translated = watchdog.translateError(err);

      if (translated instanceof PiAiFirstEventTimeoutError || options.abortSignal?.aborted) {
        watchdog.dispose();
        throw translated;
      }
      streamError = translated instanceof Error ? translated : new Error(String(translated));
      log.warn('stream threw after processing events', {
        error: streamError.message,
        model: this.model.id,
      });
    } finally {
      watchdog.dispose();
    }

    if (thinkingChunks.length > 0) {
      const thinkingText = thinkingChunks.join('');
      const hasVisibleText = content.some(
        (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim()
      );
      const hasToolUse = content.some((b) => b.type === 'tool_use');

      if (streamError && !hasVisibleText && !hasToolUse) {
        log.warn(
          'stream error with only thinking content; model reasoned but was interrupted before response',
          { thinkingChars: thinkingText.length, error: streamError.message }
        );
        throwProviderErrorResponse(
          createProviderErrorResponse(
            'pi-ai',
            `model completed reasoning but was interrupted before producing a response. ` +
              `This is usually a gateway timeout or upstream error. Original: ${streamError.message}`,
            { originalError: streamError }
          )
        );
      }

      if (!hasVisibleText && !hasToolUse) {
        log.warn(
          'LLM completed with only thinking content (no visible text, no tool_use); ' +
            'host agent loop should surface a placeholder or retry — thinking will NOT be folded into content',
          {
            thinkingChars: thinkingText.length,
            model: this.model.id,
            provider: this.model.provider,
          }
        );
      } else {
        log.debug(
          'thinking deltas observed; not folded into content (industry-standard separation)',
          {
            thinkingChars: thinkingText.length,
            hasVisibleText,
            hasToolUse,
          }
        );
      }
    }

    if (streamError) {
      const hasVisibleContent = content.length > 0;
      if (!hasVisibleContent) {
        throwProviderErrorResponse(
          createProviderErrorResponse('pi-ai', streamError.message, { originalError: streamError })
        );
      }
      log.warn('returning partial content after mid-stream error', {
        error: streamError.message,
        model: this.model.id,
        contentBlocks: content.length,
      });
      incomplete = { reason: streamError.message };
    }

    if (tracePiAiStream) {
      const hasToolUseBlock = content.some((b) => b.type === 'tool_use');
      const visibleChars = content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
        .reduce((n, b) => n + (b.text?.length ?? 0), 0);
      log.debug('stream trace', {
        model: this.model.id,
        provider: this.model.provider,
        eventTypeCounts,
        stopReason,
        hasToolUseBlock,
        visibleChars,
        thinkingChars: thinkingChunks.reduce((n, s) => n + s.length, 0),
        streamError: null,
      });
    }

    return {
      stopReason,
      content,
      usage,
      ...(incomplete ? { incomplete } : {}),
      ...(thinkingChunks.length > 0 ? { thinking: thinkingChunks } : {}),
    };
  }

  private buildPiContext(options: LLMRequestOptions, convertedMessages: unknown[]): unknown {
    const tools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));

    return {
      systemPrompt: options.systemPrompt,
      ...(options.systemPromptParts ? { systemPromptParts: options.systemPromptParts } : {}),
      messages: convertedMessages,
      tools: tools ?? [],
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
    };
  }

  private buildPiOptions(
    options: LLMRequestOptions,
    overrideAbortSignal?: AbortSignal,
    toolFollowSuppress = false
  ): Record<string, unknown> {
    const tcRaw = envPreferMoss('MOSS_PI_AI_TOOL_CHOICE', 'PI_AI_TOOL_CHOICE');
    const toolChoice =
      tcRaw === 'required' || tcRaw === 'auto' || tcRaw === 'none' ? tcRaw : undefined;

    const effectiveSignal = overrideAbortSignal ?? options.abortSignal;

    let reasoningForPi: string | undefined;
    if (options.reasoning === null || options.reasoning === '' || toolFollowSuppress) {
      reasoningForPi = undefined;
    } else if (options.reasoning !== undefined) {
      reasoningForPi = options.reasoning;
    } else if (this.reasoning !== undefined && this.reasoning !== null && this.reasoning !== '') {
      reasoningForPi = this.reasoning;
    }
    const onPayload = options.systemPromptParts
      ? (payload: unknown) => {
          applyAnthropicSystemPromptPartsToPayload(
            payload,
            options.systemPrompt,
            options.systemPromptParts
          );
        }
      : undefined;

    return {
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      ...(reasoningForPi ? { reasoning: reasoningForPi } : {}),
      maxTokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(effectiveSignal ? { abortSignal: effectiveSignal, signal: effectiveSignal } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(onPayload ? { onPayload } : {}),
    };
  }
}
