import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { MossAgent } from '../core/agent/moss-agent.js';
import { TaskRunLedger } from '../core/task-run/task-run-ledger.js';
import { ErrorCode, MossError, errorMessage } from '../errors.js';
import { WEB_CSS, WEB_HTML, WEB_JS } from './web-assets.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface MossWebServerOptions {
  port?: number;
  host?: string;
  abortSignal?: AbortSignal;
  /** Optional host-owned task ledger. Defaults to an in-memory ledger. */
  taskRunLedger?: TaskRunLedger;
  /** Optional JSONL path used when the server creates its own ledger. */
  taskRunFile?: string;
}

export interface MossWebServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly taskRuns: TaskRunLedger;
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
  const taskRuns = options.taskRunLedger ?? new TaskRunLedger(options.taskRunFile);
  taskRuns.recoverInterrupted();
  const active = new Map<string, AbortController>();
  const server = http.createServer((request, response) => {
    void handleRequest(agent, taskRuns, active, request, response).catch((error: unknown) => {
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
  return { url: `http://${host}:${address.port}`, host, port: address.port, taskRuns, close };
}

async function handleRequest(
  agent: MossAgent,
  taskRuns: TaskRunLedger,
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
      taskRuns: taskRuns.list(),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/runs')
    return sendJson(response, 200, { runs: taskRuns.list() });
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === 'GET' && runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const run = taskRuns.get(runId);
    return run
      ? sendJson(response, 200, { run, events: taskRuns.events(runId) })
      : sendJson(response, 404, { error: 'run not found' });
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
    let run = taskRuns
      .list()
      .find((candidate) => candidate.sessionId === sessionId && candidate.status === 'running');
    if (!run) {
      const runId = `run-${randomUUID()}`;
      run = taskRuns.create({ id: runId, sessionId, title: prompt.slice(0, 80) });
    }
    return streamPrompt(agent, taskRuns, active, run.id, sessionId, prompt, response);
  }
  const cancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    const sessionId = decodeURIComponent(cancelMatch[1]);
    const controller = active.get(sessionId);
    controller?.abort();
    active.delete(sessionId);
    const run = taskRuns.list().find((candidate) => candidate.sessionId === sessionId);
    if (controller && run && (run.status === 'created' || run.status === 'running'))
      taskRuns.append(run.id, { type: 'run.cancelled', data: { reason: 'user requested' } });
    return sendJson(response, 200, { sessionId, cancelled: Boolean(controller) });
  }
  sendJson(response, 404, { error: 'not found' });
}

async function streamPrompt(
  agent: MossAgent,
  taskRuns: TaskRunLedger,
  active: Map<string, AbortController>,
  runId: string,
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
    const before = taskRuns.get(runId);
    if (before?.status === 'created') {
      const run = taskRuns.append(runId, {
        type: 'run.started',
        data: { promptLength: prompt.length },
      });
      emit({ type: 'run', run });
    }
    for await (const event of agent.streamChat(sessionId, prompt, {
      abortSignal: controller.signal,
    })) {
      if (event.type === 'text_delta') emit({ type: 'text', delta: event.delta });
      if (event.type === 'thinking_delta') emit({ type: 'thought', delta: event.delta });
      if (event.type === 'tool_start') {
        taskRuns.append(runId, {
          type: 'tool.started',
          data: { toolCallId: event.toolCallId, name: event.toolName },
        });
        emit({
          type: 'tool',
          state: 'start',
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: event.input,
        });
      }
      if (event.type === 'tool_end') {
        taskRuns.append(runId, {
          type: event.isError ? 'tool.failed' : 'tool.succeeded',
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
          },
        });
        emit({
          type: 'tool',
          state: 'end',
          toolCallId: event.toolCallId,
          name: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      }
      if (event.type === 'turn_end') stopReason = event.stopReason;
    }
    const current = taskRuns.get(runId);
    const terminalType =
      stopReason === 'end_turn' || stopReason === 'stop_sequence' ? 'run.completed' : 'run.failed';
    const run =
      current?.status === 'running'
        ? taskRuns.append(runId, { type: terminalType, data: { stopReason } })
        : current;
    emit({ type: 'done', stopReason, run });
  } catch (error) {
    const current = taskRuns.get(runId);
    if (current?.status === 'running')
      taskRuns.append(runId, { type: 'run.failed', data: { message: errorMessage(error) } });
    emit({ type: 'error', message: errorMessage(error) });
  } finally {
    if (active.get(sessionId) === controller) active.delete(sessionId);
    response.end();
  }
}
