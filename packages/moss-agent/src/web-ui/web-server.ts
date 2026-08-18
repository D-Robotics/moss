import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP, type AddressInfo } from 'node:net';
import path from 'node:path';
import type { MossAgent } from '../core/agent/moss-agent.js';
import { TaskRunLedger } from '../core/task-run/task-run-ledger.js';
import { errorMessage } from '../errors.js';
import { InstalledPluginRegistry } from '../plugins/installed-plugin-registry.js';
import { readMossPluginManifest } from '../plugins/installed-plugin-registry.js';
import { MossPluginConfigStore } from '../plugins/plugin-config-store.js';
import { CliServices } from '../cli/cli-services.js';
import type { CliRuntimeStatus } from '../cli/onboarding.js';
import {
  clientAssetType,
  isAuthorizedMutation,
  isExpectedHost,
  readJson,
  sendAsset,
  sendJson,
  sendMarkdown,
} from './web-http-utils.js';
import { handleMossWebAttachmentRequest } from './web-attachment-router.js';
import { MossWebAttachmentService } from './web-attachment-service.js';
import { handleMossWebControlPlaneRequest } from './web-control-plane-router.js';
import { MossWebEventJournal, parseMossWebEventCursor } from './web-event-journal.js';
import { MossWebInteractionBroker } from './web-interaction-broker.js';
import { bindMossWebInteractions } from './web-interaction-bindings.js';
import { streamPrompt, streamRunEvents } from './web-run-streaming.js';
import { handleWorkspaceBrowserRequest } from './web-workspace-browser.js';
import { prepareWebDelivery, runApprovedWebDelivery } from './web-delivery-routes.js';
import { MossWebRuntimeService } from './web-runtime-service.js';
import { MossWebSessionService } from './web-session-service.js';
import { MossWebSettingsService } from './web-settings-service.js';
import {
  activateWebPluginCandidate,
  disableWebPlugin,
  enableWebPlugin,
  installedPluginSchema,
  mutateWebPluginConfig,
  removeWebPlugin,
} from './web-plugin-lifecycle.js';
import { resolveMossWebStaticAsset, type MossWebClientAssetName } from './web-static-assets.js';

interface ActiveWebContribution {
  readonly pluginId: string;
  readonly id: string;
  readonly slot: string;
  readonly moduleUrl: string;
  readonly source: string;
}

interface ActiveWebContributionState {
  current: readonly ActiveWebContribution[];
}

/** Options for the loopback Moss Web host. @beta */
export interface MossWebServerOptions {
  port?: number;
  host?: string;
  abortSignal?: AbortSignal;
  /** Optional host-owned task ledger. Defaults to workspace durability when available. */
  taskRunLedger?: TaskRunLedger;
  /** Optional JSONL path used when the server creates its own ledger. */
  taskRunFile?: string;
  /** Optional JSONL path for resumable browser stream events. */
  eventJournalFile?: string;
  /** Optional JSON path for durable Web-only session titles. */
  sessionMetadataFile?: string;
  /** Config root used by the explicit installed-plugin registry. */
  configDir?: string;
  /** Optional CLI service facade reused by browser settings and model selection. */
  cliServices?: CliServices;
  /** Optional live CLI runtime inventory exposed without credentials. */
  runtime?: CliRuntimeStatus;
  /** Optional explicit config path used by browser settings writes. */
  settingsConfigPath?: string;
  /** Optional host-owned interaction broker. */
  interactionBroker?: MossWebInteractionBroker;
  /** Optional storage root for uploaded attachments and copied generated artifacts. */
  attachmentStoreDir?: string;
}

/** Running loopback Moss Web host. @beta */
export interface MossWebServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly taskRuns: TaskRunLedger;
  close(): Promise<void>;
}

async function sendClientAsset(
  response: http.ServerResponse,
  filename: MossWebClientAssetName
): Promise<void> {
  const body = await readFile(new URL(`./client/${filename}`, import.meta.url), 'utf8');
  sendAsset(response, clientAssetType(filename), body);
}

