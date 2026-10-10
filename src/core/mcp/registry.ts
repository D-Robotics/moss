/**
 * McpToolRegistry — turns connected MCP servers into moss tools with lazy
 * loading (the "CC MCPSearch" shape):
 *
 *  - one `mcp__<server>__search` meta-tool per server (readonly): lists the
 *    server's tool names + descriptions, no schemas. This is the ONLY thing
 *    the system prompt advertises, so a 50-tool server costs ~one line, not
 *    50 tool declarations;
 *  - real `mcp__<server>__<tool>` tools are registered on demand when search
 *    lists them: loose `{type:'object'}` schema first, the true server schema
 *    is attached after the first call (fetched from the cached tools/list).
 *    They deliberately declare NO sideEffectClass — the approval layer's
 *    default (local_write) routes every MCP call through approval.
 */
import type { Tool, ToolContext } from '../tools/tool-types.js';
import { MossError, ErrorCode, errorMessage } from '../../errors.js';
import { getRootLogger } from '../../logger.js';
import { uiText } from '../../utils/ui-language.js';
import { McpClient } from './client.js';
import type { McpServerConfig, McpToolCallResult, McpToolDescriptor } from './types.js';

const log = getRootLogger().child('mcp:registry');

/** Providers cap tool names at 64 chars ([a-zA-Z0-9_-]). */
const MAX_TOOL_NAME_LENGTH = 64;

export interface McpRegistryOptions {
  /** Host hook that installs an on-demand MCP tool into the live registry. */
  registerTool?: (tool: Tool) => void;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Called after a server reaches connected or failed. */
  onStatusChange?: (status: McpServerStatus) => void;
}

export interface McpServerStatus {
  name: string;
  state: string;
  toolCount?: number;
  error?: string;
}

interface ServerEntry {
  client: McpClient;
  status: McpServerStatus;
  searchTool: Tool;
  /** Real tools created on demand, keyed by wire name (stable identity so the
   *  post-first-call schema upgrade mutates the registered object). */
  realTools: Map<string, Tool>;
  /**
   * Descriptors from the `tools/list` call already made at connect time. Kept
   * so capability discovery can select tools per task without revealing (and
   * paying prompt tokens for) the whole server catalog.
   */
  descriptors: McpToolDescriptor[];
  /** Server config, kept so a dropped connection can be re-established. */
  config: McpServerConfig;
  /** Reconnect attempts already made for the current down period (max 1). */
  reconnectAttempts: number;
  /** Initial handshake/list operation. Always settles; failures live in status. */
  ready: Promise<void>;
}

/** One selectable server tool, as seen by capability discovery. */
export interface McpCatalogEntry {
  server: string;
  /** Server-side tool name (not the wire name). */
  tool: string;
  /** `mcp__<server>__<tool>` — what the model would call. */
  wireName: string;
  description: string;
}

/** [a-zA-Z0-9_-] segment for wire names; anything else collapses to '_'. */
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || '_';
}

/**
 * First non-empty line of a server-provided description, capped. The line is
 * embedded verbatim in the revealed tool's schema description, so a verbose or
 * hostile server must not be able to blow the provider payload.
 */
