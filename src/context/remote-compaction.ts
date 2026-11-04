import type { Message } from '../contracts/messages.js';
import { MossError, ErrorCode } from '../errors.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';

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
}

export interface RemoteCompactProvider {
  compact(request: RemoteCompactRequest): Promise<RemoteCompactResponse>;
  isAvailable(): Promise<boolean>;
}

function redactSecretsInText(text: string): string {
  return sanitizeSecrets(text);
}

function sanitizeTextForRemote(value: string | undefined): string | undefined {
  return typeof value === 'string' ? redactSecretsInText(value) : undefined;
}

function sanitizePayloadForRemote(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { ...msg, content: redactSecretsInText(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (block.type === 'text' && block.text) {
            return { ...block, text: redactSecretsInText(block.text) };
          }
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            return { ...block, content: redactSecretsInText(block.content) };
          }
          if (block.type === 'image') {
            return {
              type: 'text',
              text: `[image attachment omitted for remote compaction${block.filename ? `: ${block.filename}` : ''}]`,
            };
          }
          return block;
        }),
      };
    }
    return msg;
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
          model: request.model,
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

      const data = JSON.parse(bodyText) as { summary?: unknown };
      const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
      if (!summary) {
        throw new MossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: 'Remote compact returned empty summary',
        });
      }

      return { summary };
    } finally {
      clearTimeout(timer);
    }
  }
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
