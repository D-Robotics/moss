/**
 * Single HTTP+SSE transport implementing the pi-ai StreamFunction surface for
 * the `anthropic-messages` and `openai-chat` wire protocols (D1 convergence).
 *
 * - openai-chat path is ported from the former cli/providers.ts private
 *   implementation: SSE consumption, non-stream fallback for gateways that
 *   reject `stream_options`, tool-call argument recovery, error hints and
 *   supported-models extraction are byte-compatible with the spec-locked
 *   behavior.
 * - anthropic-messages path is a native SSE consumer (adapted from the removed
 *   SDK anthropic provider), replacing the former buffered `stream:false` CLI
 *   call: first token now streams, thinking deltas surface as thinking events.
 *
 * The transport emits PiAiStreamEvent, so every call goes through the pi-ai
 * adapter (first-event watchdog, thinking round-trip policy, prompt
 * cache-control via `onPayload`) regardless of protocol.
 */
import type { PiAiStreamFunction, PiAiStreamEvent } from './pi-ai-adapter.js';
import type { Context as PiContext, Model as PiModel, SimpleStreamOptions } from './pi-ai-types.js';
import { buildApiV1Url } from './api-v1-url.js';
import { fetchWithConnectionContext } from './connection-error.js';
import { ErrorCode, errorMessage, MossError } from '../errors.js';

export interface HttpTransportConfig {
  /** Human-facing provider label used in error messages (e.g. 'Anthropic'). */
  providerLabel: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  usingBundledDefault?: boolean;
}

export function providerErrorHint(status: number): string {
  if (status === 401 || status === 403)
    return ' — check your API key (moss setup or moss config set apiKey)';
  if (status === 400)
    return " — model name not supported by this gateway; check the provider's model list (GET /v1/models) and run `/model` to pick an available one, or `moss setup` to reconfigure";
  if (status === 404)
    return ' — model or endpoint not found; run `/model` to pick an available one, or `moss setup` to reconfigure';
  if (status === 429) return ' — rate limited; retry shortly or lower request rate';
  if (status >= 500) return ' — gateway error; retry shortly';
  return '';
}

/**
 * Extract a supported-models list from an error response body.
 * Many gateways return something like:
 *   "Model 'xxx' not found. Supported models: [deepseek-chat, deepseek-coder, ...]"
 *   "The model 'xxx' does not exist. Available models: gpt-4o, gpt-4o-mini"
 * Returns the raw bracket/comma list string if found, or '' if not.
 */
function extractSupportedModelsList(text: string): string {
  // Try JSON parse first — many gateways wrap in {error:{message:...}}.
  let msg = text;
  try {
    const parsed = JSON.parse(text.replace(/\s+/g, ' ').trim());
    msg = parsed?.error?.message ?? parsed?.message ?? text;
  } catch {
    // not JSON, use raw text
  }
  // Match "Supported models: [...]" or "Available models: ..." (case-insensitive).
  const m = msg.match(/(?:supported|available)\s+models?\s*[:-]?\s*([^\n.]{5,})/i);
  if (m) return m[1].trim();
  return '';
}

export function providerError(provider: string, status: number, text: string): MossError {
  const compact = text.replace(/\s+/g, ' ').trim();
  let detail = compact;
  try {
    const parsed = JSON.parse(compact);
    const msg = parsed?.error?.message ?? parsed?.message;
    if (typeof msg === 'string' && msg.trim()) detail = msg.trim();
  } catch {
    // not JSON, use raw text
  }
  // For 400 errors, extract and append the supported-models list if present.
  // This helps the user see exactly which model names are valid, instead of
  // a truncated 300-char blob that might cut off the list.
  let supportedModelsSuffix = '';
  if (status === 400) {
    const list = extractSupportedModelsList(text);
    if (list) {
      supportedModelsSuffix = `\n  Supported models: ${list}`;
    }
  }
  // Allow more text for 400 (to preserve model lists); keep 300 for others.
  const maxLen = status === 400 ? 600 : 300;
  if (detail.length > maxLen) detail = `${detail.slice(0, maxLen)}…`;
  const hint = providerErrorHint(status);
  const code =
    status === 401 || status === 403
      ? ErrorCode.PROVIDER_AUTH_FAILED
      : status === 429
        ? ErrorCode.PROVIDER_RATE_LIMITED
        : ErrorCode.PROVIDER_UPSTREAM_ERROR;
  return new MossError({
    code,
    message: `${provider} provider returned HTTP ${status}: ${detail || '(empty response body)'}${hint}${supportedModelsSuffix}`,
    recoverable: status === 429 || status >= 500,
    context: { provider, status },
  });
}

