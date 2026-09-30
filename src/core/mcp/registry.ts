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
}

/** [a-zA-Z0-9_-] segment for wire names; anything else collapses to '_'. */
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || '_';
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

  private constructor(opts: McpRegistryOptions = {}) {
    this.registerTool = opts.registerTool ?? (() => {});
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
      };
      try {
        await client.connect();
        const tools = await client.listTools();
        status.state = 'connected';
        status.toolCount = tools.length;
        log.debug('server connected', { server: config.name, tools: tools.length });
      } catch (err) {
        status.state = 'failed';
        status.error = errorMessage(err).split('\n')[0] ?? 'connection failed';
        log.warn('server connect failed', { server: config.name, error: status.error });
      }
      // Failed servers keep a status entry (degraded, visible to the host) but
      // contribute no tools.
      registry.entries.push(entry);
    }
    return registry;
  }

  /** Status snapshot (order follows the config). */
  getStatuses(): McpServerStatus[] {
    return this.entries.map((e) => ({ ...e.status }));
  }

  /** The eagerly-registered tools: one search meta-tool per CONNECTED server. */
  getTools(): Tool[] {
    return this.entries.filter((e) => e.status.state === 'connected').map((e) => e.searchTool);
  }

  getSearchTool(serverName: string): Tool | undefined {
    return this.entries.find((e) => e.status.name === serverName)?.searchTool;
  }

  /** Close every connection (stdio children terminated). Never throws. */
  async closeAll(): Promise<void> {
    await Promise.allSettled(this.entries.map((e) => e.client.close()));
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

  /** Create (or reuse) the real moss Tool wrapping a server tool, and install
   *  it through the host registerTool hook. Returns the wire name. */
  private ensureRealTool(client: McpClient, descriptor: McpToolDescriptor): string {
    const wireName = mcpToolWireName(client.name, descriptor.name);
    const existing = this.entryFor(client.name)?.realTools.get(wireName);
    if (existing) return wireName;

    const firstLine =
      (descriptor.description ?? '').split('\n').find((line) => line.trim().length > 0) ??
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
    // First call is the lazy-schema trigger: pull the (already cached)
    // descriptor and attach the true schema so subsequent requests render it.
    if (tool.inputSchema.properties && Object.keys(tool.inputSchema.properties).length === 0) {
      const fresh = client.findCachedTool(descriptor.name) ?? undefined;
      const schema = (fresh ?? descriptor).inputSchema;
      if (schema && schema.type === 'object') {
        tool.inputSchema = { ...schema, properties: schema.properties ?? {} };
      }
    }
    const result = await client.callTool(descriptor.name, input ?? {}, {
      signal: ctx.abortSignal,
    });
    const text = toolCallResultToText(result);
    if (result.isError) {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp tool "${descriptor.name}" on "${client.name}" reported an error: ${text}`,
        hint: 'The server executed the call and returned isError=true; fix the arguments or server state.',
        recoverable: true,
      });
    }
    return text || `(no content from mcp tool "${descriptor.name}")`;
  }

  private buildSearchTool(client: McpClient): Tool {
    const wireSearchName = `${mcpServerWirePrefix(client.name)}search`;
    return {
      name: wireSearchName,
      description:
        `List the tools exposed by the MCP server "${client.name}" (name + description, no schemas). ` +
        'Pass {query} to filter by substring. Every listed tool becomes directly callable as ' +
        '`mcp__' +
        `${sanitizeSegment(client.name)}__<tool>` +
        '` — call it by that name with arguments matching the listed description.',
      metadata: {
        sideEffectClass: 'readonly',
        planMode: 'allow',
        permissionBoundary:
          'Reads the tool index of a connected MCP server; no server-side effects.',
      },
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
      execute: async (input: { query?: string; refresh?: boolean }, ctx: ToolContext) => {
        const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : '';
        const tools = await client.listTools({
          refresh: input?.refresh === true,
          signal: ctx.abortSignal,
        });
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
          const wireName = this.ensureRealTool(client, t);
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
 * The system-prompt MCP index layer. Deliberately minimal — one line per
 * connected server pointing at its search meta-tool. Tool names, descriptions,
 * and schemas never enter the system prompt (that is the lazy-loading budget).
 */
export function buildMcpPromptLayer(registry: McpToolRegistry): string {
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
