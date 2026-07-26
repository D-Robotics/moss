import { API_KEY, MODEL, BASE_URL, PROVIDER, type CliProviderPreset } from './config.js';
import type { MossCommunityAuthContext } from './community-auth.js';
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
} from '../core/llm/llm-provider.js';
import { buildApiV1Url } from '../provider/api-v1-url.js';
import { fetchWithConnectionContext } from '../provider/connection-error.js';
import { createProtocolRouter } from '../core/llm/protocol-route.js';
import { errorMessage } from '../errors.js';
import {
  MultiProviderRouter,
  parseFallbackProvidersEnv,
  parseFallbackMaxRetriesEnv,
  parseFallbackCooldownEnv,
  type FallbackProviderConfig,
} from '../provider/multi-provider-router.js';

export interface CliProviderRuntimeConfig {
  provider: CliProviderPreset;
  apiKey: string;
  model: string;
  baseUrl: string;
  usingBundledDefault?: boolean;
  communityAuth?: MossCommunityAuthContext;
  
  fallbackProviders?: FallbackProviderConfig[];
  
  fallbackMaxRetries?: number;
  
  fallbackCooldownMs?: number;
}

interface AnthropicResponse {
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model?: string;
}

interface OpenAIStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message?: string; type?: string; code?: string };
}

type AnthropicCliContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

function convertAnthropicCliContent(content: LLMRequestOptions['messages'][number]['content']) {
  if (typeof content === 'string') return content;
  const out: AnthropicCliContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType,
          data: block.data,
        },
      });
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    } else if (block.type === 'tool_result') {
      out.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      });
    }
  }
  return out.length > 0 ? out : '';
}



const PROTOCOL_ROUTER = createProtocolRouter<CliProviderRuntimeConfig>([
  { id: 'anthropic-messages', handle: callAnthropic },
  { id: 'openai-chat', handle: callOpenAI },
]);

export function createCliProvider(config: CliProviderRuntimeConfig): LLMProvider {
  const baseProvider: LLMProvider = {
    id: 'cli-provider',
    displayName: 'CLI LLM Provider',
    // OpenAI-compatible path streams SSE deltas; Anthropic CLI path still
    // buffers the full response but exposes the same stream() surface.
    capabilities: { streaming: true },

    async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
      return this.stream(opts, () => {});
    },

    async stream(
      opts: LLMRequestOptions,
      onEvent: (e: LLMStreamEvent) => void
    ): Promise<LLMResponse> {
      return PROTOCOL_ROUTER.resolve(config.provider).handle(config, opts, onEvent);
    },
  };

  
  const fallbacks = config.fallbackProviders ?? parseFallbackProvidersEnv();
  if (fallbacks.length > 0) {
    return new MultiProviderRouter({
      primary: baseProvider,
      createProvider: (fbConfig) =>
        createCliProvider({
          provider: normalizeProviderForRuntime(fbConfig.provider),
          apiKey: fbConfig.apiKey ?? config.apiKey,
          model: fbConfig.model ?? config.model,
          baseUrl: fbConfig.baseUrl ?? config.baseUrl,
          communityAuth: config.communityAuth,
        }),
      fallbacks,
      maxFallbacks: config.fallbackMaxRetries ?? parseFallbackMaxRetriesEnv(),
      cooldownMs: config.fallbackCooldownMs ?? parseFallbackCooldownEnv(),
    });
  }

  return baseProvider;
}


function normalizeProviderForRuntime(raw: string): CliProviderPreset {
  const lower = raw.trim().toLowerCase();
  if (lower === 'deepseek' || lower === 'ds') return 'deepseek';
  if (lower === 'qwen' || lower === 'aliyun' || lower === 'dashscope') return 'qwen';
  if (lower === 'openai') return 'openai';
  if (lower === 'anthropic' || lower === 'claude') return 'anthropic';
  if (lower === 'openai-compatible' || lower === 'compatible' || lower === 'custom')
    return 'openai-compatible';
  return 'deepseek';
}

export const cliProvider: LLMProvider = createCliProvider({
  provider: PROVIDER,
  apiKey: API_KEY,
  model: MODEL,
  baseUrl: BASE_URL,
});

