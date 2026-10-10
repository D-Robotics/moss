/**
 * When the built-in rdk-docs server is part of a session.
 *
 * Default is on, including workspaces with no device. The CLI connects it in
 * the background (`McpToolRegistry.connectInBackground`) so startup does not
 * wait on npx. Opt out with MOSS_NO_RDK_DOCS=1 or `rdkDocs: false` (either
 * wins). A loaded mcp.json entry of the same name replaces the builtin. An
 * untrusted project entry is not loaded, so Moss still injects its own.
 */
import { loadDeviceRegistry } from '../device/device-registry-file.js';
import {
  DEFAULT_RDK_DOCS_MCP_PACKAGE,
  RDK_DOCS_SERVER_NAME,
  builtinRdkDocsServerConfig,
} from '../core/mcp/rdk-docs.js';
import type { McpServerConfig } from '../core/mcp/types.js';
import { ErrorCode, throwMoss } from '../errors.js';
import { tui } from './tui/copy.js';
import { uiText } from '../utils/ui-language.js';

export interface RdkDocsConfigValue {
  enabled?: boolean;
  package?: string;
}

export interface RdkDocsEnableInput {
  env: NodeJS.ProcessEnv;
  /** Merged config `rdkDocs.enabled` (or the legacy boolean form). */
  rdkDocs: boolean | undefined;
  workspaceDir: string;
}

export function readRdkDocsFlag(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const enabled = (value as RdkDocsConfigValue).enabled;
  return enabled === true || enabled === false ? enabled : undefined;
}

/**
 * Resolve the executable package spec. Env is useful for a one-off checkout;
 * config is persistent. The value is one argv token, never a command string.
 */
export function resolveRdkDocsPackage(value: unknown, env: NodeJS.ProcessEnv): string {
  const configPackage =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as RdkDocsConfigValue).package
      : undefined;
  const candidate = (env.MOSS_RDK_DOCS_PACKAGE ?? configPackage ?? '').trim();
  if (!candidate) return DEFAULT_RDK_DOCS_MCP_PACKAGE;
  if (
    candidate.length > 2_048 ||
    candidate.startsWith('-') ||
    candidate.includes('\0') ||
    candidate.includes('\r') ||
    candidate.includes('\n')
  ) {
    throwMoss({
      code: ErrorCode.USER_INPUT_INVALID,
      message: 'Invalid rdk-docs package spec.',
      hint: 'Use an npm spec (for example rdk-docs-mcp@0.2.0) or a local directory/tarball path.',
    });
  }
  return candidate;
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
 * On unless MOSS_NO_RDK_DOCS or `rdkDocs: false`. A device target is not required.
 * `workspaceDir` stays on the input so callers and tests keep one shape.
 */
export function rdkDocsAutoConnectEnabled(input: RdkDocsEnableInput): boolean {
  return !rdkDocsOptOut(input.env, input.rdkDocs);
}

/**
 * Prepend the builtin server unless it is disabled or the caller already has
 * a loaded entry of the same name (that entry replaces the builtin entirely).
 * Project entries are loaded only after workspace trust, so the builtin is
 * the Moss-origin server, not a name match against a project file.
 */
export function withBuiltinRdkDocs(
  configs: readonly McpServerConfig[],
  enabled: boolean,
  packageSpec = DEFAULT_RDK_DOCS_MCP_PACKAGE
): McpServerConfig[] {
  if (!enabled) return [...configs];
  if (configs.some((config) => config.name === RDK_DOCS_SERVER_NAME)) return [...configs];
  return [builtinRdkDocsServerConfig(packageSpec), ...configs];
}

/**
 * One status line for `/mcp` and TUI notices. States are connecting,
 * connected, or failed with the registry's reason. This is the only wording
 * those surfaces should use.
 */
export function formatMcpStatusLine(
  status: { name: string; state: string; toolCount?: number; error?: string },
  toolsLabel?: string
): string {
  const countLabel =
    toolsLabel !== undefined
      ? toolsLabel
      : status.state === 'connected' && status.toolCount !== undefined
        ? tui(' ({count} tools, lazy)', { count: status.toolCount })
        : '';
  if (status.state === 'failed') {
    const reason = status.error?.trim().split('\n')[0]?.slice(0, 160) || tui('connection failed');
    return tui('○ {name} — failed: {reason}', { name: status.name, reason });
  }
  if (status.state === 'connected') {
    return `${tui('● {name} — connected', { name: status.name })}${countLabel}`;
  }
  if (status.state === 'connecting' && !status.error?.trim()) {
    return tui('○ {name} — connecting', { name: status.name });
  }
  const extra = status.error?.trim().split('\n')[0]?.slice(0, 160);
  return `○ ${status.name} — ${status.state}${extra ? `: ${extra}` : ''}`;
}

export function formatMcpStartupLine(
  status: { name: string; state: string; toolCount?: number; error?: string },
  detail: string
): string | undefined {
  if (status.state === 'failed' && status.name === RDK_DOCS_SERVER_NAME) {
    const reason = status.error?.trim() || uiText('connection failed', '连接失败');
    return uiText(
      `[mcp] rdk-docs unreachable (${reason}) — RDK manual lookup is off this session.`,
      `[mcp] rdk-docs 无法连接（${reason}）— 本会话不查 RDK 手册。`
    );
  }
  if (status.state === 'failed') {
    return uiText(
      `[mcp] server "${status.name}" unavailable: ${status.error} — its tools are disabled for this session.`,
      `[mcp] 服务器「${status.name}」不可用：${status.error} — 本会话已停用它的工具。`
    );
  }
  if (status.state === 'connected' && detail !== 'quiet') {
    const wire = status.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const count = status.toolCount ?? 0;
    return uiText(
      `[mcp] server "${status.name}" connected (${count} tools, lazy-loaded — search with mcp__${wire}__search)`,
      `[mcp] 服务器「${status.name}」已连接（${count} 个工具，懒加载 — 用 mcp__${wire}__search 搜索）`
    );
  }
  return undefined;
}

export function rdkDocsInactiveNotice(zh: boolean): string {
  return zh
    ? 'rdk-docs 内置服务器本次未连接。退出开关是 MOSS_NO_RDK_DOCS=1 或配置 "rdkDocs": false。'
    : 'rdk-docs builtin is off this session. Opt out with MOSS_NO_RDK_DOCS=1 or "rdkDocs": false.';
}
