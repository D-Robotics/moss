import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP, type AddressInfo } from 'node:net';
import path from 'node:path';
import type { MossAgent } from '../core/agent/moss-agent.js';
import { TaskRunLedger } from '../core/task-run/task-run-ledger.js';
import { ErrorCode, MossError, errorMessage } from '../errors.js';
import { InstalledPluginRegistry } from '../plugins/installed-plugin-registry.js';
import { readMossPluginManifest } from '../plugins/installed-plugin-registry.js';
import { WEB_HTML } from './web-assets.js';

const MAX_BODY_BYTES = 64 * 1024;

interface ActiveWebContribution {
  readonly pluginId: string;
  readonly id: string;
  readonly slot: string;
  readonly moduleUrl: string;
  readonly source: string;
}

/** Options for the loopback Moss Web host. @beta */
export interface MossWebServerOptions {
  port?: number;
  host?: string;
  abortSignal?: AbortSignal;
  /** Optional host-owned task ledger. Defaults to an in-memory ledger. */
  taskRunLedger?: TaskRunLedger;
  /** Optional JSONL path used when the server creates its own ledger. */
  taskRunFile?: string;
  /** Config root used by the explicit installed-plugin registry. */
  configDir?: string;
}

/** Running loopback Moss Web host. @beta */
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

