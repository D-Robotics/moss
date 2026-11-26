import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
  LLMSystemPromptParts,
} from '../core/llm/llm-provider.js';
import { envPreferMoss } from '../utils/env-compat.js';
import { providerLogger } from './redacted-log.js';
import {
  convertMessages,
  defaultRepairToolCallUrl,
  hasAssistantThinkingHistory,
  hasProviderNativeThinkingHistory,
  hasThinkingModeConfigured,
  normalizePiAiModelInfo,
  rejectAnthropicOAuthToken,
  type PiAiModelInfo,
  type PiAiStreamEvent,
} from './pi-ai-wire-format.js';
import { lastMessageNeedsToolFollowUp } from './reasoning-policy.js';
import { processEvent, convertStreamEvent } from './pi-ai-stream-parser.js';
import { PiAiFirstEventTimeoutError, startFirstEventWatchdog } from './pi-ai-watchdog.js';
import { ErrorCode, isMossError, MossError } from '../errors.js';
import { classifyProviderError, renderProviderErrorSurface } from './error-classify.js';
import { noteProviderRejectsImageInput } from './image-capability.js';

const log = providerLogger('provider:pi-ai');

function throwUserFacingProviderError(err: unknown): never {
  const moss = isMossError(err) ? err : undefined;
  const status = typeof moss?.context?.status === 'number' ? moss.context.status : undefined;
  const message = moss
    ? moss.hint
      ? `${moss.message}\n${moss.hint}`
      : moss.message
    : err instanceof Error
      ? err.message
      : String(err);
  const surface = classifyProviderError({
    errorMessage: message,
    ...(status !== undefined ? { status } : {}),
  });
  if (surface.category === 'images_not_supported') noteProviderRejectsImageInput();
  const surfaced = new MossError({
    code:
      surface.category === 'auth'
        ? ErrorCode.PROVIDER_AUTH_FAILED
        : surface.category === 'rate_limit'
          ? ErrorCode.PROVIDER_RATE_LIMITED
          : (moss?.code ?? ErrorCode.PROVIDER_UPSTREAM_ERROR),
    message: renderProviderErrorSurface(surface),
    recoverable: surface.retryable,
    cause: err,
    ...(moss?.context ? { context: moss.context } : {}),
  });
  Object.defineProperty(surfaced, 'surface', { value: surface });
  throw surfaced;
}

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

function payloadAlreadyCarriesDynamic(payload: Record<string, unknown>, dynamic: string): boolean {
  const body = dynamic.trim();
  if (!body) return false;
  const block = `<turn-context>\n${body}\n</turn-context>`;
  try {
    return JSON.stringify(payload.messages ?? null).includes(block);
  } catch {
    return false;
  }
}

