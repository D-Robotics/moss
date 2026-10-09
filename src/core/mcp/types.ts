/**
 * MCP client shared types (v0.16 S1/S2).
 *
 * Scope: CLIENT only — stdio + streamable HTTP transports, tool lazy-loading.
 * No legacy SSE long-connections, no OAuth, no server side. See
 * docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md (D2).
 */

/** Transport kind for a configured MCP server. */
export type McpTransportKind = 'stdio' | 'http';

/**
 * One MCP server as declared in `.moss/mcp.json` / `<configDir>/mcp.json`.
 *
 * `${ENV_VAR}` references in string values are expanded by the config loader
 * (src/cli/mcp-config.ts) before a config reaches this layer — credentials live
 * only in the environment and are never logged.
 */
export interface McpServerConfig {
  /** Server name (config map key). Used for status lines and tool prefixes. */
  name: string;
  transport: McpTransportKind;

  // ── stdio transport ──────────────────────────────────────────────────────
  /** Executable to spawn (stdio transport). */
  command?: string;
  args?: string[];
  /**
   * Working directory for the stdio child. The built-in rdk-docs npx sets
   * this to a Moss-owned cache directory so npm does not walk the workspace
   * and load a project `.npmrc`. Unset inherits the Moss process cwd.
   */
  cwd?: string;
  /** Extra env for the child process (merged over a sanitized parent env). */
  env?: Record<string, string>;
  /**
   * Spawn from the process environment captured before a project `.env`
   * was loaded. Set on the Moss-injected rdk-docs server.
   */
  startupEnvOnly?: boolean;

  // ── http transport (streamable HTTP) ─────────────────────────────────────
  /** Endpoint URL, e.g. `https://host/mcp`. */
  url?: string;
  /** Extra request headers (auth). Values may reference `${ENV_VAR}`. */
  headers?: Record<string, string>;

  /**
   * Override the client defaults (connect 20s, request 120s) for this server.
   * The built-in rdk-docs server sets both; other servers leave them unset.
   */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** A tool as reported by the server's `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments (object schema). */
  inputSchema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** Lifecycle of one server connection. */
export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed' | 'closed';

// ── JSON-RPC 2.0 message shapes (narrowed, no any) ─────────────────────────

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** A parsed inbound JSON-RPC message (response or notification). */
export interface InboundJsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

/** One content block of a `tools/call` result. */
export interface McpContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
  [key: string]: unknown;
}

/** Result of a successful `tools/call` (after JSON-RPC level checks). */
export interface McpToolCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
}

/** Options accepted by transport-level request calls. */
export interface McpTransportRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Transport contract shared by stdio and streamable HTTP. Transports own
 * framing and process/connection lifecycle only — the initialize handshake and
 * MCP methods live in `client.ts`.
 */
export interface McpTransport {
  readonly kind: McpTransportKind;
  readonly state: McpConnectionState;
  /** Last failure reason (never includes credential values). */
  readonly lastError: string | undefined;

  /** Start the transport (spawn the child / validate the URL). No handshake. */
  start(timeoutMs: number): Promise<void>;
  /** Send a JSON-RPC request and resolve with `result`. Rejects on error/timeout/close. */
  request(
    method: string,
    params?: Record<string, unknown>,
    opts?: McpTransportRequestOptions
  ): Promise<unknown>;
  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
}
