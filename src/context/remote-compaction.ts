import type { ContentBlock, Message, ToolContentBlock } from '../contracts/messages.js';
import { createCompactionSummaryMessage } from '../contracts/messages.js';
import { estimateMessagesTokens } from './tokens.js';
import {
  buildCompactionSummary,
  type SummarizeFn,
  DEFAULT_COMPACTION_SETTINGS,
  MAX_SUMMARY_OUTPUT_TOKENS,
} from './compaction.js';
import { getRootLogger } from '../logger.js';
import { redactEgress } from '../safety/tool-output-redact.js';
import { isSecretArgumentFlag, isSecretFieldName } from '../safety/secret-sanitizer.js';
import { REDACTED } from '../safety/redact-patterns.js';
import { MossError, ErrorCode, errorMessage } from '../errors.js';

const log = getRootLogger().child('agent:remote-compact');

export function resolveRemoteCompactUrls(endpoint: string): {
  compactUrl: string;
  healthUrl: string;
} {
  const base = endpoint.trim().replace(/\/+$/, '');
  const compactUrl = base.endsWith('/compact') ? base : `${base}/compact`;
  return { compactUrl, healthUrl: `${compactUrl}/health` };
}

export interface RemoteCompactRequest {
  messages: Message[];
  systemPrompt?: string;
  maxOutputTokens: number;
  contextWindowTokens: number;
  model?: string;
  customInstructions?: string;
  abortSignal?: AbortSignal;
}

export interface RemoteCompactResponse {
  summary: string;
  compactedMessages?: Message[];
  tokensSaved: number;
  method: 'remote' | 'local_fallback';
}

export interface RemoteCompactProvider {
  compact(request: RemoteCompactRequest): Promise<RemoteCompactResponse>;
  isAvailable(): Promise<boolean>;
}

export interface HybridCompactionConfig {
  remoteProvider?: RemoteCompactProvider;
  localSummarize: SummarizeFn;
  contextWindowTokens: number;
  reserveTokens?: number;
  customInstructions?: string;
  abortSignal?: AbortSignal;
}

function redactSecretsInText(text: string): string {
  return redactEgress(text);
}

function sanitizeTextForRemote(value: string | undefined): string | undefined {
  return typeof value === 'string' ? redactSecretsInText(value) : undefined;
}

function sanitizeRemoteValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return '[non-text value withheld]';
  }
  if (depth >= 16 || seen.has(value)) return '[value withheld]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      let secretNext = false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const item = descriptor && 'value' in descriptor ? (descriptor.value as unknown) : null;
        const secretFlag = typeof item === 'string' && isSecretArgumentFlag(item);
        result.push(secretNext ? REDACTED : sanitizeRemoteValue(item, seen, depth + 1));
        secretNext = secretFlag;
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) continue;
      Object.defineProperty(result, redactSecretsInText(key), {
        value: isSecretFieldName(key)
          ? REDACTED
          : sanitizeRemoteValue(descriptor.value, seen, depth + 1),
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function sanitizeStructuredForRemote(block: ContentBlock): ToolContentBlock[] | undefined {
  if (!block.structuredContent) return undefined;
  const visibleText = typeof block.content === 'string' ? redactSecretsInText(block.content) : '';
  const textIsVisible = (text: string): boolean => visibleText.includes(redactSecretsInText(text));
  return block.structuredContent.flatMap((item): ToolContentBlock[] => {
    if (item.type === 'text') {
      return textIsVisible(item.text)
        ? [{ type: 'text', text: redactSecretsInText(item.text) }]
        : [];
    }
    if (item.type === 'resource') {
      return [
        {
          type: 'resource',
          uri: redactSecretsInText(item.uri),
          ...(item.name !== undefined ? { name: redactSecretsInText(item.name) } : {}),
          ...(item.mimeType !== undefined ? { mimeType: redactSecretsInText(item.mimeType) } : {}),
          ...(item.text !== undefined && textIsVisible(item.text)
            ? { text: redactSecretsInText(item.text) }
            : {}),
        },
      ];
    }
    // Remote compaction already omits image attachments; structured images must
    // follow the same policy rather than bypass it through tool metadata.
    return [
      {
        type: 'text',
        text: `[image attachment omitted for remote compaction: ${redactSecretsInText(item.mimeType)}]`,
      },
    ];
  });
}

function sanitizePayloadForRemote(messages: Message[]): Message[] {
  return messages.map((msg) => {
    const { content, thinking, ...rest } = msg;
    const safeRest = sanitizeRemoteValue(rest) as Omit<Message, 'content' | 'thinking'>;
    const joinedThinking = thinking?.join('\n\n');
    const safeThinking =
      joinedThinking === undefined ? undefined : redactSecretsInText(joinedThinking);
    const thinkingFields =
      thinking === undefined
        ? {}
        : { thinking: safeThinking === joinedThinking ? thinking : [safeThinking ?? ''] };
    if (typeof content === 'string') {
      return { ...safeRest, ...thinkingFields, content: redactSecretsInText(content) };
    }

    const result: ContentBlock[] = [];
    let textBlocks: ContentBlock[] = [];
    const flushTextBlocks = (): void => {
      if (textBlocks.length === 0) return;
      const joined = textBlocks.map((block) => block.text ?? '').join('\n');
      const redacted = redactSecretsInText(joined);
      if (redacted !== joined) {
        result.push({ type: 'text', text: redacted });
      } else {
        result.push(...(sanitizeRemoteValue(textBlocks) as ContentBlock[]));
      }
      textBlocks = [];
    };
    for (const block of content) {
      if (block.type === 'text') {
        textBlocks.push(block);
        continue;
      }
      flushTextBlocks();
      if (block.type === 'image') {
        result.push({
          type: 'text',
          text: `[image attachment omitted for remote compaction${block.filename ? `: ${redactSecretsInText(block.filename)}` : ''}]`,
        });
      } else {
        const { structuredContent: _structuredContent, ...restBlock } = block;
        const safeBlock = sanitizeRemoteValue(restBlock) as ContentBlock;
        const structuredContent =
          block.type === 'tool_result' ? sanitizeStructuredForRemote(block) : undefined;
        result.push({
          ...safeBlock,
          ...(structuredContent !== undefined ? { structuredContent } : {}),
        });
      }
    }
    flushTextBlocks();
    return { ...safeRest, ...thinkingFields, content: result };
  });
}

export class HttpRemoteCompactProvider implements RemoteCompactProvider {
  private readonly compactUrl: string;
  private readonly healthUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(params: { endpoint: string; apiKey?: string; timeoutMs?: number }) {
    const urls = resolveRemoteCompactUrls(params.endpoint);
    this.compactUrl = urls.compactUrl;
    this.healthUrl = urls.healthUrl;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs ?? 60_000;

    const isLocalhost = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(
      this.compactUrl
    );
    if (!isLocalhost && !this.compactUrl.startsWith('https://')) {
      throw new MossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message:
          'Remote compaction endpoint must use HTTPS for non-localhost URLs. ' +
          'Set MOSS_REMOTE_COMPACT_ENDPOINT to an https:// URL, or use localhost for development.',
      });
    }

    if (!isLocalhost && !this.apiKey) {
      throw new MossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message:
          'Remote compaction endpoint requires an API key for non-localhost URLs. ' +
          'Set MOSS_REMOTE_COMPACT_API_KEY.',
      });
    }
  }

  async isAvailable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(this.healthUrl, {
        signal: controller.signal,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async compact(request: RemoteCompactRequest): Promise<RemoteCompactResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = request.abortSignal
      ? AbortSignal.any([controller.signal, request.abortSignal])
      : controller.signal;

    try {
      const res = await fetch(this.compactUrl, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          messages: sanitizePayloadForRemote(request.messages),
          system_prompt: sanitizeTextForRemote(request.systemPrompt),
          max_output_tokens: request.maxOutputTokens,
          context_window_tokens: request.contextWindowTokens,
          model: sanitizeTextForRemote(request.model),
          custom_instructions: sanitizeTextForRemote(request.customInstructions),
        }),
      });

      if (!res.ok) {
        throw new MossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: `Remote compact failed: ${res.status} ${res.statusText}`,
        });
      }

      const MAX_BODY_BYTES = 10 * 1024 * 1024;
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
        throw new MossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: 'Remote compact response too large',
        });
      }

      let bodyText: string;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            throw new MossError({
              code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
              message: 'Remote compact response too large',
            });
          }
          chunks.push(value);
        }
        const body = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        bodyText = new TextDecoder().decode(body);
      } else {
        bodyText = await res.text();
      }

      const data = JSON.parse(bodyText) as {
        summary?: string;
        compacted_messages?: Message[];
        tokens_saved?: number;
      };

      const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
      if (!summary) {
        throw new MossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: 'Remote compact returned empty summary',
        });
      }

      const tokensSaved =
        typeof data.tokens_saved === 'number' && data.tokens_saved >= 0 ? data.tokens_saved : 0;

      let compactedMessages: Message[] | undefined;
      if (data.compacted_messages !== undefined) {
        if (!Array.isArray(data.compacted_messages)) {
          log.warn('remote compact returned non-array compacted_messages; ignoring', {
            type: typeof data.compacted_messages,
          });
        } else {
          compactedMessages = data.compacted_messages as Message[];
        }
      }

      return {
        summary,
        compactedMessages,
        tokensSaved,
        method: 'remote',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function hybridCompact(
  config: HybridCompactionConfig,
  messages: Message[],
  systemPrompt?: string
): Promise<{
  summary: string;
  summaryMessage: Message;
  method: 'remote' | 'local_fallback' | 'local_only';
  tokensSaved: number;
}> {
  const reserveTokens = config.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const maxOutputTokens = Math.min(
    Math.max(64, Math.floor(0.8 * reserveTokens)),
    MAX_SUMMARY_OUTPUT_TOKENS
  );
  const inputTokens = estimateMessagesTokens(messages);

  if (config.remoteProvider) {
    try {
      const available = await config.remoteProvider.isAvailable();
      if (available) {
        const result = await config.remoteProvider.compact({
          messages,
          systemPrompt,
          maxOutputTokens,
          contextWindowTokens: config.contextWindowTokens,
          customInstructions: config.customInstructions,
          abortSignal: config.abortSignal,
        });

        if (result.summary) {
          const summaryMessage = createCompactionSummaryMessage(result.summary, Date.now());
          log.info('remote compaction succeeded', {
            inputTokens,
            tokensSaved: result.tokensSaved,
            summaryLength: result.summary.length,
          });
          return {
            summary: result.summary,
            summaryMessage,
            method: 'remote',
            tokensSaved: result.tokensSaved,
          };
        }
      }
    } catch (err) {
      if (config.abortSignal?.aborted) {
        log.info('remote compaction aborted, not falling back to local');
        throw err;
      }
      log.warn('remote compaction failed, falling back to local', {
        error: errorMessage(err),
      });
    }
  }

  if (config.abortSignal?.aborted) {
    throw new Error('compaction aborted before local fallback');
  }

  const summary = await buildCompactionSummary({
    summarize: config.localSummarize,
    messages,
    contextWindowTokens: config.contextWindowTokens,
    maxTokens: maxOutputTokens,
    reserveTokens,
    customInstructions: config.customInstructions,
    abortSignal: config.abortSignal,
  });

  const summaryTokens = Math.ceil(summary.length / 4);
  const tokensSaved = Math.max(0, inputTokens - summaryTokens);
  const summaryMessage = createCompactionSummaryMessage(summary, Date.now());

  return {
    summary,
    summaryMessage,
    method: config.remoteProvider ? 'local_fallback' : 'local_only',
    tokensSaved,
  };
}

export function createRemoteCompactProviderFromEnv(): RemoteCompactProvider | undefined {
  const endpoint = process.env.MOSS_REMOTE_COMPACT_ENDPOINT?.trim();
  if (!endpoint) return undefined;

  return new HttpRemoteCompactProvider({
    endpoint,
    apiKey: process.env.MOSS_REMOTE_COMPACT_API_KEY?.trim(),
    timeoutMs: Number(process.env.MOSS_REMOTE_COMPACT_TIMEOUT_MS) || 60_000,
  });
}