export function providerErrorHint(status: number): string {
  if (status === 401 || status === 403)
    return ' — check your API key (moss setup or moss config set apiKey)';
  if (status === 400)
    return ' — model name not supported by this gateway; check the provider\'s model list (GET /v1/models) and run `/model` to pick an available one, or `moss setup` to reconfigure';
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

export function providerError(provider: string, status: number, text: string): Error {
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
  return new Error(
    `${provider} provider returned HTTP ${status}: ${detail || '(empty response body)'}${hint}${supportedModelsSuffix}`
  );
}

function communityAuthHeaders(config: CliProviderRuntimeConfig): Record<string, string> {
  if (!config.usingBundledDefault || !config.communityAuth?.accessToken) return {};
  return {
    'x-dmoss-community-access-token': config.communityAuth.accessToken,
  };
}

async function callAnthropic(
  config: CliProviderRuntimeConfig,
  opts: LLMRequestOptions,
  _onEvent: (e: LLMStreamEvent) => void
): Promise<LLMResponse> {
  const body = {
    model: opts.model || config.model,
    max_tokens: opts.maxTokens || 4096,
    system: opts.systemPrompt,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: convertAnthropicCliContent(m.content),
    })),
    tools: opts.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    stream: false,
  };

  const res = await fetchWithConnectionContext(buildApiV1Url(config.baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      ...communityAuthHeaders(config),
    },
    body: JSON.stringify(body),
    signal: opts.abortSignal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw providerError('Anthropic', res.status, text);
  }

  const data: AnthropicResponse = (await res.json()) as AnthropicResponse;
  const content: LLMContentBlock[] = (data.content || []).map((b) => {
    if (b.type === 'text') return { type: 'text' as const, text: b.text ?? '' };
    if (b.type === 'tool_use')
      return {
        type: 'tool_use' as const,
        id: b.id ?? '',
        name: b.name ?? '',
        input: b.input ?? {},
      };
    return { type: 'text' as const, text: '' };
  });

  return {
    content,
    stopReason: data.stop_reason as LLMResponse['stopReason'],
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
      : undefined,
    ...(data.model ? { model: data.model } : {}),
  };
}

function buildOpenAIMessages(opts: LLMRequestOptions): Array<Record<string, unknown>> {
  const openaiMessages: Array<Record<string, unknown>> = [];

  if (opts.systemPrompt) {
    openaiMessages.push({ role: 'system', content: opts.systemPrompt });
  }

  for (const m of opts.messages) {
    if (typeof m.content === 'string') {
      openaiMessages.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const textParts: string[] = [];
      const contentParts: Array<Record<string, unknown>> = [];
      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];

      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
          contentParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          contentParts.push({
            type: 'image_url',
            image_url: { url: `data:${block.mimeType};base64,${block.data}` },
          });
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === 'tool_result') {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }

      if (textParts.length > 0 || contentParts.length > 0 || toolCalls.length > 0) {
        const msg: Record<string, unknown> = { role: m.role };
        if (contentParts.some((part) => part.type === 'image_url')) {
          msg.content = contentParts;
        } else if (textParts.length > 0) {
          msg.content = textParts.join('\n');
        } else {
          msg.content = '';
        }
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        openaiMessages.push(msg);
      }
    }
  }

  return openaiMessages;
}

function enhanceOpenAIFetchError(config: CliProviderRuntimeConfig, err: unknown): never {
  if (config.usingBundledDefault && err instanceof Error) {
    err.message +=
      '\nThe built-in Moss gateway is unreachable — run `moss setup` to use your own model (DeepSeek/Qwen/OpenAI/Anthropic/any OpenAI-compatible), or retry later.';
  }
  throw err;
}

function enhanceOpenAIHttpError(
  config: CliProviderRuntimeConfig,
  status: number,
  text: string,
): Error {
  const error = providerError('OpenAI-compatible', status, text);
  if (
    config.usingBundledDefault &&
    (status === 429 || status === 402 || status === 503)
  ) {
    error.message +=
      '\nThe free built-in Moss model is over its shared quota right now — run `moss setup` to use your own model key (DeepSeek/Qwen/OpenAI/Anthropic/any OpenAI-compatible), or try again later.';
  }
  return error;
}

/**
 * Stream OpenAI-compatible chat.completions (SSE). Falls back to a single
 * non-stream JSON response when the gateway rejects streaming.
 */