// ─── shared SSE line reader ──────────────────────────────────────────────────

async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
      }
    }
    buffer += decoder.decode();
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ─── pi context → wire converters ────────────────────────────────────────────

type PiTextBlock = { type: 'text'; text: string };
type PiImageBlock = { type: 'image'; data: string; mimeType: string };
type PiThinkingBlock = { type: 'thinking'; thinking: string; thinkingSignature?: string };
type PiToolCallBlock = { type: 'toolCall'; id: string; name: string; arguments?: unknown };
type PiToolResultMessage = {
  role: 'toolResult';
  toolCallId: string;
  content: Array<PiTextBlock | PiImageBlock>;
  isError?: boolean;
};
type PiAssistantMessage = {
  role: 'assistant';
  content: Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock>;
};
type PiUserMessage = {
  role: 'user';
  content: string | Array<PiTextBlock | PiImageBlock>;
};
type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function piMessageText(content: Array<PiTextBlock | PiImageBlock>): string {
  return content
    .filter((block): block is PiTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function piAssistantThinkingText(message: PiAssistantMessage): string | undefined {
  const joined = message.content
    .filter(
      (block): block is PiThinkingBlock =>
        block.type === 'thinking' && block.thinkingSignature === 'reasoning_content'
    )
    .map((block) => block.thinking)
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return joined || undefined;
}

function piMessagesToAnthropic(context: PiContext): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const raws = (context.messages ?? []) as PiMessage[];
  for (let i = 0; i < raws.length; i++) {
    const msg = raws[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else {
        const blocks: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text });
          } else {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: block.mimeType, data: block.data },
            });
          }
        }
        out.push({ role: 'user', content: blocks });
      }
    } else if (msg.role === 'toolResult') {
      // Parallel tool results merge into ONE user message with multiple
      // tool_result blocks — providers scan back a bounded block window
      // from each cache breakpoint, and one-message-per-result fragments
      // the window (DashScope guidance).
      const blocks: Array<Record<string, unknown>> = [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: piMessageText(msg.content),
          ...(msg.isError !== undefined ? { is_error: msg.isError } : {}),
        },
      ];
      let lookahead = raws[i + 1];
      while (lookahead && (lookahead as PiMessage).role === 'toolResult') {
        i += 1;
        const next = lookahead as PiToolResultMessage;
        blocks.push({
          type: 'tool_result',
          tool_use_id: next.toolCallId,
          content: piMessageText(next.content),
          ...(next.isError !== undefined ? { is_error: next.isError } : {}),
        });
        lookahead = raws[i + 1];
      }
      out.push({ role: 'user', content: blocks });
    } else if (msg.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'toolCall') {
          blocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: isRecord(block.arguments) ? block.arguments : {},
          });
        }
        // pi thinking blocks are skipped on the anthropic wire: replaying
        // thinking without a valid Claude signature is rejected upstream.
      }
      out.push({ role: 'assistant', content: blocks });
    }
  }
  return out;
}