function firstDescriptionLine(text: string | undefined, max = 500): string {
  const line = (text ?? '')
    .split('\n')
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** FNV-1a 32-bit → 8 hex chars (deterministic short hash for long names). */
function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Provider-safe tool wire name: `mcp__<server>__<tool>`. */
export function mcpToolWireName(server: string, tool: string): string {
  const base = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
  if (base.length <= MAX_TOOL_NAME_LENGTH) return base;
  const hash = shortHash(base);
  const room = MAX_TOOL_NAME_LENGTH - hash.length - 1 - 'mcp__'.length - '__'.length;
  const half = Math.floor(room / 2);
  const serverPart = sanitizeSegment(server).slice(0, half);
  const toolPart = sanitizeSegment(tool).slice(0, room - half);
  return `mcp__${serverPart}__${toolPart}_${hash}`;
}

export function mcpServerWirePrefix(server: string): string {
  return `mcp__${sanitizeSegment(server)}__`;
}

function toolCallResultToText(result: McpToolCallResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'resource' && typeof block.resource?.text === 'string') {
      parts.push(block.resource.text);
    } else if (block.type === 'image') {
      parts.push(`[image: ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`);
    } else {
      parts.push(`[${block.type} content]`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : '(no content)';
}

export class McpToolRegistry {
  private entries: ServerEntry[] = [];
  private readonly registerTool: (tool: Tool) => void;
  private readonly connectTimeoutMs: number | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly onStatusChange: ((status: McpServerStatus) => void) | undefined;

  private constructor(opts: McpRegistryOptions = {}) {
    this.registerTool = opts.registerTool ?? (() => {});
    this.connectTimeoutMs = opts.connectTimeoutMs;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.onStatusChange = opts.onStatusChange;
  }

  /**
   * Connect every configured server. Never throws for a single server's
   * failure — that server degrades to a `failed` status entry and no tools,
   * so a broken MCP config can't take the CLI down.
   */
  static async connectAll(
    configs: McpServerConfig[],
    opts: McpRegistryOptions = {}
  ): Promise<McpToolRegistry> {
    const registry = McpToolRegistry.connectInBackground(configs, opts);
    await registry.waitForConnections();
    return registry;
  }

  /**
   * Create the registry immediately and perform handshakes in the background.
   * Search meta-tools are available while a server is connecting; invoking
   * one waits for that server's bounded initial connection.
   */
  static connectInBackground(
    configs: McpServerConfig[],
    opts: McpRegistryOptions = {}
  ): McpToolRegistry {
    const registry = new McpToolRegistry(opts);
    for (const config of configs) {
      const client = new McpClient(config, {
        connectTimeoutMs: opts.connectTimeoutMs,
        requestTimeoutMs: opts.requestTimeoutMs,
      });
      const status: McpServerStatus = { name: config.name, state: 'connecting' };
      const entry: ServerEntry = {
        client,
        status,
        searchTool: registry.buildSearchTool(client),
        realTools: new Map(),
        descriptors: [],
        config,
        reconnectAttempts: 0,
        ready: Promise.resolve(),
      };
      registry.entries.push(entry);
      // Defer even the spawn to a microtask so registry construction and the
      // caller's first render are synchronous and independent of npx startup.
      entry.ready = Promise.resolve().then(() => registry.initialize(entry));
    }
    return registry;
  }

  async waitForConnections(): Promise<void> {
    await Promise.all(this.entries.map((entry) => entry.ready));
  }

  private async initialize(entry: ServerEntry): Promise<void> {
    try {
      await entry.client.connect();
      const tools = await entry.client.listTools();
      entry.descriptors = tools;
      entry.status.state = 'connected';
      entry.status.toolCount = this.exposedToolCount(entry);
      log.debug('server connected', { server: entry.config.name, tools: tools.length });
    } catch (err) {
      entry.status.state = 'failed';
      entry.status.error =
        errorMessage(err).split('\n')[0] ?? uiText('connection failed', '连接失败');
      // A transport can fail after the child was successfully spawned (for
      // example, handshake or tools/list timeout). Reap it immediately rather
      // than leaving an idle npx process alive until the CLI exits.
      await entry.client.close().catch(() => undefined);
      log.warn(uiText('server connect failed', 'MCP 服务器连接失败'), {
        server: entry.config.name,
        error: entry.status.error,
      });
    }
    try {
      this.onStatusChange?.({ ...entry.status });
    } catch (err) {
      log.warn(uiText('status callback failed', 'MCP 状态回调失败'), {
        server: entry.config.name,
        error: errorMessage(err),
      });
    }
  }

  /**
   * Tools the session can actually call: every `tools/list` descriptor, plus
   * the search meta-tool when its wire name is not already a server tool.
   */
  private exposedToolCount(entry: ServerEntry): number {
    const names = new Set<string>([entry.searchTool.name]);
    for (const descriptor of entry.descriptors) {
      names.add(mcpToolWireName(entry.status.name, descriptor.name));
    }
    return names.size;
  }

  /** Status snapshot (order follows the config). */
  getStatuses(): McpServerStatus[] {
    return this.entries.map((entry) => {
      if (entry.status.state !== 'connected') return { ...entry.status };
      const toolCount = this.exposedToolCount(entry);
      entry.status.toolCount = toolCount;
      return { ...entry.status, toolCount };
    });
  }

  /**
   * Lazy reconnect for a dropped server: rebuild the client, retry the
   * handshake once, refresh descriptors. Only an unexpected drop ('failed')
   * heals — an explicit closeAll ('closed') stays closed, and the counter
   * caps retries at one per down period so a dead server can't loop.
   */
  private async reconnect(entry: ServerEntry): Promise<boolean> {
    if (entry.status.state !== 'failed' || entry.reconnectAttempts >= 1) return false;
    entry.reconnectAttempts += 1;
    entry.status.state = 'connecting';
    entry.status.error = undefined;
    try {
      await entry.client.close().catch(() => undefined);
      const client = new McpClient(entry.config, {
        connectTimeoutMs: this.connectTimeoutMs,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      await client.connect();
      entry.descriptors = await client.listTools();
      entry.client = client;
      // The search tool and any revealed real tools captured the old client;
      // rebuild the wire tools so future calls hit the new connection.
      entry.searchTool = this.buildSearchTool(client);
      entry.realTools.clear();
      entry.status.state = 'connected';
      entry.status.toolCount = this.exposedToolCount(entry);
      entry.reconnectAttempts = 0;
      log.info(uiText('server reconnected', 'MCP 服务器已重连'), { server: entry.config.name });
      return true;
    } catch (err) {
      entry.status.state = 'failed';
      entry.status.error =
        errorMessage(err).split('\n')[0] ?? uiText('reconnect failed', '重连失败');
      log.warn(uiText('server reconnect failed', 'MCP 服务器重连失败'), {
        server: entry.config.name,
        error: entry.status.error,
      });
      return false;
    }
  }

  /** Search tools are available immediately; calls await a bounded handshake. */
  getTools(): Tool[] {
    return this.entries
      .filter((e) => e.status.state === 'connecting' || e.status.state === 'connected')
      .map((e) => e.searchTool);
  }

  getSearchTool(serverName: string): Tool | undefined {
    return this.entries.find((e) => e.status.name === serverName)?.searchTool;
  }

  /**
   * Every tool the connected servers expose, from the `tools/list` cache taken
   * at connect time — no extra round trip, no prompt cost.
   *
   * Capability discovery scores this catalog against the goal and then calls
   * `revealTools` for the few that matched, so a 50-tool server costs one
   * prompt line per selected tool instead of 50 schemas.
   */
  getCatalog(): McpCatalogEntry[] {
    const catalog: McpCatalogEntry[] = [];
    for (const entry of this.entries) {
      if (entry.status.state !== 'connected') continue;
      for (const descriptor of entry.descriptors) {
        catalog.push({
          server: entry.status.name,
          tool: descriptor.name,
          wireName: mcpToolWireName(entry.status.name, descriptor.name),
          description: descriptor.description ?? '',
        });
      }
    }
    return catalog;
  }

  /**
   * Install the named tools so they are directly callable, without the model
   * having to run the search meta-tool first. Unknown or unreachable wire names
   * are ignored (a stale catalog must not throw mid-run). Returns what was
   * actually revealed, so the caller can report only what exists.
   */
  revealTools(wireNames: readonly string[]): string[] {
    const revealed: string[] = [];
    for (const wireName of wireNames) {
      for (const entry of this.entries) {
        if (entry.status.state !== 'connected') continue;
        const matches = entry.descriptors.filter(
          (descriptor) => mcpToolWireName(entry.status.name, descriptor.name) === wireName
        );
        if (matches.length === 0) continue;
        for (const descriptor of matches)
          revealed.push(this.ensureRealTool(entry.client, descriptor));
        break;
      }
    }
    return revealed;
  }

  /** Close every connection (stdio children terminated). Never throws. */
  async closeAll(): Promise<void> {
    await Promise.allSettled(this.entries.map((e) => e.client.close()));
    await Promise.allSettled(this.entries.map((e) => e.ready));
    for (const entry of this.entries) {
      if (entry.status.state === 'connected' || entry.status.state === 'connecting') {
        entry.status.state = 'closed';
      }
    }
  }

  /** The system-prompt index layer: one line per server, no tool schemas. */
  buildPromptLayer(): string {
    return buildMcpPromptLayer(this);
  }

  /** Connected server names (failed servers are excluded). */
  connectedServerNames(): string[] {
    return this.entries.filter((e) => e.status.state === 'connected').map((e) => e.status.name);
  }

  /**
   * Resolve a wire name that was not in the turn's tool list yet.
   * A server still connecting is awaited (bounded by its connect timeout,
   * and by `signal`). After the handshake, a catalog hit is registered and
   * returned. Unknown names and servers that failed return undefined;
   * `missingToolReason` explains the failure.
   */
  async resolveCallableTool(wireName: string, signal?: AbortSignal): Promise<Tool | undefined> {
    const entry = this.entryForWireName(wireName);
    if (!entry) return undefined;
    await this.waitUntilReady(entry, signal);
    if (entry.status.state !== 'connected') return undefined;
    if (wireName === entry.searchTool.name) return entry.searchTool;
    const existing = entry.realTools.get(wireName);
    if (existing) return existing;
    const descriptor = entry.descriptors.find(
      (candidate) => mcpToolWireName(entry.status.name, candidate.name) === wireName
    );
    if (!descriptor) return undefined;
    this.ensureRealTool(entry.client, descriptor);
    return entry.realTools.get(wireName);
  }

  /** Replaces "Unknown tool" when the server itself is down or closed. */
  missingToolReason(wireName: string): string | undefined {
    const entry = this.entryForWireName(wireName);
    if (!entry) return undefined;
    if (entry.status.state === 'failed') {
      const reason = entry.status.error?.trim() || 'connection failed';
      return `MCP server "${entry.status.name}" failed to connect: ${reason}. Its tools are not available.`;
    }
    if (entry.status.state === 'closed') {
      return `MCP server "${entry.status.name}" is closed. Its tools are not available.`;
    }
    return undefined;
  }

  private entryForWireName(wireName: string): ServerEntry | undefined {
    if (!wireName.startsWith('mcp__')) return undefined;
    let match: ServerEntry | undefined;
    let matchLength = 0;
    for (const entry of this.entries) {
      const prefix = mcpServerWirePrefix(entry.status.name);
      if (wireName.startsWith(prefix) && prefix.length > matchLength) {
        match = entry;
        matchLength = prefix.length;
      }
    }
    return match;
  }

  /** Handshake wait. `ready` already rejects nothing and is connect-timeout bounded. */
  private async waitUntilReady(entry: ServerEntry, signal?: AbortSignal): Promise<void> {
    if (entry.status.state !== 'connecting') return;
    if (signal?.aborted) {
      throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'Operation aborted' });
    }
    if (!signal) {
      await entry.ready;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new MossError({ code: ErrorCode.USER_ABORTED, message: 'Operation aborted' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.ready.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  /** Create (or reuse) the real moss Tool wrapping a server tool, and install
   *  it through the host registerTool hook. Returns the wire name. */
  private ensureRealTool(client: McpClient, descriptor: McpToolDescriptor): string {
    const wireName = mcpToolWireName(client.name, descriptor.name);
    const existing = this.entryFor(client.name)?.realTools.get(wireName);
    if (existing) return wireName;

    const firstLine =
      firstDescriptionLine(descriptor.description) ||
      `MCP tool "${descriptor.name}" on server "${client.name}"`;

    const tool: Tool = {
      name: wireName,
      description:
        `${firstLine}\n\nMCP tool "${descriptor.name}" on server "${client.name}". ` +
        'Arguments are passed through to the server; the exact schema is fetched on first call. ' +
        'Find tools with the mcp__<server>__search meta-tool.',
      // No sideEffectClass: MCP tools are unknown external effects, so the
      // approval default (local_write) routes every call through approval.
      inputSchema: { type: 'object', properties: {} },
      execute: (input: Record<string, unknown>, ctx: ToolContext) =>
        this.executeRealTool(client, descriptor, tool, input, ctx),
    };
    this.entryFor(client.name)?.realTools.set(wireName, tool);
    this.registerTool(tool);
    return wireName;
  }

  private entryFor(serverName: string): ServerEntry | undefined {
    return this.entries.find((e) => e.status.name === serverName);
  }

  private async executeRealTool(
    client: McpClient,
    descriptor: McpToolDescriptor,
    tool: Tool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<string> {
    // A revealed tool outlives its connection in the host registry; a dropped
    // server gets one lazy reconnect attempt before the call fails with a
    // clear reason. The reconnect swaps entry.client, so re-resolve it.
    const entryBefore = this.entryFor(client.name);
    if (entryBefore && entryBefore.status.state !== 'connected') {
      const reconnected = await this.reconnect(entryBefore);
      if (!reconnected) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: uiText(
            `mcp tool "${descriptor.name}" on "${client.name}" is not callable: server state is "${entryBefore.status.state}".`,
            `「${client.name}」上的 mcp 工具「${descriptor.name}」不可调用：服务器状态为「${entryBefore.status.state}」。`
          ),
          hint: uiText(
            'The MCP connection dropped and a reconnect attempt failed; check the server, then retry.',
            'MCP 连接已断开且重连失败；请检查服务器后再试。'
          ),
          recoverable: true,
        });
      }
    }
    const entry = this.entryFor(client.name);
    const liveClient = entry?.client ?? client;
    // First call is the lazy-schema trigger: pull the (already cached)
    // descriptor and attach the true schema so subsequent requests render it.
    if (tool.inputSchema.properties && Object.keys(tool.inputSchema.properties).length === 0) {
      const fresh = liveClient.findCachedTool(descriptor.name) ?? undefined;
      const schema = (fresh ?? descriptor).inputSchema;
      if (schema && schema.type === 'object') {
        tool.inputSchema = { ...schema, properties: schema.properties ?? {} };
      }
    }
    const result = await liveClient.callTool(descriptor.name, input ?? {}, {
      signal: ctx.abortSignal,
    });
    const text = toolCallResultToText(result);
    if (result.isError) {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: uiText(
          `mcp tool "${descriptor.name}" on "${client.name}" reported an error: ${text}`,
          `「${client.name}」上的 mcp 工具「${descriptor.name}」返回错误：${text}`
        ),
        hint: uiText(
          'The server executed the call and returned isError=true; fix the arguments or server state.',
          '服务器已执行调用并返回 isError=true；请修正参数或服务器状态。'
        ),
        recoverable: true,
      });
    }
    return (
      text ||
      uiText(
        `(no content from mcp tool "${descriptor.name}")`,
        `（mcp 工具「${descriptor.name}」没有内容）`
      )
    );
  }

  private buildSearchTool(client: McpClient): Tool {
    const declared = mcpSearchToolDeclaration(client.name);
    return {
      name: declared.name,
      description: declared.description,
      metadata: {
        sideEffectClass: 'readonly',
        planMode: 'allow',
        permissionBoundary:
          'Reads the tool index of a connected MCP server; no server-side effects.',
      },
      inputSchema: declared.inputSchema,
      execute: async (input: { query?: string; refresh?: boolean }, ctx: ToolContext) => {
        // Same guard as revealed tools, plus one lazy reconnect so a bounced
        // server heals on the next search instead of erroring until restart.
        const entry = this.entryFor(client.name);
        let liveClient = entry?.client ?? client;
        if (entry?.status.state === 'connecting') {
          await entry.ready;
        }
        if (entry && entry.status.state !== 'connected') {
          if (!(await this.reconnect(entry))) {
            throw new MossError({
              code: ErrorCode.TOOL_EXECUTION_FAILED,
              message: uiText(
                `mcp search on "${client.name}" is not callable: server state is "${entry.status.state}".`,
                `「${client.name}」上的 mcp 搜索不可调用：服务器状态为「${entry.status.state}」。`
              ),
              hint: uiText(
                'The MCP connection dropped and a reconnect attempt failed; check the server, then retry.',
                'MCP 连接已断开且重连失败；请检查服务器后再试。'
              ),
              recoverable: true,
            });
          }
          liveClient = entry.client;
        }
        const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : '';
        const tools = await liveClient.listTools({
          refresh: input?.refresh === true,
          signal: ctx.abortSignal,
        });
        if (entry && entry.status.state === 'connected') {
          entry.descriptors = tools;
          entry.status.toolCount = this.exposedToolCount(entry);
        }
        if (tools.length === 0) {
          return `MCP server "${client.name}" exposes no tools.`;
        }
        const matched = tools.filter((t) => {
          if (!query) return true;
          return (
            t.name.toLowerCase().includes(query) ||
            (t.description ?? '').toLowerCase().includes(query)
          );
        });
        // Lazy registration: whatever the model can see here becomes callable.
        const lines: string[] = [];
        for (const t of matched) {
          const wireName = this.ensureRealTool(liveClient, t);
          const desc = (t.description ?? '(no description)').split('\n')[0] ?? '';
          lines.push(
            `- ${wireName}: ${desc}${wireName.endsWith(`__${t.name}`) ? '' : ` (server tool: ${t.name})`}`
          );
        }
        const header =
          `MCP server "${client.name}": ${matched.length}/${tools.length} tool(s)` +
          (query ? ` matching "${(input.query ?? '').trim()}"` : '') +
          '. All of them are now registered and callable by the names below.';
        if (matched.length === 0) {
          return `MCP server "${client.name}": no tools match "${(input.query ?? '').trim()}" (${tools.length} tools total). Drop the query or set refresh=true.`;
        }
        return `${header}\n${lines.join('\n')}`;
      },
    };
  }
}

/**
 * Schema of the per-server search meta-tool. The registry's search tool and
 * the context report both use this so the measured schema is the one sent.
 */
export function mcpSearchToolDeclaration(serverName: string): {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: {
      query: { type: 'string'; description: string };
      refresh: { type: 'boolean'; description: string };
    };
  };
} {
  return {
    name: `${mcpServerWirePrefix(serverName)}search`,
    description:
      `List MCP tools on "${serverName}" (name + description, no schemas). ` +
      'Optional query filters by substring. Each listed tool is then callable as ' +
      `mcp__${sanitizeSegment(serverName)}__<tool>.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional substring filter on tool name or description.',
        },
        refresh: {
          type: 'boolean',
          description: 'Re-fetch the tool list from the server (default: cached).',
        },
      },
    },
  };
}

/**
 * The system-prompt MCP index layer. Deliberately minimal — one line per
 * connected server pointing at its search meta-tool. Tool names, descriptions,
 * and schemas never enter the system prompt (that is the lazy-loading budget).
 */
export function buildMcpPromptLayer(registry: {
  getStatuses(): readonly { name: string; state: string; toolCount?: number }[];
}): string {
  const servers = registry.getStatuses().filter((s) => s.state === 'connected');
  if (servers.length === 0) return '';
  const lines = servers.map(
    (s) =>
      `- ${s.name}: ${s.toolCount ?? '?'} tool(s) — list/filter with \`${mcpServerWirePrefix(s.name)}search\`, then call \`mcp__${sanitizeSegment(s.name)}__<tool>\` by name`
  );
  return [
    '## MCP Tool Servers',
    'External MCP tool servers are connected. Their tools are NOT listed here (lazy loading): ' +
      'search a server first with its `mcp__<server>__search` meta-tool (optional {query} filter), ' +
      'which registers the tools and returns their names + descriptions; then call `mcp__<server>__<tool>` directly.',
    ...lines,
  ].join('\n');
}