async function callOpenAI(
  config: CliProviderRuntimeConfig,
  opts: LLMRequestOptions,
  onEvent: (e: LLMStreamEvent) => void
): Promise<LLMResponse> {
  const openaiMessages = buildOpenAIMessages(opts);
  const baseBody: Record<string, unknown> = {
    model: opts.model || config.model,
    max_tokens: opts.maxTokens || 4096,
    messages: openaiMessages,
  };
  if (opts.tools?.length) {
    baseBody.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (opts.extraBody) {
    Object.assign(baseBody, opts.extraBody);
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    ...communityAuthHeaders(config),
  };

  const streamBody = {
    ...baseBody,
    stream: true,
    stream_options: { include_usage: true },
  };

  let res: Response;
  try {
    res = await fetchWithConnectionContext(buildApiV1Url(config.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(streamBody),
      signal: opts.abortSignal,
    });
  } catch (err) {
    enhanceOpenAIFetchError(config, err);
  }

  // Some gateways reject stream/stream_options — fall back to one-shot JSON.
  if (!res.ok) {
    const errText = await res.text();
    const looksLikeStreamReject =
      res.status === 400 &&
      /stream|stream_options|streaming/i.test(errText);
    if (!looksLikeStreamReject) {
      throw enhanceOpenAIHttpError(config, res.status, errText);
    }
    try {
      res = await fetchWithConnectionContext(buildApiV1Url(config.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...baseBody, stream: false }),
        signal: opts.abortSignal,
      });
    } catch (err) {
      enhanceOpenAIFetchError(config, err);
    }
    if (!res.ok) {
      throw enhanceOpenAIHttpError(config, res.status, await res.text());
    }
    return parseOpenAINonStreamResponse(res, onEvent);
  }

  // Non-SSE JSON body (rare): treat as buffered complete.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && !contentType.includes('stream')) {
    // Some gateways still return application/json with stream:true ignored.
    const peek = res.headers.get('content-type') || '';
    if (peek.includes('application/json')) {
      return parseOpenAINonStreamResponse(res, onEvent);
    }
  }

  if (!res.body) {
    throw new Error('OpenAI-compatible provider: empty streaming response body');
  }

  return consumeOpenAISseStream(res.body, onEvent);
}

async function parseOpenAINonStreamResponse(
  res: Response,
  onEvent: (e: LLMStreamEvent) => void,
): Promise<LLMResponse> {
  const data: OpenAIResponse = (await res.json()) as OpenAIResponse;
  const choice = data.choices?.[0];
  const content: LLMContentBlock[] = [];

  onEvent({ type: 'message_start' });
  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
    onEvent({
      type: 'content_block_delta',
      text: choice.message.content,
      deltaRole: 'visible',
    });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch (err) {
        throw new Error(
          `CLI OpenAI-compatible provider: malformed tool call arguments for ${tc.function.name}: ${errorMessage(err)}`
        );
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
      onEvent({
        type: 'content_block_start',
        toolUse: { id: tc.id, name: tc.function.name },
      });
    }
  }

  const stopReason: LLMResponse['stopReason'] =
    choice?.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice?.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';
  onEvent({ type: 'message_delta', stopReason });
  onEvent({ type: 'message_stop' });

  return {
    content,
    stopReason,
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined,
    ...(data.model ? { model: data.model } : {}),
  };
}

async function consumeOpenAISseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: LLMStreamEvent) => void,
): Promise<LLMResponse> {
  const content: LLMContentBlock[] = [];
  let textBuffer = '';
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let stopReason: LLMResponse['stopReason'] = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;
  let responseModel: string | undefined;
  let sawDone = false;
  let sawFinishReason = false;

  onEvent({ type: 'message_start' });

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      sawDone = true;
      return;
    }

    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIStreamChunk;
    } catch (err) {
      throw new Error(
        `CLI OpenAI-compatible provider: malformed SSE JSON frame: ${errorMessage(err)}`
      );
    }

    if (chunk.error) {
      const label = chunk.error.type ?? 'error';
      throw new Error(
        `CLI OpenAI-compatible stream error (${label}): ${chunk.error.message ?? 'unknown'}`
      );
    }

    if (!responseModel && chunk.model) responseModel = chunk.model;
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    if (delta?.content) {
      textBuffer += delta.content;
      onEvent({
        type: 'content_block_delta',
        text: delta.content,
        deltaRole: 'visible',
      });
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
            onEvent({
              type: 'content_block_start',
              toolUse: { id: tc.id, name: tc.function?.name || '' },
            });
          }
        }
        const existing = toolCalls.get(idx)!;
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) {
          existing.arguments += tc.function.arguments;
          onEvent({ type: 'content_block_delta', partialJson: tc.function.arguments });
        }
      }
    }

    if (choice.finish_reason) {
      sawFinishReason = true;
      if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
      else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
      else stopReason = 'end_turn';
      onEvent({ type: 'message_delta', stopReason });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!sawDone && !sawFinishReason) {
    throw new Error(
      'CLI OpenAI-compatible provider: stream terminated without [DONE] or finish_reason'
    );
  }

  if (textBuffer) content.push({ type: 'text', text: textBuffer });
  for (const [, tc] of toolCalls) {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(tc.arguments || '{}');
    } catch (err) {
      throw new Error(
        `CLI OpenAI-compatible provider: malformed tool call arguments for ${tc.name}: ${errorMessage(err)}`
      );
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }

  onEvent({ type: 'message_stop' });

  return {
    content,
    stopReason,
    usage: { inputTokens, outputTokens },
    ...(responseModel ? { model: responseModel } : {}),
  };
}
