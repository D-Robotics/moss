/**
 * When the built-in rdk-docs server is part of a session.
 *
 * Default is on for a device context (MOSS_DEVICE_HOST or a saved device) and
 * when config `rdkDocs` is true. Coding sessions do not spawn npx.
 * Opt out with MOSS_NO_RDK_DOCS=1 or `rdkDocs: false` (either wins over a
 * device target). A same-named mcp.json entry replaces the builtin.
 */
import { loadDeviceRegistry } from '../device/device-registry-file.js';
import { RDK_DOCS_SERVER_NAME, builtinRdkDocsServerConfig } from '../core/mcp/rdk-docs.js';
import type { McpServerConfig } from '../core/mcp/types.js';

export interface RdkDocsEnableInput {
  env: NodeJS.ProcessEnv;
  /** Merged config `rdkDocs`, when it was a real boolean. */
  rdkDocs: boolean | undefined;
  workspaceDir: string;
}

export function readRdkDocsFlag(value: unknown): boolean | undefined {
  return value === true || value === false ? value : undefined;
}

/** Positive opt-out. Env wins so one session can disable a saved `rdkDocs: true`. */
export function rdkDocsOptOut(env: NodeJS.ProcessEnv, rdkDocs: boolean | undefined): boolean {
  const raw = (env.MOSS_NO_RDK_DOCS ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  return rdkDocs === false;
}

export function hasDeviceTarget(workspaceDir: string, env: NodeJS.ProcessEnv): boolean {
  if ((env.MOSS_DEVICE_HOST ?? '').trim()) return true;
  return loadDeviceRegistry(workspaceDir).length > 0;
}

/**
 * Whether this session should connect the builtin server.
 * Opt-out first, then an explicit `rdkDocs: true`, then a device target.
 */
export function rdkDocsAutoConnectEnabled(input: RdkDocsEnableInput): boolean {
  if (rdkDocsOptOut(input.env, input.rdkDocs)) return false;
  if (input.rdkDocs === true) return true;
  return hasDeviceTarget(input.workspaceDir, input.env);
}

/**
 * Prepend the builtin server unless it is disabled or the caller already has
 * an entry of the same name (that entry replaces the builtin entirely).
 */
export function withBuiltinRdkDocs(
  configs: readonly McpServerConfig[],
  enabled: boolean
): McpServerConfig[] {
  if (!enabled) return [...configs];
  if (configs.some((config) => config.name === RDK_DOCS_SERVER_NAME)) return [...configs];
  return [builtinRdkDocsServerConfig(), ...configs];
}

export function formatMcpStartupLine(
  status: { name: string; state: string; toolCount?: number; error?: string },
  detail: string
): string | undefined {
  if (status.state === 'failed' && status.name === RDK_DOCS_SERVER_NAME) {
    const reason = status.error?.trim() || 'connection failed';
    return `[mcp] rdk-docs unreachable (${reason}) — RDK manual lookup is off this session.`;
  }
  if (status.state === 'failed') {
    return `[mcp] server "${status.name}" unavailable: ${status.error} — its tools are disabled for this session.`;
  }
  if (status.state === 'connected' && detail !== 'quiet') {
    const wire = status.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `[mcp] server "${status.name}" connected (${status.toolCount ?? 0} tools, lazy-loaded — search with mcp__${wire}__search)`;
  }
  return undefined;
}

export function rdkDocsInactiveNotice(zh: boolean): string {
  return zh
    ? 'rdk-docs 内置服务器本次未连接：没有设备目标。设置 MOSS_DEVICE_HOST、登记一台设备，或在配置里写 "rdkDocs": true。退出用 MOSS_NO_RDK_DOCS=1 或 "rdkDocs": false。'
    : 'rdk-docs builtin is off this session (no device target). Set MOSS_DEVICE_HOST, register a device, or set "rdkDocs": true. Opt out with MOSS_NO_RDK_DOCS=1 or "rdkDocs": false.';
}
