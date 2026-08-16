import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { MossAgent } from '../core/agent/moss-agent.js';
import { ErrorCode, MossError, errorMessage } from '../errors.js';
import { WEB_CSS, WEB_HTML, WEB_JS } from './web-assets.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface MossWebServerOptions {
  port?: number;
  host?: string;
  abortSignal?: AbortSignal;
}

export interface MossWebServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function sendAsset(response: http.ServerResponse, type: string, body: string): void {
  response.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  response.end(body);
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: 'web request body exceeds 64 KiB',
      });
    }
  }
  if (!body) return {};
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message: 'expected a JSON object' });
  }
  return parsed as Record<string, unknown>;
}

function isLocalOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Start the local Moss browser host around an existing fully composed agent. @internal */
export async function startMossWebServer(
  agent: MossAgent,
  options: MossWebServerOptions = {}
): Promise<MossWebServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const active = new Map<string, AbortController>();
  const server = http.createServer((request, response) => {
    void handleRequest(agent, active, request, response).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 400, { error: errorMessage(error) });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3080, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    })();
    return closePromise;
  };
  options.abortSignal?.addEventListener('abort', () => void close().catch(() => {}), {
    once: true,
  });
  return { url: `http://${host}:${address.port}`, host, port: address.port, close };
}

async function handleRequest(
  agent: MossAgent,
  active: Map<string, AbortController>,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://moss.local');
  if (request.method === 'GET' && url.pathname === '/')
    return sendAsset(response, 'text/html', WEB_HTML);
  if (request.method === 'GET' && url.pathname === '/styles.css')
    return sendAsset(response, 'text/css', WEB_CSS);
  if (request.method === 'GET' && url.pathname === '/app.js')
    return sendAsset(response, 'text/javascript', WEB_JS);
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(response, 200, {
      tools: agent.tools.getNames(),
      plugins: agent.plugins.inspect().plugins,
    });
  }
  if (!isLocalOrigin(request)) return sendJson(response, 403, { error: 'non-local origin denied' });
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    const sessionId = `web-${randomUUID()}`;
    await agent.config.sessionStore.replaceMessages(sessionId, []);
    return sendJson(response, 201, { sessionId });
  }
  const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (request.method === 'POST' && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    const body = await readJson(request);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJson(response, 400, { error: 'prompt is required' });
    return streamPrompt(agent, active, sessionId, prompt, response);
  }
  const cancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    const sessionId = decodeURIComponent(cancelMatch[1]);
    const controller = active.get(sessionId);
    controller?.abort();
    active.delete(sessionId);
    return sendJson(response, 200, { sessionId, cancelled: Boolean(controller) });
  }
  sendJson(response, 404, { error: 'not found' });
}

async function streamPrompt(
  agent: MossAgent,
  active: Map<string, AbortController>,
  sessionId: string,
  prompt: string,
  response: http.ServerResponse
): Promise<void> {
  active.get(sessionId)?.abort();
  const controller = new AbortController();
  active.set(sessionId, controller);
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  const emit = (value: unknown) => response.write(`${JSON.stringify(value)}\n`);
  let stopReason = 'end_turn';
  try {
    for await (const event of agent.streamChat(sessionId, prompt, {
      abortSignal: controller.signal,
    })) {
      if (event.type === 'text_delta') emit({ type: 'text', delta: event.delta });
      if (event.type === 'thinking_delta') emit({ type: 'thought', delta: event.delta });
      if (event.type === 'tool_start')
        emit({
          type: 'tool',
          state: 'start',
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: event.input,
        });
      if (event.type === 'tool_end')
        emit({
          type: 'tool',
          state: 'end',
          toolCallId: event.toolCallId,
          name: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      if (event.type === 'turn_end') stopReason = event.stopReason;
    }
    emit({ type: 'done', stopReason });
  } catch (error) {
    emit({ type: 'error', message: errorMessage(error) });
  } finally {
    if (active.get(sessionId) === controller) active.delete(sessionId);
    response.end();
  }
}