function piMessagesToOpenAI(
  context: PiContext
): Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }> {
  const out: Array<{
    role: string;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: string;
  }> = [];
  if (context.systemPrompt) {
    out.push({ role: 'system', content: context.systemPrompt });
  }
  for (const raw of context.messages ?? []) {
    const msg = raw as PiMessage;
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else {
        const textParts: string[] = [];
        const contentParts: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
            contentParts.push({ type: 'text', text: block.text });
          } else {
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
        if (textParts.length > 0 || contentParts.length > 0) {
          const imageCount = contentParts.filter((part) => part.type === 'image_url').length;
          out.push({
            role: 'user',
            content:
              imageCount > 0 ? contentParts : textParts.length > 0 ? textParts.join('\n') : '',
          });
        }
      }
    } else if (msg.role === 'toolResult') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: piMessageText(msg.content),
      });
    } else if (msg.role === 'assistant') {
      const text = msg.content
        .filter((block): block is PiTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const toolCalls = msg.content
        .filter((block): block is PiToolCallBlock => block.type === 'toolCall')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
        }));
      const entry: {
        role: string;
        content: string;
        tool_calls?: typeof toolCalls;
        reasoning_content?: string;
      } = { role: 'assistant', content: text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      const reasoning = piAssistantThinkingText(msg);
      if (reasoning) entry.reasoning_content = reasoning;
      out.push(entry);
    }
  }
  return out;
}

// ─── openai-chat protocol ────────────────────────────────────────────────────

interface OpenAIStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI-compatible implicit-cache report (e.g. DashScope). */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Best-effort recovery of a streaming tool-call arguments string that failed
 * JSON.parse. Streaming gateways (notably gemini-compatible ones) sometimes
 * resend already-sent chunks or append trailing garbage at chunk boundaries,
 * producing values like `{"command":"x"}{"command":"x"}` (duplicated) or
 * `{"command":"echo` (truncated). We try, in order: (1) the whole string,
 * (2) the first balanced JSON object in the string (drops trailing junk +
 * any duplicated second copy), (3) null — caller surfaces a soft error.
 */
