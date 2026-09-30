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
      onWarning?.(`[mcp] skipping server "${name}" in ${filePath}: entry must be an object`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const transport: McpTransportKind = record.transport === 'http' ? 'http' : 'stdio';
    if (transport === 'http' && typeof record.url !== 'string') {
      onWarning?.(`[mcp] skipping server "${name}" in ${filePath}: http transport requires "url"`);
      continue;
    }
    if (transport === 'stdio' && typeof record.command !== 'string') {
      onWarning?.(
        `[mcp] skipping server "${name}" in ${filePath}: stdio transport requires "command"`
      );
      continue;
    }
    out.set(name, expandServerEntry(name, record, env));
  }
  return out;
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
  onWarning?: (message: string) => void
): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const dir of [configDir, path.join(workspaceDir, '.moss')]) {
    const map = readServerMap(path.join(dir, 'mcp.json'), env, onWarning);
    for (const [name, config] of map) {
      merged.set(name, config); // later dirs (workspace) shadow earlier ones
    }
  }
  return [...merged.values()];
}