function applyAnthropicSystemPromptPartsToPayload(
  payload: unknown,
  systemPrompt: string,
  parts?: LLMSystemPromptParts
): void {
  if (!parts?.stable || !isRecord(payload)) return;
  const system = payload.system;
  // The dynamic suffix is already on the user message that introduced it.
  // Sending it again as a system block would bill it twice.
  const wireParts =
    parts.dynamic && payloadAlreadyCarriesDynamic(payload, parts.dynamic)
      ? { stable: parts.stable }
      : parts;

  if (typeof system === 'string') {
    if (system !== systemPrompt) return;
    payload.system = buildAnthropicSplitSystemBlocks(wireParts, DEFAULT_ANTHROPIC_CACHE_CONTROL);
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
  system.splice(targetIndex, 1, ...buildAnthropicSplitSystemBlocks(wireParts, cacheControl));
}

export { PiAiFirstEventTimeoutError } from './pi-ai-watchdog.js';
export type { PiAiModelInfo, PiAiStreamEvent } from './pi-ai-wire-format.js';

export type PiAiStreamFunction = (
  model: PiAiModelInfo,
  context: unknown,
  options?: Record<string, unknown>
) => AsyncIterable<PiAiStreamEvent>;

/** Signals that a gateway refused the *value* of tool_choice, not the request shape. */
const TOOL_CHOICE_FIELD = /tool[ _-]?choice/i;
const TOOL_CHOICE_UNSUPPORTED =
  /not\s+support|unsupported|does\s+not\s+allow|not\s+allowed|invalid|unrecognized|unknown|reject|not\s+permitted|disallow/i;

/**
 * HTTP status carried by a provider rejection: MossError.context.status, a
 * structured field on the error itself (pi-ai's runtime error keeps it), or a
 * cause in the wrap chain.
 */
function statusFromError(err: unknown): number | undefined {
  let node: unknown = err;
  for (let depth = 0; depth < 3 && node && typeof node === 'object'; depth += 1) {
    if (isMossError(node)) {
      const status = node.context?.status;
      if (typeof status === 'number') return status;
    }
    const record = node as Record<string, unknown>;
    for (const key of ['status', 'statusCode', 'httpStatus']) {
      const value = record[key];
      if (typeof value === 'number' && Number.isInteger(value)) return value;
    }
    node = record.cause;
  }
  return undefined;
}

/** Real pi-ai sometimes keeps only "400 ..." in errorMessage, with no status field. */
function statusFromText(text: string): number | undefined {
  const match = /\b(400|422)\b/.exec(text.slice(0, 500));
  return match ? Number(match[1]) : undefined;
}

function rejectionMessage(err: unknown): string {
  const parts: string[] = [];
  let node: unknown = err;
  for (let depth = 0; depth < 3 && node; depth += 1) {
    if (node instanceof Error) {
      parts.push(node.message);
      node = node.cause;
    } else if (typeof node === 'string') {
      parts.push(node);
      break;
    } else {
      break;
    }
  }
  return parts.join('\n');
}

function isToolChoiceUnsupportedRejection(err: unknown): boolean {
  const message = rejectionMessage(err);
  const status = statusFromError(err) ?? statusFromText(message);
  if (status !== 400 && status !== 422) return false;
  return TOOL_CHOICE_FIELD.test(message) && TOOL_CHOICE_UNSUPPORTED.test(message);
}

interface PiAttemptState {
  content: LLMContentBlock[];
  thinkingChunks: string[];
  stopReason: LLMResponse['stopReason'];
  usage: NonNullable<LLMResponse['usage']>;
  responseModel?: string;
  /** A pi-ai event was converted for the consumer (text, thinking, tool, usage, stop). */
  delivered: boolean;
  reportedUsage: boolean;
  eventTypeCounts: Record<string, number>;
}

interface PiAttemptResult {
  state: PiAttemptState;
  error: Error | null;
  timedOut: boolean;
}

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
  readonly capabilities: NonNullable<LLMProvider['capabilities']>;

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
    this.capabilities = {
      streaming: true,
      structuredOutput: this.model.api !== 'anthropic-messages' && /^minimax-/i.test(this.model.id),
    };
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.reasoning = config.reasoning;
    this.repairToolCallUrl = config.repairToolCallUrl ?? defaultRepairToolCallUrl;
    this.id = `pi-ai-${config.model.provider}`;
    this.displayName = config.displayName ?? `pi-ai (${config.model.provider})`;
  }

  private buildPiModelForCall(options: LLMRequestOptions): PiAiModelInfo {
    let model = this.model;
    // v0.12 model routing: a per-request model id (same gateway/key) wins.
    if (options.model && options.model !== this.model.id) {
      model = { ...this.model, id: options.model };
    }
    if (options.reasoning === '') {
      const m = { ...model } as PiAiModelInfo;
      delete m.reasoning;
      return m;
    }
    if (options.reasoning !== undefined && options.reasoning !== null) {
      return { ...model, reasoning: options.reasoning } as PiAiModelInfo;
    }
    return model;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const { piContext, piModel } = this.prepareCall(options);
    let attempt = await this.runAttempt(options, piContext, piModel, false);
    attempt = await this.retryWithoutToolChoice(options, piContext, piModel, attempt);

    const { state } = attempt;
    if (attempt.error) throw attempt.error;

    if (state.thinkingChunks.length > 0 && state.content.length === 0) {
      // B301: reasoning-only answers are legal for reasoning models (the doctor
      // ping gets one). This is a diagnostic, not a user warning — at warn level
      // the TUI showed a maintainer-facing sentence above the /doctor panel.
      log.debug(
        'LLM completed (non-streaming) with only thinking content (no visible text, no tool_use); ' +
          'host should surface a placeholder via LLMResponse.thinking',
        {
          thinkingChars: state.thinkingChunks.join('').length,
          model: this.model.id,
          provider: this.model.provider,
        }
      );
    }

    return {
      stopReason: state.stopReason,
      content: state.content,
      usage: state.usage,
      ...(state.responseModel ? { model: state.responseModel } : {}),
      ...(state.thinkingChunks.length > 0 ? { thinking: state.thinkingChunks } : {}),
    };
  }

  async stream(
    options: LLMRequestOptions,
    onEvent: (event: LLMStreamEvent) => void
  ): Promise<LLMResponse> {
    const { piContext, piModel } = this.prepareCall(options);
    let attempt = await this.runAttempt(options, piContext, piModel, false, onEvent);
    attempt = await this.retryWithoutToolChoice(options, piContext, piModel, attempt, onEvent);

    const { state } = attempt;
    const streamError = attempt.error;
    // A first-event watchdog timeout is a timing fact about this attempt, not
    // something a parameter retry could fix; rethrow it as before.
    if (streamError && (attempt.timedOut || options.abortSignal?.aborted)) throw streamError;

    const { content, thinkingChunks } = state;
    let incomplete: LLMResponse['incomplete'] | undefined;

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
        throwUserFacingProviderError(streamError);
      }

      if (!hasVisibleText && !hasToolUse) {
        // B317: same reasoning as the non-streaming branch (B301) — a
        // reasoning model may legitimately stream only thinking, and this line
        // is maintainer-facing; at warn level the TUI printed it as a transcript
        // notice mid-run.
        log.debug(
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
        throwUserFacingProviderError(streamError);
      }
      log.warn('returning partial content after mid-stream error', {
        error: streamError.message,
        model: this.model.id,
        contentBlocks: content.length,
      });
      incomplete = { reason: streamError.message };
    }

    const tracePiAiStream =
      process.env.MOSS_TRACE_PI_AI_STREAM === '1' || process.env.MOSS_TRACE_PI_AI_STREAM === 'true';
    if (tracePiAiStream) {
      const hasToolUseBlock = content.some((b) => b.type === 'tool_use');
      const visibleChars = content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
        .reduce((n, b) => n + (b.text?.length ?? 0), 0);
      log.debug('stream trace', {
        model: this.model.id,
        provider: this.model.provider,
        eventTypeCounts: state.eventTypeCounts,
        stopReason: state.stopReason,
        hasToolUseBlock,
        visibleChars,
        thinkingChars: thinkingChunks.reduce((n, s) => n + s.length, 0),
        streamError: null,
      });
    }

    return {
      stopReason: state.stopReason,
      content,
      usage: state.usage,
      ...(state.responseModel ? { model: state.responseModel } : {}),
      ...(incomplete ? { incomplete } : {}),
      ...(thinkingChunks.length > 0 ? { thinking: thinkingChunks } : {}),
    };
  }

  /**
   * Thinking-mode and tool-follow-up handling shared by both public entrypoints:
   * the request shape must be identical whether the caller streams or buffers.
   */
  private prepareCall(options: LLMRequestOptions): { piContext: unknown; piModel: PiAiModelInfo } {
    const requestThinkingMode = hasThinkingModeConfigured(
      this.model,
      this.reasoning,
      options.reasoning
    );
    let convertedMessages = convertMessages(options.messages, this.model, requestThinkingMode);
    if (
      lastMessageNeedsToolFollowUp(options.messages) &&
      !requestThinkingMode &&
      (hasProviderNativeThinkingHistory(this.model, this.reasoning) ||
        hasAssistantThinkingHistory(options.messages))
    ) {
      convertedMessages = convertMessages(options.messages, this.model, true);
    }
    return {
      piContext: this.buildPiContext(options, convertedMessages),
      piModel: this.buildPiModelForCall(options),
    };
  }

  /**
   * One physical provider request. The returned state records everything the
   * attempt already handed to the consumer so a compatibility retry can prove
   * nothing needs preserving.
   */
  private async runAttempt(
    options: LLMRequestOptions,
    piContext: unknown,
    piModel: PiAiModelInfo,
    omitToolChoice: boolean,
    onEvent?: (event: LLMStreamEvent) => void
  ): Promise<PiAttemptResult> {
    const watchdog = startFirstEventWatchdog(options.abortSignal, this.model);
    const piOptions = this.buildPiOptions(options, watchdog.signal, omitToolChoice);
    const trace =
      process.env.MOSS_TRACE_PI_AI_STREAM === '1' || process.env.MOSS_TRACE_PI_AI_STREAM === 'true';
    const state: PiAttemptState = {
      content: [],
      thinkingChunks: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      delivered: false,
      reportedUsage: false,
      eventTypeCounts: {},
    };

    try {
      for await (const event of this.streamFn(piModel, piContext, piOptions)) {
        watchdog.onActivity();
        if (trace) {
          const eventType = String((event as PiAiStreamEvent).type ?? 'unknown');
          state.eventTypeCounts[eventType] = (state.eventTypeCounts[eventType] ?? 0) + 1;
        }
        const llmEvent = convertStreamEvent(event);
        if (llmEvent) {
          state.delivered = true;
          onEvent?.(llmEvent);
        }
        const parsed = processEvent(
          event,
          state.content,
          this.repairToolCallUrl,
          state.thinkingChunks
        );
        if (parsed.stopReason) state.stopReason = parsed.stopReason;
        if (parsed.usage) {
          state.usage = parsed.usage;
          state.reportedUsage = true;
        }
        if (parsed.model) state.responseModel = parsed.model;
      }
    } catch (err) {
      const translated = watchdog.translateError(err);
      return {
        state,
        error: translated instanceof Error ? translated : new Error(String(translated)),
        timedOut: translated instanceof PiAiFirstEventTimeoutError,
      };
    } finally {
      watchdog.dispose();
    }

    return { state, error: null, timedOut: false };
  }

  /**
   * Compatibility retry for gateways that refuse a hard `tool_choice: required`
   * (e.g. thinking mode: "Thinking mode does not support this tool_choice").
   *
   * Exactly one extra physical request, only when Moss itself asked for
   * `required` on this request, the rejection is an HTTP 400/422 that names
   * tool_choice, and the failed attempt delivered nothing worth preserving.
   * The retry drops only the tool_choice parameter: same model, messages,
   * tools/schema, reasoning settings, extensions, limits and cancellation.
   */
  private async retryWithoutToolChoice(
    options: LLMRequestOptions,
    piContext: unknown,
    piModel: PiAiModelInfo,
    first: PiAttemptResult,
    onEvent?: (event: LLMStreamEvent) => void
  ): Promise<PiAttemptResult> {
    if (!this.shouldRetryWithoutToolChoice(options, first)) return first;
    log.warn('provider rejected required tool_choice; retrying once without it', {
      model: this.model.id,
      provider: this.model.provider,
      error: first.error?.message,
    });
    return this.runAttempt(options, piContext, piModel, true, onEvent);
  }

  private shouldRetryWithoutToolChoice(
    options: LLMRequestOptions,
    attempt: PiAttemptResult
  ): boolean {
    if (!attempt.error || attempt.timedOut) return false;
    if (options.abortSignal?.aborted) return false;
    // Anthropic Messages has its own tool_choice contract; this fallback is for
    // the OpenAI Chat Completions compatible path only.
    if (this.model.api === 'anthropic-messages') return false;
    // Only the `required` Moss raises for this run's logical request may be
    // relaxed. A requirement that exists only as an environment default never
    // reaches options.toolChoice, so it stays a hard requirement.
    if (options.toolChoice !== 'required') return false;
    const { state } = attempt;
    if (state.delivered || state.content.length > 0 || state.thinkingChunks.length > 0)
      return false;
    if (state.reportedUsage) return false;
    return isToolChoiceUnsupportedRejection(attempt.error);
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
    omitToolChoice = false
  ): Record<string, unknown> {
    const tcRaw = envPreferMoss('MOSS_PI_AI_TOOL_CHOICE', 'PI_AI_TOOL_CHOICE');
    const configuredToolChoice =
      tcRaw === 'required' || tcRaw === 'auto' || tcRaw === 'none' ? tcRaw : undefined;
    // A compatibility retry must not let the env/default layer refill the field
    // it is deliberately omitting.
    const toolChoice = omitToolChoice ? undefined : (options.toolChoice ?? configuredToolChoice);
    // `extraBody` is applied after tool_choice by the bundled transport, so a
    // tool_choice smuggled in the extension would defeat the retry.
    const extraBody =
      omitToolChoice && options.extraBody
        ? Object.fromEntries(
            Object.entries(options.extraBody).filter(([key]) => key !== 'tool_choice')
          )
        : options.extraBody;

    const effectiveSignal = overrideAbortSignal ?? options.abortSignal;

    let reasoningForPi: string | undefined;
    if (options.reasoning === null || options.reasoning === '') {
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
      ...(options.responseFormat
        ? {
            responseFormat: {
              type: 'json_schema',
              json_schema: { ...options.responseFormat, strict: true },
            },
          }
        : {}),
      ...(onPayload ? { onPayload } : {}),
      ...(extraBody ? { extraBody } : {}),
    };
  }
}
