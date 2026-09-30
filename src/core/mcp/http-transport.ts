/**
 * MCP streamable HTTP transport — one POST round-trip per JSON-RPC message.
 *
 * Per the streamable HTTP spec: the client POSTs JSON-RPC to the endpoint and
 * accepts either an `application/json` body (single response) or a
 * `text/event-stream` body (SSE; the response for our request arrives as a
 * `data:` event — after which the stream may be closed). The server-assigned
 * `mcp-session-id` response header is captured at initialize and sent back on
 * every subsequent request, along with `MCP-Protocol-Version`.
 *
 * No legacy HTTP+SSE long-connection mode, no OAuth. Requests are serialized
 * per transport (MCP sessions are sequential in practice, and this keeps the
 * session-id handshake simple).
 */
import { MossError, ErrorCode, errorMessage } from '../../errors.js';
import { getRootLogger } from '../../logger.js';
import type {
  InboundJsonRpcMessage,
  McpTransport,
  McpTransportRequestOptions,
  McpServerConfig,
  McpConnectionState,
} from './types.js';

const log = getRootLogger().child('mcp:http');

const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap on a non-2xx error body read (diagnostics only). */
const MAX_ERROR_BODY_CHARS = 4 * 1024;

type UndiciModule = typeof import('undici');

let undiciModule: UndiciModule | null = null;

async function loadUndici(): Promise<UndiciModule> {
  if (undiciModule) return undiciModule;
  try {
    undiciModule = (await import('undici')) as UndiciModule;
    return undiciModule;
  } catch (err) {
    throw new MossError({
      code: ErrorCode.TOOL_EXECUTION_FAILED,
      message: 'mcp http transport requires the undici dependency, which is unavailable',
      hint: 'Install the optional undici peer dependency or use stdio servers.',
      recoverable: false,
      cause: err,
    });
  }
}

export class McpHttpTransport implements McpTransport {
  readonly kind = 'http' as const;

  private endpoint: URL;
  private nextId = 1;
  private queueTail: Promise<unknown> = Promise.resolve();
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;

  private _state: McpConnectionState = 'disconnected';
  private _lastError: string | undefined;