function recoverToolCallArguments(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (!s) return {};
  // (1) whole string already tried by caller.
  // (2) first balanced {…} object — scans respecting string escapes so braces
  // inside string literals don't confuse the depth counter.
  let depth = 0;
  let inStr = false;
  let escape = false;
  let objStart = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const candidate = s.slice(objStart, i + 1);
        try {
          return JSON.parse(candidate) as Record<string, unknown>;
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  return null;
}

function enhanceOpenAIFetchError(config: HttpTransportConfig, err: unknown): never {
  if (config.usingBundledDefault && err instanceof Error) {
    err.message +=
      '\nThe built-in Moss gateway is unreachable — run `moss setup` to use your own model (DeepSeek/Qwen/OpenAI/Anthropic/any OpenAI-compatible), or retry later.';
  }
  throw err;
}

function enhanceOpenAIHttpError(config: HttpTransportConfig, status: number, text: string): Error {
  const error = providerError('OpenAI-compatible', status, text);
  if (config.usingBundledDefault && (status === 429 || status === 402 || status === 503)) {
    error.message +=
      '\nThe free built-in Moss model is over its shared quota right now — run `moss setup` to use your own model key (DeepSeek/Qwen/OpenAI/Anthropic/any OpenAI-compatible), or try again later.';
  }
  return error;
}

function mapOpenAiFinishReason(reason: string | null | undefined): string {
  if (reason === 'tool_calls') return 'toolCall';
  if (reason === 'length') return 'length';
  return 'stop';
}

async function* streamOpenAiChat(
  config: HttpTransportConfig,
  model: PiModel,
  context: PiContext,
  options: SimpleStreamOptions | undefined,
  extraBody: Record<string, unknown> | undefined
): AsyncGenerator<PiAiStreamEvent> {
  const signal = (options?.abortSignal ?? options?.signal) as AbortSignal | undefined;
  const baseBody: Record<string, unknown> = {
    model: model.id || config.model,
    max_tokens: options?.maxTokens ?? 4096,
    messages: piMessagesToOpenAI(context),
  };
  const tools = context.tools ?? [];
  if (tools.length > 0) {
    baseBody.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (options?.temperature !== undefined) baseBody.temperature = options.temperature;
  if (extraBody) Object.assign(baseBody, extraBody);
  if (options?.toolChoice) baseBody.tool_choice = options.toolChoice;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options?.apiKey ?? config.apiKey}`,
  };
  const endpoint = buildApiV1Url(model.baseUrl ?? config.baseUrl, 'chat/completions');
  const streamBody = {
    ...baseBody,
    stream: true,
    stream_options: { include_usage: true },
  };

  let res: Response;
  try {
    res = await fetchWithConnectionContext(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamBody),
      signal,
    });
  } catch (err) {
    enhanceOpenAIFetchError(config, err);
  }

  // Some gateways reject stream/stream_options — fall back to one-shot JSON.
  if (!res.ok) {
    const errText = await res.text();
    const looksLikeStreamReject =
      res.status === 400 && /stream|stream_options|streaming/i.test(errText);
    if (!looksLikeStreamReject) {
      throw enhanceOpenAIHttpError(config, res.status, errText);
    }
    try {
      res = await fetchWithConnectionContext(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...baseBody, stream: false }),
        signal,
      });
    } catch (err) {
      enhanceOpenAIFetchError(config, err);
    }
    if (!res.ok) {
      throw enhanceOpenAIHttpError(config, res.status, await res.text());
    }
    yield* parseOpenAiBuffered(res);
    return;
  }

  // Some gateways still return application/json with stream:true ignored.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && contentType.includes('application/json')) {
    yield* parseOpenAiBuffered(res);
    return;
  }

  if (!res.body) {
    throw new Error('OpenAI-compatible provider: empty streaming response body');
  }

  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let stopReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let sawDone = false;
  let sawFinishReason = false;

  for await (const payload of sseDataLines(res.body)) {
    if (!payload) continue;
    if (payload === '[DONE]') {
      sawDone = true;
      continue;
    }

    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIStreamChunk;
    } catch (err) {
      throw new Error(`OpenAI-compatible provider: malformed SSE JSON frame: ${errorMessage(err)}`);
    }

    if (chunk.error) {
      const label = chunk.error.type ?? 'error';
      throw new Error(
        `OpenAI-compatible stream error (${label}): ${chunk.error.message ?? 'unknown'}`
      );
    }

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
      cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta?.content) {
      yield { type: 'text_delta', delta: delta.content };
    }
    if (delta?.reasoning_content) {
      yield { type: 'thinking_delta', delta: delta.reasoning_content };
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, {
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: '',
          });
          if (tc.id) {
            yield {
              type: 'toolcall_start',
              toolCall: { id: tc.id, name: tc.function?.name || '' },
            };
          }
        }
        const existing = toolCalls.get(idx)!;
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) {
          existing.arguments += tc.function.arguments;
        }
      }
    }

    if (choice.finish_reason) {
      sawFinishReason = true;
      stopReason = mapOpenAiFinishReason(choice.finish_reason);
    }
  }

  if (!sawDone && !sawFinishReason) {
    throw new Error(
      'OpenAI-compatible provider: stream terminated without [DONE] or finish_reason'
    );
  }

  for (const [, tc] of toolCalls) {
    let input: Record<string, unknown> | null = null;
    const raw = tc.arguments || '{}';
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Streaming gateways (notably gemini-compatible ones) sometimes resend
      // already-sent argument chunks or append trailing garbage at chunk
      // boundaries. A single malformed tool call must not abort the whole
      // stream — recover gracefully so the model can proceed.
      input = recoverToolCallArguments(raw);
    }
    if (input) {
      yield { type: 'toolcall_end', toolCall: { id: tc.id, name: tc.name, arguments: input } };
    } else {
      // Could not recover — surface as a soft error so the model sees the
      // bad call and can resend it, instead of crashing the turn.
      yield { type: 'toolcall_end', toolCall: { id: tc.id, name: tc.name, arguments: {} } };
      yield {
        type: 'text_delta',
        delta: `[malformed tool call arguments recovered as empty — ${tc.name} arguments were not valid JSON; resend this tool call with valid JSON]`,
      };
    }
  }

  const doneUsage: { input: number; output: number } = {
    input: inputTokens,
    output: outputTokens,
  };
  if (cachedTokens > 0) {
    (doneUsage as Record<string, number>).cacheRead = cachedTokens;
  }
  yield { type: 'done', stopReason, usage: doneUsage };
}

async function* parseOpenAiBuffered(res: Response): AsyncGenerator<PiAiStreamEvent> {
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const choice = data.choices?.[0];
  if (choice?.message?.content) {
    yield { type: 'text_delta', delta: choice.message.content };
  }
  if (choice?.message?.reasoning_content) {
    yield { type: 'thinking_delta', delta: choice.message.reasoning_content };
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `OpenAI-compatible provider: malformed tool call arguments for ${tc.function.name}: ${errorMessage(err)}`
        );
      }
      yield {
        type: 'toolcall_end',
        toolCall: { id: tc.id, name: tc.function.name, arguments: input },
      };
    }
  }
  const bufferedUsage: { input: number; output: number } = {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
  };
  const bufferedCached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  if (bufferedCached > 0) {
    (bufferedUsage as Record<string, number>).cacheRead = bufferedCached;
  }
  yield {
    type: 'done',
    stopReason: mapOpenAiFinishReason(choice?.finish_reason),
    usage: bufferedUsage,
  };
}

// ─── anthropic-messages protocol ─────────────────────────────────────────────

interface AnthropicSseEvent {
  type: string;
  index?: number;
  delta?: Record<string, unknown>;
  content_block?: Record<string, unknown>;
  message?: { usage?: Record<string, number> };
  usage?: Record<string, number>;
  error?: { type?: string; message?: string };
}

function mapAnthropicStopReason(reason: string | undefined): string {
  if (reason === 'tool_use') return 'toolCall';
  if (reason === 'max_tokens') return 'length';
  return 'stop';
}

/**
 * Rolling cache breakpoint: mark the last content block of the last message
 * so each turn hits the previous turn's cached prefix and writes the new
 * tail (hit-old + create-new rolling pattern). Two markers total with the
 * stable-system one, well under the provider limit of four.
 */
function applyRollingCacheBreakpoint(body: Record<string, unknown>): void {
  const messages = body.messages as Array<{ content?: unknown }> | undefined;
  const last = messages?.[messages.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const block = last.content[last.content.length - 1] as Record<string, unknown> | undefined;
  if (block && typeof block === 'object' && !('cache_control' in block)) {
    block.cache_control = { type: 'ephemeral' };
  }
}

async function* streamAnthropicMessages(
  config: HttpTransportConfig,
  model: PiModel,
  context: PiContext,
  options: SimpleStreamOptions | undefined
): AsyncGenerator<PiAiStreamEvent> {
  const signal = (options?.abortSignal ?? options?.signal) as AbortSignal | undefined;
  const tools = context.tools ?? [];
  const body: Record<string, unknown> = {
    model: model.id || config.model,
    max_tokens: options?.maxTokens ?? 4096,
    system: context.systemPrompt ?? '',
    messages: piMessagesToAnthropic(context),
    stream: true,
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (options?.temperature !== undefined) body.temperature = options.temperature;

  // The pi-ai adapter injects prompt cache-control block splitting here.
  options?.onPayload?.(body);
  applyRollingCacheBreakpoint(body);

  const res = await fetchWithConnectionContext(
    buildApiV1Url(model.baseUrl ?? config.baseUrl, 'messages'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options?.apiKey ?? config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw providerError('Anthropic', res.status, text);
  }
  if (!res.body) {
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: 'Anthropic API returned no body',
    });
  }

  const openTools = new Map<number, { id: string; name: string; json: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let stopReason = 'stop';

  for await (const payload of sseDataLines(res.body)) {
    if (!payload || payload === '[DONE]') continue;

    let event: AnthropicSseEvent;
    try {
      event = JSON.parse(payload) as AnthropicSseEvent;
    } catch (err) {
      throw new MossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'Anthropic provider: malformed SSE JSON frame',
        hint: 'The upstream API or gateway returned an invalid streaming payload.',
        recoverable: true,
        cause: err,
        context: { payload: payload.slice(0, 200) },
      });
    }

    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          cacheReadTokens = usage.cache_read_input_tokens ?? 0;
          cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
        }
        break;
      }
      case 'content_block_start': {
        const block = event.content_block;
        const index = event.index ?? -1;
        if (block?.type === 'tool_use') {
          const id = String(block.id || '');
          const name = String(block.name || '');
          openTools.set(index, { id, name, json: '' });
          yield { type: 'toolcall_start', toolCall: { id, name } };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text_delta', delta: delta.text };
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'thinking_delta', delta: delta.thinking };
        } else if (
          delta?.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string' &&
          openTools.has(event.index ?? -1)
        ) {
          openTools.get(event.index ?? -1)!.json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const index = event.index ?? -1;
        const open = openTools.get(index);
        if (open) {
          openTools.delete(index);
          let input: Record<string, unknown> | null = null;
          try {
            input = JSON.parse(open.json || '{}') as Record<string, unknown>;
          } catch {
            input = recoverToolCallArguments(open.json);
          }
          if (input) {
            yield {
              type: 'toolcall_end',
              toolCall: { id: open.id, name: open.name, arguments: input },
            };
          } else {
            yield {
              type: 'toolcall_end',
              toolCall: {
                id: open.id,
                name: open.name,
                arguments: {},
                partialArgs: open.json,
                partial: true,
              },
            };
          }
        }
        break;
      }
      case 'message_delta': {
        const delta = event.delta;
        if (delta && typeof delta.stop_reason === 'string') {
          stopReason = mapAnthropicStopReason(delta.stop_reason);
        }
        if (event.usage) {
          outputTokens = event.usage.output_tokens ?? outputTokens;
        }
        break;
      }
      case 'message_stop': {
        const usage: { input: number; output: number } = {
          input: inputTokens,
          output: outputTokens,
        };
        const loose = usage as Record<string, number>;
        loose.cacheRead = cacheReadTokens;
        loose.cacheWrite = cacheCreationTokens;
        yield { type: 'done', stopReason, usage };
        break;
      }
      case 'error': {
        throw new MossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: `Anthropic stream error (${event.error?.type ?? 'error'}): ${event.error?.message ?? 'unknown'}`,
          recoverable: true,
        });
      }
      default:
        break;
    }
  }
}

// ─── public factory ──────────────────────────────────────────────────────────

/**
 * Create the single HTTP transport used by the CLI provider stack. Dispatches
 * on the pi model's `api` field; unknown apis fall back to openai-chat (the
 * permissive gateway convention).
 */
export function createHttpStreamFunction(config: HttpTransportConfig): PiAiStreamFunction {
  return (model, context, options) => {
    const extraBody =
      options && 'extraBody' in options && isRecord(options.extraBody)
        ? (options.extraBody as Record<string, unknown>)
        : undefined;
    async function* run(): AsyncGenerator<PiAiStreamEvent> {
      const piContext = context as PiContext;
      const piOptions = options as SimpleStreamOptions | undefined;
      if (model.api === 'anthropic-messages') {
        yield* streamAnthropicMessages(config, model, piContext, piOptions);
      } else {
        yield* streamOpenAiChat(config, model, piContext, piOptions, extraBody);
      }
    }
    return run();
  };
}
