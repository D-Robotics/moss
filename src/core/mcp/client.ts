/**
 * McpClient — one connected MCP server. Aggregates a transport (stdio or
 * streamable HTTP), performs the MCP initialize handshake (protocol version
 * 2025-06-18, falling back to whatever the server answers), and exposes
 * `listTools` / `callTool` with a session-scoped tools/list cache.
 */
import { MossError, ErrorCode } from '../../errors.js';
import { getRootLogger } from '../../logger.js';
import type {
  McpServerConfig,
  McpToolCallResult,
  McpToolDescriptor,
  McpTransport,
} from './types.js';
import { McpStdioTransport } from './stdio-transport.js';
import { McpHttpTransport } from './http-transport.js';
import { getPackageVersion } from '../../utils/package-info.js';

const log = getRootLogger().child('mcp:client');

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Client identity sent in the initialize handshake. The version is read from
 * package.json — it used to be pinned to '0.16.0', so every MCP server was
 * told a version that stopped being true five releases ago.
 */
function clientInfo(): { name: string; version: string } {
  return { name: 'moss', version: getPackageVersion() };
}

export interface McpClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface McpListToolsOptions {
  /** Skip the cache and re-fetch from the server. */
  refresh?: boolean;
  signal?: AbortSignal;
}

interface InitializeResult {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
}

function isInitializeResult(value: unknown): value is InitializeResult {
  return typeof value === 'object' && value !== null;
}

export class McpClient {
  private transport: McpTransport;
  private toolsCache: McpToolDescriptor[] | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  readonly name: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    readonly config: McpServerConfig,
    opts: McpClientOptions = {}
  ) {
    this.name = config.name;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 20_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.transport =
      config.transport === 'http' ? new McpHttpTransport(config) : new McpStdioTransport(config);
  }

  get state(): string {
    return this.transport.state;
  }

  get lastError(): string | undefined {
    return this.transport.lastError;
  }

  get serverInfo(): { name?: string; version?: string } | undefined {
    return this.serverInfoValue;
  }

  private serverInfoValue: InitializeResult['serverInfo'] | undefined;

  /** Connect + initialize handshake. Safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doConnect();
    return this.initPromise;
  }

  private async doConnect(): Promise<void> {
    await this.transport.start(this.connectTimeoutMs);
    const result = await this.transport.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: clientInfo(),
      },
      { timeoutMs: this.connectTimeoutMs }
    );
    if (isInitializeResult(result)) {
      // Accept the server's negotiated version (it may differ from ours).
      const negotiated =
        typeof result.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION;
      if (this.transport instanceof McpHttpTransport) {
        this.transport.setNegotiatedProtocolVersion(negotiated);
      }
      this.serverInfoValue = result.serverInfo;
    }
    this.transport.notify('notifications/initialized');
    this.initialized = true;
    log.debug('initialized', {
      server: this.name,
      serverName: this.serverInfoValue?.name,
    });
  }

  /**
   * `tools/list` with cursor pagination and a session cache. The cache is the
   * lazy-loading backbone: connect primes it once, the search meta-tool reads
   * it for free, and real tools fetch their schema from it on first call.
   */
  async listTools(opts: McpListToolsOptions = {}): Promise<McpToolDescriptor[]> {
    if (!opts.refresh && this.toolsCache) return this.toolsCache;
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {}, {
        timeoutMs: this.requestTimeoutMs,
        signal: opts.signal,
      });
      const page = parseToolsListResult(result);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 100);
    this.toolsCache = tools;
    return tools;
  }

  getCachedTools(): McpToolDescriptor[] | undefined {
    return this.toolsCache ?? undefined;
  }

  findCachedTool(name: string): McpToolDescriptor | undefined {
    return this.toolsCache?.find((t) => t.name === name);
  }

  /** `tools/call` — resolves with the server result (even when isError=true). */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<McpToolCallResult> {
    if (!this.initialized) {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp client for "${this.name}" is not initialized`,
        recoverable: false,
      });
    }
    const result = await this.transport.request(
      'tools/call',
      { name, arguments: args },
      { timeoutMs: opts.timeoutMs ?? this.requestTimeoutMs, signal: opts.signal }
    );
    if (typeof result !== 'object' || result === null) {
      return { content: [{ type: 'text', text: '(server returned no result body)' }] };
    }
    return result as McpToolCallResult;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

function parseToolsListResult(value: unknown): {
  tools: McpToolDescriptor[];
  nextCursor?: string;
} {
  if (typeof value !== 'object' || value === null) return { tools: [] };
  const raw = value as { tools?: unknown; nextCursor?: unknown };
  const tools: McpToolDescriptor[] = Array.isArray(raw.tools)
    ? raw.tools.filter(
        (t): t is McpToolDescriptor =>
          typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string'
      )
    : [];
  const nextCursor = typeof raw.nextCursor === 'string' ? raw.nextCursor : undefined;
  return { tools, nextCursor };
}