  constructor(private readonly config: McpServerConfig) {
    const raw = config.url;
    if (!raw) {
      this._state = 'failed';
      this._lastError = 'missing required field "url" for http transport';
      this.endpoint = new URL('http://localhost.invalid/');
      return;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`unsupported protocol ${parsed.protocol}`);
      }
      this.endpoint = parsed;
    } catch (err) {
      this._state = 'failed';
      this._lastError = `invalid url: ${errorMessage(err)}`;
      this.endpoint = new URL('http://localhost.invalid/');
    }
  }

  get state(): McpConnectionState {
    return this._state;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  /** The negotiated protocol version (sent back as `MCP-Protocol-Version`). */
  setNegotiatedProtocolVersion(version: string | undefined): void {
    this.protocolVersion = version;
  }

  async start(_timeoutMs: number): Promise<void> {
    if (this._state === 'failed') {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `mcp server "${this.config.name}": ${this._lastError ?? 'invalid http config'}`,
        recoverable: false,
      });
    }
    if (this._state === 'closed') {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp http transport for "${this.config.name}" is closed`,
        recoverable: false,
      });
    }
    await loadUndici();
    this._state = 'connected';
    this._lastError = undefined;
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    opts?: McpTransportRequestOptions
  ): Promise<unknown> {
    if (this._state !== 'connected') {
      return Promise.reject(
        new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `mcp server "${this.config.name}" is not connected (state: ${this._state})`,
          ...(this._lastError ? { hint: this._lastError } : {}),
          recoverable: false,
        })
      );
    }
    const id = this.nextId++;
    // Serialize requests: each POST carries the full session state (session id
    // header), so concurrent in-flight requests could race the handshake.
    const run = this.queueTail.then(
      () => this.roundTrip(id, method, params, opts),
      () => this.roundTrip(id, method, params, opts)
    );
    this.queueTail = run.catch(() => {});
    return run;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this._state !== 'connected') return;
    // Enqueue like requests: the server must observe notifications in order
    // (notifications/initialized before any subsequent request).
    const send = () =>
      this.postNotification(method, params).catch((err) => {
        log.debug('notification failed', {
          server: this.config.name,
          method,
          error: errorMessage(err),
        });
      });
    this.queueTail = this.queueTail.then(send, send);
  }

  async close(): Promise<void> {
    this._state = this._state === 'disconnected' ? 'disconnected' : 'closed';
    await this.queueTail.catch(() => {});
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}),
    };
  }

  private async roundTrip(
    id: number,
    method: string,
    params: Record<string, unknown> | undefined,
    opts: McpTransportRequestOptions | undefined
  ): Promise<unknown> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const onOuterAbort = () => controller.abort();
    opts?.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (opts?.signal?.aborted) controller.abort();

    try {
      const { request } = await loadUndici();
      const res = await request(this.endpoint.toString(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        }),
        signal: controller.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const headerSession = headerValue(res.headers, 'mcp-session-id');
      if (headerSession) this.sessionId = headerSession;

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const bodyText = (await readCapped(res.body, MAX_ERROR_BODY_CHARS)).text;
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `mcp server "${this.config.name}" HTTP ${res.statusCode} for "${method}"${bodyText ? `: ${bodyText.slice(0, 400)}` : ''}`,
          ...(res.statusCode === 401 || res.statusCode === 403
            ? {
                hint: 'The server rejected the configured credentials (check the ${ENV_VAR} expansion in mcp.json headers).',
              }
            : {}),
          recoverable: true,
        });
      }

      const contentType = (headerValue(res.headers, 'content-type') ?? '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        return await this.readSseResponse(res.body, id);
      }
      const bodyText = (await readCapped(res.body, MAX_LINE_BYTES_SAFE)).text;
      let msg: InboundJsonRpcMessage;
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        msg = parsed as InboundJsonRpcMessage;
      } catch (err) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `mcp server "${this.config.name}" returned a non-JSON body for "${method}"`,
          recoverable: true,
          cause: err,
        });
      }
      return this.settleMessage(msg, id, method);
    } catch (err) {
      if (err instanceof MossError) throw err;
      const aborted = opts?.signal?.aborted === true || controller.signal.aborted;
      if (aborted && opts?.signal?.aborted === true) {
        throw new MossError({
          code: ErrorCode.USER_ABORTED,
          message: `mcp request "${method}" to "${this.config.name}" aborted`,
          recoverable: true,
          cause: err,
        });
      }
      if (controller.signal.aborted) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
          message: `mcp request "${method}" to "${this.config.name}" timed out after ${timeoutMs}ms`,
          hint: 'The server did not answer in time; it may be overloaded or unreachable.',
          recoverable: true,
          cause: err,
        });
      }
      this._lastError = errorMessage(err);
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp request "${method}" to "${this.config.name}" failed: ${this._lastError}`,
        hint: 'Check the server URL, network connectivity, and proxy settings.',
        recoverable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** Parse an SSE body; resolve on the response matching our request id. */
  private async readSseResponse(
    body: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
    id: number
  ): Promise<unknown> {
    try {
      let buffer = '';
      for await (const chunk of body) {
        buffer += Buffer.from(chunk).toString('utf-8');
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const eventBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = eventBlock
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
          if (data) {
            try {
              const parsed: unknown = JSON.parse(data);
              if (typeof parsed === 'object' && parsed !== null) {
                const msg = parsed as InboundJsonRpcMessage;
                if (msg.id !== undefined && msg.id !== null) {
                  return this.settleMessage(msg, id, 'sse-response');
                }
              }
            } catch {
              // ignore malformed keep-alive events
            }
          }
          sep = buffer.indexOf('\n\n');
        }
      }
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp server "${this.config.name}" closed the SSE stream without answering`,
        recoverable: true,
      });
    } finally {
      // The response arrived — the server may keep the stream open for
      // notifications; we don't consume them, so tear the stream down.
      try {
        body.destroy?.();
      } catch {}
    }
  }

  private settleMessage(msg: InboundJsonRpcMessage, id: number, method: string): unknown {
    if (msg.id !== id) {
      // Serialized queue means this is unexpected, not fatal.
      log.debug('response id mismatch', { server: this.config.name, method });
    }
    if (msg.error) {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp server "${this.config.name}": ${msg.error.message} (code ${msg.error.code})`,
        recoverable: true,
      });
    }
    return msg.result;
  }

  private async postNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const { request } = await loadUndici();
    const res = await request(this.endpoint.toString(), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    // Drain whatever body came back so the socket is reusable.
    await readCapped(res.body, MAX_ERROR_BODY_CHARS);
  }
}

const MAX_LINE_BYTES_SAFE = 4 * 1024 * 1024;

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readCapped(
  body: (AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void }) | null,
  maxChars: number
): Promise<{ text: string }> {
  if (!body) return { text: '' };
  let out = '';
  try {
    for await (const chunk of body) {
      out += Buffer.from(chunk).toString('utf-8');
      if (out.length >= maxChars) {
        out = out.slice(0, maxChars);
        break;
      }
    }
  } finally {
    try {
      body.destroy?.();
    } catch {}
  }
  return { text: out };
}