async function sendClientAsset(
  response: http.ServerResponse,
  filename: 'workbench.css' | 'workbench.js'
): Promise<void> {
  const body = await readFile(new URL(`./client/${filename}`, import.meta.url), 'utf8');
  sendAsset(response, filename.endsWith('.css') ? 'text/css' : 'text/javascript', body);
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

function isExpectedHost(request: http.IncomingMessage, expectedOrigin: string): boolean {
  try {
    return request.headers.host === new URL(expectedOrigin).host;
  } catch {
    return false;
  }
}

function formatHttpOrigin(host: string, port: number): string {
  const hostname = isIP(host) === 6 && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

function isLocalOrigin(request: http.IncomingMessage, expectedOrigin: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

async function listWebSessions(
  agent: MossAgent,
  taskRuns: TaskRunLedger
): Promise<
  Array<{
    sessionId: string;
    title: string;
    updatedAt: number;
    messageCount: number;
    runId?: string;
    runStatus?: string;
  }>
> {
  const stored = await agent.config.sessionStore.listSessions();
  const runs = taskRuns.list();
  const bySession = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!bySession.has(run.sessionId)) bySession.set(run.sessionId, run);
  }
  return stored
    .filter((session) => session.messageCount > 0 || bySession.has(session.sessionKey))
    .map((session) => {
      const run = bySession.get(session.sessionKey);
      return {
        sessionId: session.sessionKey,
        title: run?.title ?? session.title ?? 'Untitled task',
        updatedAt: Math.max(session.updatedAt, run?.updatedAt ?? 0),
        messageCount: session.messageCount,
        ...(run ? { runId: run.id, runStatus: run.status } : {}),
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

async function sessionTimeline(agent: MossAgent, sessionId: string): Promise<unknown[]> {
  const messages = await agent.config.sessionStore.loadMessages(sessionId);
  const timeline: unknown[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (typeof message.content === 'string') {
      if (message.content) {
        timeline.push({
          id: `message-${messageIndex}`,
          kind: message.role === 'user' ? 'user' : 'assistant',
          text: message.content,
        });
      }
    } else {
      for (const [blockIndex, block] of message.content.entries()) {
        const id = `message-${messageIndex}-${blockIndex}`;
        if (block.type === 'text' && block.text) {
          timeline.push({
            id,
            kind: message.role === 'user' ? 'user' : 'assistant',
            text: block.text,
          });
        }
        if (block.type === 'tool_use') {
          timeline.push({
            id: block.id,
            kind: 'tool',
            name: block.name,
            state: 'complete',
            input: block.input,
          });
        }
        if (block.type === 'tool_result') {
          const tool = timeline.find(
            (item) =>
              item &&
              typeof item === 'object' &&
              'id' in item &&
              (item as { id: unknown }).id === block.tool_use_id
          ) as Record<string, unknown> | undefined;
          if (tool) {
            tool.result = block.content;
            tool.state = block.is_error ? 'failed' : 'complete';
          }
        }
      }
    }
    if (message.thinking?.length) {
      timeline.push({
        id: `thinking-${messageIndex}`,
        kind: 'reasoning',
        text: message.thinking.join('\n'),
      });
    }
  }
  return timeline;
}

async function snapshotActiveWebContributions(
  registry: InstalledPluginRegistry | undefined,
  activePluginIds: ReadonlySet<string>
): Promise<readonly ActiveWebContribution[]> {
  if (!registry) return Object.freeze([]);
  const contributions: ActiveWebContribution[] = [];
  for (const entry of await registry.list()) {
    if (!activePluginIds.has(entry.id)) continue;
    try {
      const manifest = await readMossPluginManifest(entry.root);
      for (const contribution of manifest.web?.contributions ?? []) {
        contributions.push({
          pluginId: entry.id,
          id: contribution.id,
          slot: contribution.slot,
          moduleUrl: `/plugin-assets/${encodeURIComponent(entry.id)}/${encodeURIComponent(contribution.id)}.js`,
          source: await readFile(path.resolve(entry.root, contribution.module), 'utf8'),
        });
      }
    } catch {
      // A broken plugin stays isolated and remains visible in the installed inventory.
    }
  }
  return Object.freeze(contributions);
}

async function sendPluginAsset(
  response: http.ServerResponse,
  contributions: readonly ActiveWebContribution[],
  pluginId: string,
  contributionId: string
): Promise<void> {
  const contribution = contributions.find(
    (candidate) => candidate.pluginId === pluginId && candidate.id === contributionId
  );
  if (!contribution) return sendJson(response, 404, { error: 'plugin contribution not found' });
  sendAsset(response, 'text/javascript', contribution.source);
}

/** Start the local Moss browser host around an existing fully composed agent. @beta */
export async function startMossWebServer(
  agent: MossAgent,
  options: MossWebServerOptions = {}
): Promise<MossWebServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const taskRuns = options.taskRunLedger ?? new TaskRunLedger(options.taskRunFile);
  taskRuns.recoverInterrupted();
  const active = new Map<string, AbortController>();
  const pluginRegistry = options.configDir
    ? new InstalledPluginRegistry({ configDir: options.configDir })
    : undefined;
  const startupPluginIds = new Set(
    agent.plugins
      .inspect()
      .plugins.filter(({ state }) => state === 'active')
      .map(({ id }) => id)
  );
  const webContributions = await snapshotActiveWebContributions(pluginRegistry, startupPluginIds);
  const expectedOriginRef: { value?: string } = {};
  const server = http.createServer((request, response) => {
    void handleRequest(
      agent,
      taskRuns,
      active,
      pluginRegistry,
      webContributions,
      expectedOriginRef.value,
      request,
      response
    ).catch((error: unknown) => {
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
  expectedOriginRef.value = formatHttpOrigin(host, address.port);
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
  return { url: expectedOriginRef.value, host, port: address.port, taskRuns, close };
}

async function handleRequest(
  agent: MossAgent,
  taskRuns: TaskRunLedger,
  active: Map<string, AbortController>,
  pluginRegistry: InstalledPluginRegistry | undefined,
  webContributions: readonly ActiveWebContribution[],
  expectedOrigin: string | undefined,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (!expectedOrigin || !isExpectedHost(request, expectedOrigin)) {
    return sendJson(response, 403, { error: 'unexpected host denied' });
  }
  const url = new URL(request.url ?? '/', 'http://moss.local');
  if (request.method === 'GET' && url.pathname === '/')
    return sendAsset(response, 'text/html', WEB_HTML);
  if (request.method === 'GET' && url.pathname === '/assets/workbench.css')
    return sendClientAsset(response, 'workbench.css');
  if (request.method === 'GET' && url.pathname === '/assets/workbench.js')
    return sendClientAsset(response, 'workbench.js');
  const pluginAssetMatch = url.pathname.match(/^\/plugin-assets\/([^/]+)\/([^/]+)\.js$/);
  if (request.method === 'GET' && pluginAssetMatch) {
    return sendPluginAsset(
      response,
      webContributions,
      decodeURIComponent(pluginAssetMatch[1]),
      decodeURIComponent(pluginAssetMatch[2])
    );
  }
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(response, 200, {
      tools: agent.tools.getNames(),
      plugins: agent.plugins.inspect().plugins,
      taskRuns: taskRuns.list(),
      model: agent.config.model ?? 'Configured model',
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/runs')
    return sendJson(response, 200, { runs: taskRuns.list() });
  if (request.method === 'GET' && url.pathname === '/api/sessions')
    return sendJson(response, 200, { sessions: await listWebSessions(agent, taskRuns) });
  if (request.method === 'GET' && url.pathname === '/api/plugins') {
    const installed = ((await pluginRegistry?.list()) ?? []).map(({ id, version, enabled }) => ({
      id,
      version,
      enabled,
    }));
    return sendJson(response, 200, {
      installed,
      active: agent.plugins.inspect().plugins,
      contributions: webContributions.map(({ source: _, ...contribution }) => contribution),
    });
  }
  const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (request.method === 'GET' && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    if (!(await agent.config.sessionStore.exists(sessionId))) {
      return sendJson(response, 404, { error: 'session not found' });
    }
    return sendJson(response, 200, { items: await sessionTimeline(agent, sessionId) });
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === 'GET' && runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const run = taskRuns.get(runId);
    const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    return run
      ? sendJson(response, 200, { run, events: taskRuns.events(runId, cursor) })
      : sendJson(response, 404, { error: 'run not found' });
  }
  if (!isLocalOrigin(request, expectedOrigin)) {
    return sendJson(response, 403, { error: 'non-local origin denied' });
  }
  const pluginMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/(enable|disable|remove)$/);
  if (request.method === 'POST' && pluginMatch) {
    if (!pluginRegistry) return sendJson(response, 501, { error: 'plugin registry unavailable' });
    const pluginId = decodeURIComponent(pluginMatch[1]);
    const action = pluginMatch[2];
    if (action === 'enable') await pluginRegistry.enable(pluginId);
    if (action === 'disable') await pluginRegistry.disable(pluginId);
    if (action === 'remove') await pluginRegistry.remove(pluginId);
    return sendJson(response, 200, { pluginId, action, restartRequired: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    const sessionId = `web-${randomUUID()}`;
    await agent.config.sessionStore.replaceMessages(sessionId, []);
    return sendJson(response, 201, { sessionId });
  }
  if (request.method === 'POST' && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    if (active.has(sessionId)) {
      return sendJson(response, 409, { error: 'session already has an active turn' });
    }
    const body = await readJson(request);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJson(response, 400, { error: 'prompt is required' });
    const runId = `run-${randomUUID()}`;
    const run = taskRuns.create({ id: runId, sessionId, title: prompt.slice(0, 80) });
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
  let streamError: string | undefined;
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
      if (event.type === 'error') {
        streamError = event.error;
        stopReason = 'error';
        emit({ type: 'error', message: event.error });
      }
      if (event.type === 'done') {
        stopReason = event.result.stopReason ?? (streamError ? 'error' : stopReason);
      }
    }
    const current = taskRuns.get(runId);
    const terminalType =
      !streamError && (stopReason === 'end_turn' || stopReason === 'stop_sequence')
        ? 'run.completed'
        : 'run.failed';
    const run =
      current?.status === 'running'
        ? taskRuns.append(runId, {
            type: terminalType,
            data: { stopReason, ...(streamError ? { message: streamError } : {}) },
          })
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
