/**
 * MCP server config loading — `.moss/mcp.json` (workspace) merged with
 * `<configDir>/mcp.json` (user). Mirrors the custom-commands dual-directory
 * precedence: workspace entries shadow user entries with the same name.
 *
 * File shape (both files):
 * ```json
 * {
 *   "mcpServers": {
 *     "context7": {
 *       "transport": "http",
 *       "url": "https://mcp.example.com/mcp",
 *       "headers": { "Authorization": "Bearer ${MY_MCP_TOKEN}" }
 *     },
 *     "formatter": {
 *       "transport": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "some-mcp-server"],
 *       "env": { "API_BASE": "${MY_API_BASE}" }
 *     }
 *   }
 * }
 * ```
 *
 * `${ENV_VAR}` references expand from the environment at load time; a missing
 * variable expands to the empty string. Credential values live only in env
 * vars — they are never logged and never written back.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, McpTransportKind } from '../core/mcp/types.js';
import { isZhLocale } from './cli-locale.js';

function mcpSkip(name: string, filePath: string, whyEn: string, whyZh: string): string {
  return isZhLocale()
    ? `[mcp] 跳过 ${filePath} 里的服务器「${name}」：${whyZh}`
    : `[mcp] skipping server "${name}" in ${filePath}: ${whyEn}`;
}

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expand `${VAR}` references against `env`; missing vars become ''. */
export function expandEnvRefs(
  value: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): string {
  return value.replace(ENV_REF_RE, (_, name: string) => env[name] ?? '');
}

function expandServerEntry(
  name: string,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): McpServerConfig {
  const expandString = (v: unknown): string => (typeof v === 'string' ? expandEnvRefs(v, env) : '');
  const config: McpServerConfig = {
    name,
    transport: raw.transport === 'http' ? 'http' : 'stdio',
  };
  if (typeof raw.command === 'string') config.command = expandString(raw.command);
  if (Array.isArray(raw.args)) config.args = raw.args.map((a) => expandString(a));
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const expandedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      expandedEnv[k] = expandString(v);
    }
    config.env = expandedEnv;
  }
  if (typeof raw.connectTimeoutMs === 'number' && Number.isFinite(raw.connectTimeoutMs)) {
    config.connectTimeoutMs = raw.connectTimeoutMs;
  }
  if (typeof raw.requestTimeoutMs === 'number' && Number.isFinite(raw.requestTimeoutMs)) {
    config.requestTimeoutMs = raw.requestTimeoutMs;
  }
  if (typeof raw.url === 'string') config.url = expandString(raw.url);
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    const expandedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      expandedHeaders[k] = expandString(v);
    }
    config.headers = expandedHeaders;
  }
  return config;
}

export interface McpFileBrief {
  name: string;
  transport: McpTransportKind;
  config: McpServerConfig;
}

/** Servers declared in one mcp.json. A missing or invalid file is an empty list. */
export function describeMcpFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  onWarning?: (message: string) => void
): McpFileBrief[] {
  return [...readServerMap(filePath, env, onWarning).values()].map((config) => ({
    name: config.name,
    transport: config.transport,
    config,
  }));
}

function readServerMap(
  filePath: string,
  env: NodeJS.ProcessEnv,
  onWarning?: (message: string) => void
): Map<string, McpServerConfig> {
  const out = new Map<string, McpServerConfig>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return out; // missing file = no servers from this dir
  }
  if (typeof raw !== 'object' || raw === null) return out;
  const servers =
    (raw as { mcpServers?: unknown }).mcpServers ??
    // Lenient fallback: a bare map of server entries (same shape minus the
    // mcpServers wrapper).
    raw;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return out;
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (!name.trim()) continue;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      onWarning?.(mcpSkip(name, filePath, 'entry must be an object', '条目必须是对象'));
      continue;
    }
    const record = entry as Record<string, unknown>;
    const transport: McpTransportKind = record.transport === 'http' ? 'http' : 'stdio';
    if (transport === 'http' && typeof record.url !== 'string') {
      onWarning?.(mcpSkip(name, filePath, 'http transport requires "url"', 'http 传输需要 "url"'));
      continue;
    }
    if (transport === 'stdio' && typeof record.command !== 'string') {
      onWarning?.(
        mcpSkip(name, filePath, 'stdio transport requires "command"', 'stdio 传输需要 "command"')
      );
      continue;
    }
    out.set(name, expandServerEntry(name, record, env));
  }
  return out;
}

export interface LoadMcpConfigOptions {
  /**
   * When false, ignore the workspace file and `extraFiles` entirely (stdio
   * and HTTP). Those entries are project code: an HTTP URL would otherwise
   * expand `${VAR}` and send the user environment to a project-chosen host.
   * User `<configDir>/mcp.json` is unchanged. Default true.
   */
  projectServers?: boolean;
  /** Extra mcp.json files (for example a project `.mcp.json`), merged last. */
  extraFiles?: string[];
}

/**
 * Load and merge MCP server configs from `<workspace>/.moss/mcp.json` and
 * `<configDir>/mcp.json` (workspace wins on name clashes). Returns [] when
 * neither file exists — zero-config means zero MCP work.
 */
export function loadMcpConfigs(
  workspaceDir: string,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  onWarning?: (message: string) => void,
  options: LoadMcpConfigOptions = {}
): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  const apply = (map: Map<string, McpServerConfig>) => {
    for (const [name, config] of map) merged.set(name, config);
  };
  apply(readServerMap(path.join(configDir, 'mcp.json'), env, onWarning));
  if (options.projectServers === false) return [...merged.values()];
  apply(readServerMap(path.join(workspaceDir, '.moss', 'mcp.json'), env, onWarning));
  for (const file of options.extraFiles ?? []) {
    apply(readServerMap(file, env, onWarning));
  }
  return [...merged.values()];
}