function formatHttpOrigin(host: string, port: number): string {
  const hostname = isIP(host) === 6 && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
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
  agent: MossAgent
): Promise<readonly ActiveWebContribution[]> {
  if (!registry) return Object.freeze([]);
  const activePluginIds = new Set(
    agent.plugins
      .inspect()
      .plugins.filter(({ state }) => state === 'active')
      .map(({ id }) => id)
  );
  const activeContributionIds = new Set(agent.plugins.getWebContributions().map(({ id }) => id));
  const generation = agent.plugins.inspect().generation;
  const contributions: ActiveWebContribution[] = [];
  for (const entry of await registry.list()) {
    if (!activePluginIds.has(entry.id)) continue;
    try {
      const manifest = await readMossPluginManifest(entry.root);
      for (const contribution of manifest.web?.contributions ?? []) {
        if (!activeContributionIds.has(contribution.id)) continue;
        contributions.push({
          pluginId: entry.id,
          id: contribution.id,
          slot: contribution.slot,
          moduleUrl: `/plugin-assets/${encodeURIComponent(entry.id)}/${encodeURIComponent(contribution.id)}.js?generation=${generation}`,
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
  const runtimeDir = agent.config.workspaceDir
    ? path.join(agent.config.workspaceDir, '.moss')
    : undefined;
  const taskRuns =
    options.taskRunLedger ??
    new TaskRunLedger(
      options.taskRunFile ?? (runtimeDir ? path.join(runtimeDir, 'task-runs.jsonl') : undefined),
      agent.executionStore
    );
  const eventJournal = new MossWebEventJournal(
    options.eventJournalFile ?? (runtimeDir ? path.join(runtimeDir, 'web-events.jsonl') : undefined)
  );
  const interruptedRuns = taskRuns
    .list()
    .filter(({ status }) => status === 'created' || status === 'running');
  taskRuns.recoverInterrupted();
  for (const interrupted of interruptedRuns) {
    const run = taskRuns.get(interrupted.id);
    if (run) {
      eventJournal.append(run.id, run.sessionId, {
        type: 'interrupted',
        reason: 'host restarted',
        run,
      });
    }
  }
  const sessions = new MossWebSessionService(agent, taskRuns, {
    workspaceDir: agent.config.workspaceDir,
    metadataFile:
      options.sessionMetadataFile ??
      (runtimeDir ? path.join(runtimeDir, 'web-session-metadata.json') : undefined),
  });
  const active = new Map<string, AbortController>();
  const eventStreams = new Set<http.ServerResponse>();
  const pluginRegistry = options.configDir
    ? new InstalledPluginRegistry({ configDir: options.configDir })
    : undefined;
  const interactionBroker = options.interactionBroker ?? new MossWebInteractionBroker();
  const attachments = new MossWebAttachmentService({
    storageDir:
      options.attachmentStoreDir ??
      path.join(agent.config.workspaceDir ?? process.cwd(), '.moss', 'web-attachments'),
    workspaceDir: agent.config.workspaceDir,
  });
  const runtime = new MossWebRuntimeService(agent, taskRuns, { runtime: options.runtime });
  const settings = new MossWebSettingsService(agent, options.cliServices ?? new CliServices(), {
    configPath:
      options.settingsConfigPath ??
      (options.configDir ? path.join(options.configDir, 'config.json') : undefined),
    pluginRegistry,
  });
  const pluginConfigStore = options.configDir
    ? new MossPluginConfigStore({ configDir: options.configDir })
    : undefined;
  const webContributions: ActiveWebContributionState = {
    current: await snapshotActiveWebContributions(pluginRegistry, agent),
  };
  const compositionStreams = new Set<http.ServerResponse>();
  const unsubscribeComposition = agent.plugins.subscribe((snapshot) => {
    void snapshotActiveWebContributions(pluginRegistry, agent)
      .then((current) => {
        webContributions.current = current;
        const payload = `event: composition\ndata: ${JSON.stringify(snapshot)}\n\n`;
        for (const stream of compositionStreams) stream.write(payload);
      })
      .catch((error: unknown) => {
        console.error(`[web] failed to refresh plugin composition: ${errorMessage(error)}`);
      });
  });
  const expectedOriginRef: { value?: string } = {};
  const csrfToken = randomUUID();
  const server = http.createServer((request, response) => {
    void handleRequest(
      agent,
      taskRuns,
      eventJournal,
      sessions,
      interactionBroker,
      runtime,
      settings,
      attachments,
      active,
      eventStreams,
      pluginRegistry,
      pluginConfigStore,
      webContributions,
      compositionStreams,
      expectedOriginRef.value,
      csrfToken,
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
  const unbindInteractions = bindMossWebInteractions(agent, interactionBroker, runtime);
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      await unsubscribeComposition();
      for (const stream of compositionStreams) stream.end();
      compositionStreams.clear();
      unbindInteractions();
      interactionBroker.cancelAll();
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
  eventJournal: MossWebEventJournal,
  sessions: MossWebSessionService,
  interactions: MossWebInteractionBroker,
  runtime: MossWebRuntimeService,
  settings: MossWebSettingsService,
  attachments: MossWebAttachmentService,
  active: Map<string, AbortController>,
  eventStreams: Set<http.ServerResponse>,
  pluginRegistry: InstalledPluginRegistry | undefined,
  pluginConfigStore: MossPluginConfigStore | undefined,
  webContributions: ActiveWebContributionState,
  compositionStreams: Set<http.ServerResponse>,
  expectedOrigin: string | undefined,
  csrfToken: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (!expectedOrigin || !isExpectedHost(request, expectedOrigin)) {
    return sendJson(response, 403, { error: 'unexpected host denied' });
  }
  const url = new URL(request.url ?? '/', 'http://moss.local');
  const staticAsset = request.method === 'GET' ? resolveMossWebStaticAsset(url) : undefined;
  if (staticAsset && 'client' in staticAsset) return sendClientAsset(response, staticAsset.client);
  if (staticAsset) return sendAsset(response, staticAsset.type, staticAsset.body);
  const pluginAssetMatch = url.pathname.match(/^\/plugin-assets\/([^/]+)\/([^/]+)\.js$/);
  if (request.method === 'GET' && pluginAssetMatch) {
    return sendPluginAsset(
      response,
      webContributions.current,
      decodeURIComponent(pluginAssetMatch[1]),
      decodeURIComponent(pluginAssetMatch[2])
    );
  }
  if (
    await handleMossWebAttachmentRequest({
      request,
      response,
      url,
      mutationAllowed: isAuthorizedMutation(request, expectedOrigin, csrfToken),
      attachments,
      sendJson,
    })
  ) {
    return;
  }
  if (
    await handleMossWebControlPlaneRequest({
      request,
      response,
      url,
      mutationAllowed: isAuthorizedMutation(request, expectedOrigin, csrfToken),
      interactions,
      runtime,
      settings,
      readJson,
      sendJson,
    })
  ) {
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(response, 200, {
      tools: agent.tools.getNames(),
      plugins: agent.plugins.inspect().plugins,
      pluginComposition: agent.plugins.inspect(),
      taskRuns: taskRuns.list(),
      model: agent.config.model ?? 'Configured model',
      csrfToken,
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/runs')
    return sendJson(response, 200, { runs: taskRuns.list() });
  if (request.method === 'GET' && url.pathname === '/api/runs/active') {
    return sendJson(response, 200, {
      runs: taskRuns.list().filter(({ status }) => status === 'created' || status === 'running'),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/workspaces') {
    return sendJson(response, 200, { workspaces: await sessions.listWorkspaces() });
  }
  if (
    await handleWorkspaceBrowserRequest({
      request,
      response,
      url,
      root: agent.config.workspaceDir ?? process.cwd(),
      sendJson,
    })
  )
    return;
  if (request.method === 'GET' && url.pathname === '/api/sessions/search') {
    return sendJson(response, 200, {
      hits: await sessions.search(url.searchParams.get('q') ?? ''),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions')
    return sendJson(response, 200, { sessions: await sessions.listSessions() });
  if (request.method === 'GET' && url.pathname === '/api/plugins') {
    const installed = ((await pluginRegistry?.list()) ?? []).map(({ id, version, enabled }) => ({
      id,
      version,
      enabled,
    }));
    return sendJson(response, 200, {
      generation: agent.plugins.inspect().generation,
      installed,
      active: agent.plugins.inspect().plugins,
      contributions: webContributions.current.map(({ source: _, ...contribution }) => contribution),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/plugins/events') {
    return streamPluginComposition(request, response, compositionStreams, agent);
  }
  const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (request.method === 'GET' && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    if (!(await agent.config.sessionStore.exists(sessionId))) {
      return sendJson(response, 404, { error: 'session not found' });
    }
    return sendJson(response, 200, { items: await sessionTimeline(agent, sessionId) });
  }
  const sessionExportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
  if (request.method === 'GET' && sessionExportMatch) {
    const sessionId = decodeURIComponent(sessionExportMatch[1]);
    return sendMarkdown(response, sessionId, await sessions.exportMarkdown(sessionId));
  }
  const activeRunMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/active-run$/);
  if (request.method === 'GET' && activeRunMatch) {
    const sessionId = decodeURIComponent(activeRunMatch[1]);
    const run = taskRuns
      .list()
      .find(
        (candidate) =>
          candidate.sessionId === sessionId &&
          (candidate.status === 'created' || candidate.status === 'running')
      );
    return run
      ? sendJson(response, 200, {
          run,
          cursor: eventJournal.latestSequence(run.id),
          eventsUrl: `/api/runs/${encodeURIComponent(run.id)}/events`,
        })
      : sendJson(response, 404, { error: 'active run not found' });
  }
  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (request.method === 'GET' && runEventsMatch) {
    const runId = decodeURIComponent(runEventsMatch[1]);
    const run = taskRuns.get(runId);
    if (!run) return sendJson(response, 404, { error: 'run not found' });
    const queryCursor = url.searchParams.get('after');
    const after = parseMossWebEventCursor(runId, queryCursor ?? request.headers['last-event-id']);
    return streamRunEvents(request, response, eventStreams, eventJournal, run, after);
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
  if (!isAuthorizedMutation(request, expectedOrigin, csrfToken)) {
    return sendJson(response, 403, { error: 'mutation requires same-origin CSRF authorization' });
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/add') {
    if (!pluginRegistry) return sendJson(response, 501, { error: 'plugin registry unavailable' });
    const body = await readJson(request);
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    if (!source) return sendJson(response, 400, { error: 'plugin source is required' });
    const entry = await pluginRegistry.add(source);
    const wasActive = agent.plugins
      .inspect()
      .plugins.some(({ id, state }) => id === entry.id && state === 'active');
    await activateWebPluginCandidate(agent, pluginRegistry, entry, wasActive);
    return sendJson(response, 201, {
      plugin: { id: entry.id, version: entry.version, enabled: entry.enabled },
      generation: agent.plugins.inspect().generation,
      restartRequired: false,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/doctor') {
    if (!pluginRegistry) return sendJson(response, 501, { error: 'plugin registry unavailable' });
    return sendJson(response, 200, {
      results: await pluginRegistry.doctor(),
      generation: agent.plugins.inspect().generation,
      restartRequired: false,
    });
  }
  const pluginMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/(enable|disable|remove)$/);
  if (request.method === 'POST' && pluginMatch) {
    if (!pluginRegistry) return sendJson(response, 501, { error: 'plugin registry unavailable' });
    const pluginId = decodeURIComponent(pluginMatch[1]);
    const action = pluginMatch[2];
    if (action === 'enable') await enableWebPlugin(agent, pluginRegistry, pluginId);
    if (action === 'disable') await disableWebPlugin(agent, pluginRegistry, pluginId);
    if (action === 'remove') await removeWebPlugin(agent, pluginRegistry, pluginId);
    webContributions.current = await snapshotActiveWebContributions(pluginRegistry, agent);
    return sendJson(response, 200, {
      pluginId,
      action,
      generation: agent.plugins.inspect().generation,
      restartRequired: false,
    });
  }
  const pluginConfigMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/config$/);
  if (pluginConfigMatch && (request.method === 'GET' || request.method === 'PUT')) {
    if (!pluginRegistry || !pluginConfigStore) {
      return sendJson(response, 501, { error: 'plugin configuration unavailable' });
    }
    const pluginId = decodeURIComponent(pluginConfigMatch[1]);
    const entry = (await pluginRegistry.list()).find(({ id }) => id === pluginId);
    if (!entry) return sendJson(response, 404, { error: 'plugin not found' });
    const schema = await installedPluginSchema(entry);
    if (!schema) return sendJson(response, 404, { error: 'plugin has no config schema' });
    if (request.method === 'PUT') {
      const body = await readJson(request);
      const values =
        body.values && typeof body.values === 'object' && !Array.isArray(body.values)
          ? (body.values as Record<string, unknown>)
          : body;
      await mutateWebPluginConfig(agent, pluginRegistry, pluginConfigStore, entry, schema, () =>
        pluginConfigStore.update(pluginId, schema, values)
      );
    }
    return sendJson(response, 200, {
      schema,
      config: await pluginConfigStore.getView(pluginId, schema),
      generation: agent.plugins.inspect().generation,
      restartRequired: false,
    });
  }
  const pluginSecretMatch = url.pathname.match(
    /^\/api\/plugins\/([^/]+)\/config\/secrets\/([^/]+)$/
  );
  if (pluginSecretMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
    if (!pluginRegistry || !pluginConfigStore) {
      return sendJson(response, 501, { error: 'plugin configuration unavailable' });
    }
    const pluginId = decodeURIComponent(pluginSecretMatch[1]);
    const name = decodeURIComponent(pluginSecretMatch[2]);
    const entry = (await pluginRegistry.list()).find(({ id }) => id === pluginId);
    if (!entry) {
      return sendJson(response, 404, { error: 'plugin config not found' });
    }
    const schema = await installedPluginSchema(entry);
    if (!schema) return sendJson(response, 404, { error: 'plugin has no config schema' });
    if (request.method === 'PUT') {
      const body = await readJson(request);
      await mutateWebPluginConfig(agent, pluginRegistry, pluginConfigStore, entry, schema, () =>
        pluginConfigStore.putSecret(pluginId, schema, name, body.value)
      );
    } else {
      await mutateWebPluginConfig(agent, pluginRegistry, pluginConfigStore, entry, schema, () =>
        pluginConfigStore.deleteSecret(pluginId, schema, name)
      );
    }
    return sendJson(response, 200, {
      config: await pluginConfigStore.getView(pluginId, schema),
      generation: agent.plugins.inspect().generation,
      restartRequired: false,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    const body = await readJson(request);
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : 'current';
    return sendJson(response, 201, await sessions.create(workspaceId));
  }
  const sessionMutationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === 'PATCH' && sessionMutationMatch) {
    const sessionId = decodeURIComponent(sessionMutationMatch[1]);
    const body = await readJson(request);
    const title = typeof body.title === 'string' ? body.title : '';
    return sendJson(response, 200, { session: await sessions.rename(sessionId, title) });
  }
  if (request.method === 'DELETE' && sessionMutationMatch) {
    const sessionId = decodeURIComponent(sessionMutationMatch[1]);
    if (active.has(sessionId)) {
      return sendJson(response, 409, { error: 'cannot delete a session with an active turn' });
    }
    const body = await readJson(request);
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';
    await sessions.delete(sessionId, confirmation);
    return sendJson(response, 200, { sessionId, deleted: true });
  }
  const forkMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/);
  if (request.method === 'POST' && forkMatch) {
    const sessionId = decodeURIComponent(forkMatch[1]);
    return sendJson(response, 201, { session: await sessions.fork(sessionId) });
  }
  const rewindMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/rewind$/);
  if (request.method === 'POST' && rewindMatch) {
    const sessionId = decodeURIComponent(rewindMatch[1]);
    const body = await readJson(request);
    const messageCount = typeof body.messageCount === 'number' ? body.messageCount : Number.NaN;
    return sendJson(response, 201, await sessions.rewind(sessionId, messageCount));
  }
  if (request.method === 'POST' && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    if (active.has(sessionId)) {
      return sendJson(response, 409, { error: 'session already has an active turn' });
    }
    const body = await readJson(request);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJson(response, 400, { error: 'prompt is required' });
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (
      attachmentIds.length !== (Array.isArray(body.attachmentIds) ? body.attachmentIds.length : 0)
    ) {
      return sendJson(response, 400, { error: 'attachmentIds must contain only strings' });
    }
    const promptAttachments = await attachments.resolveForPrompt(attachmentIds);
    await sessions.titleFromPrompt(sessionId, prompt);
    const runId = `run-${randomUUID()}`;
    const run = taskRuns.create({
      id: runId,
      sessionId,
      title: prompt.slice(0, 80),
      goal: prompt,
      attachmentIds,
    });
    if (
      !prepareWebDelivery({
        agent,
        runtime,
        taskRuns,
        eventJournal,
        runId: run.id,
        sessionId,
        response,
      })
    )
      return;
    return streamPrompt(
      agent,
      taskRuns,
      eventJournal,
      active,
      run.id,
      sessionId,
      prompt,
      promptAttachments,
      response
    );
  }
  const executionRunMatch = url.pathname.match(/^\/api\/executions\/([^/]+)\/run$/);
  if (request.method === 'POST' && executionRunMatch) {
    await runApprovedWebDelivery({
      graphId: decodeURIComponent(executionRunMatch[1]),
      agent,
      runtime,
      taskRuns,
      eventJournal,
      attachments,
      active,
      response,
      sendJson,
    });
    return;
  }
  const cancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    const sessionId = decodeURIComponent(cancelMatch[1]);
    const controller = active.get(sessionId);
    controller?.abort();
    const run = taskRuns.list().find((candidate) => candidate.sessionId === sessionId);
    if (controller && run && (run.status === 'created' || run.status === 'running')) {
      taskRuns.append(run.id, {
        type: 'run.cancelled',
        data: { reason: 'user requested' },
      });
    }
    return sendJson(response, 200, { sessionId, cancelled: Boolean(controller) });
  }
  sendJson(response, 404, { error: 'not found' });
}

function streamPluginComposition(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  streams: Set<http.ServerResponse>,
  agent: MossAgent
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  response.write(`event: composition\ndata: ${JSON.stringify(agent.plugins.inspect())}\n\n`);
  streams.add(response);
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
  keepAlive.unref();
  const cleanup = () => {
    clearInterval(keepAlive);
    streams.delete(response);
  };
  request.once('aborted', cleanup);
  response.once('close', cleanup);
}
