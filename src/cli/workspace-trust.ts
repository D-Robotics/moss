/**
 * One-time workspace trust for project code that would run on startup:
 * project hooks (including `.moss/config.json`), project stdio MCP (including
 * `.moss/mcp.json`), project agents that can write, and plugins.
 *
 * The built-in rdk-docs server is injected by Moss after project entries are
 * dropped, so it is exempt by origin. A project server named `rdk-docs` is
 * still project code. The user's own config (`~/.config/moss` and `~/.moss`)
 * is not project code either. Neither raises this prompt.
 *
 * Headless `-p` (and a piped chat) skips project code unless this process
 * passes `--trust-workspace` / `MOSS_TRUST_WORKSPACE=1` or the path was
 * trusted before. Other non-interactive commands still load project config so
 * automation that is not `-p` keeps working.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isZhLocale } from './cli-locale.js';
import { chrome } from './tui/copy.js';
import {
  claudeMcpPath,
  describeClaudeMcp,
  readClaudeProjectHooks,
  resolveClaudeCompatOptIn,
} from './claude-compat.js';
import {
  HOOK_EVENT_KEYS,
  envBeforeDotenv,
  loadConfigFile,
  mergeHooksConfig,
  startupHomeDir,
  type HooksConfig,
} from './config.js';
import {
  loadAgentFiles,
  projectAgentDeclaresWriteTools,
} from '../core/subagent/agent-file-loader.js';
import { describeMcpFile, type LoadMcpConfigOptions } from './mcp-config.js';

export interface TrustItem {
  kind: 'hook' | 'stdio-mcp' | 'http-mcp' | 'agent' | 'plugin' | 'status-line';
  label: string;
}

const TRUST_FILE = 'workspace-trust.json';

function workspaceKey(workspaceDir: string): string {
  try {
    return fs.realpathSync.native(workspaceDir);
  } catch {
    return path.resolve(workspaceDir);
  }
}

/** Live `process.env` has already applied `.env`. Trust uses the pre-dotenv copy. */
function resolvedEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  if (!env || env === process.env) return envBeforeDotenv;
  return env;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HOME ?? env.USERPROFILE;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return startupHomeDir();
}

/** The user's own Moss directory (`~/.moss`), as opposed to `<workspace>/.moss`. */
export function userMossDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(homeDir(env), '.moss');
}

function existingPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function isInsideDir(root: string, target: string): boolean {
  const base = existingPath(root);
  const child = existingPath(target);
  return child === base || child.startsWith(base + path.sep);
}

/**
 * True when this workspace's `.moss` is the user's `~/.moss` (Moss was started
 * in the home directory). Those files belong to the user, not to a project.
 */
function workspaceUsesUserMoss(workspaceDir: string, env: NodeJS.ProcessEnv): boolean {
  return isInsideDir(userMossDir(env), path.join(workspaceDir, '.moss'));
}

function readStore(configDir: string): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(configDir, TRUST_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(configDir: string, store: Record<string, boolean>): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, TRUST_FILE), `${JSON.stringify(store, null, 2)}\n`);
}

export function trustEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.MOSS_TRUST_WORKSPACE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function countHooks(hooks: HooksConfig | undefined): number {
  if (!hooks) return 0;
  let count = 0;
  for (const key of HOOK_EVENT_KEYS) count += hooks[key]?.length ?? 0;
  return count;
}

/**
 * Same write-tool rule as the agent loader. Discovery uses a provisional
 * allow so the prompt can name the agents; the real decision is passed back
 * into `loadAgentFiles` later.
 */
function writeAgentLabels(input: {
  workspaceDir: string;
  homeDir?: string;
  includeClaude: boolean;
  scanMoss: boolean;
}): string[] {
  if (!input.scanMoss && !input.includeClaude) return [];
  const loaded = loadAgentFiles({
    workspaceDir: input.workspaceDir,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    projectTrust: { trusted: true, claudeOptIn: input.includeClaude },
  });
  const labels: string[] = [];
  for (const agent of loaded.agents) {
    if (!input.scanMoss && agent.agentOrigin === 'project-moss') continue;
    if (!projectAgentDeclaresWriteTools(agent)) continue;
    labels.push(agent.id);
  }
  return labels;
}

function pluginName(dir: string, fallback: string): string {
  for (const rel of ['plugin.json', path.join('.claude-plugin', 'plugin.json')]) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const name = (raw as { name?: unknown }).name;
        if (typeof name === 'string' && name.trim()) return name.trim();
      }
    } catch {
      /* try the next manifest */
    }
  }
  return fallback;
}

function listPlugins(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const hasManifest =
      fs.existsSync(path.join(pluginDir, 'plugin.json')) ||
      fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'));
    if (!hasManifest) continue;
    names.push(pluginName(pluginDir, entry.name));
  }
  return names;
}

export function listProjectTrustItems(input: {
  workspaceDir: string;
  projectHooks?: HooksConfig;
  claudeHooks?: HooksConfig;
  projectMcp?: ReadonlyArray<{ name: string; transport: 'stdio' | 'http' }>;
  claudeMcp?: ReadonlyArray<{ name: string; transport: 'stdio' | 'http' }>;
  /** Project statusLine command that would run because the user set none. */
  statusCommand?: boolean;
  includeClaudeAgents?: boolean;
  /** False when `<workspace>/.moss` is the user's `~/.moss`. */
  scanMossExtensions?: boolean;
  homeDir?: string;
}): TrustItem[] {
  const items: TrustItem[] = [];
  const hooks = countHooks(input.projectHooks) + countHooks(input.claudeHooks);
  if (hooks > 0) items.push({ kind: 'hook', label: `project hooks (${hooks})` });
  if (input.statusCommand) items.push({ kind: 'status-line', label: 'status line' });
  const servers = [...(input.projectMcp ?? []), ...(input.claudeMcp ?? [])];
  const seen = new Set<string>();
  for (const server of servers) {
    const key = `${server.transport}\0${server.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind: server.transport === 'http' ? 'http-mcp' : 'stdio-mcp',
      label: server.name,
    });
  }
  const pluginDirs: string[] = [];
  if (input.scanMossExtensions !== false) {
    pluginDirs.push(path.join(input.workspaceDir, '.moss', 'plugins'));
  }
  if (input.includeClaudeAgents) {
    pluginDirs.push(path.join(input.workspaceDir, '.claude', 'plugins'));
  }
  for (const name of writeAgentLabels({
    workspaceDir: input.workspaceDir,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    includeClaude: input.includeClaudeAgents === true,
    scanMoss: input.scanMossExtensions !== false,
  })) {
    items.push({ kind: 'agent', label: name });
  }
  for (const name of pluginDirs.flatMap(listPlugins)) {
    items.push({ kind: 'plugin', label: name });
  }
  return items;
}

function hookCount(label: string): string | undefined {
  return /\((\d+)\)/.exec(label)?.[1];
}

export function summarizeTrustItems(items: readonly TrustItem[], zh = false): string {
  if (items.length === 0) return '';
  const hooks = items.find((item) => item.kind === 'hook');
  const stdio = items.filter((item) => item.kind === 'stdio-mcp').map((item) => item.label);
  const http = items.filter((item) => item.kind === 'http-mcp').map((item) => item.label);
  const agents = items.filter((item) => item.kind === 'agent').map((item) => item.label);
  const plugins = items.filter((item) => item.kind === 'plugin').map((item) => item.label);
  const parts: string[] = [];
  if (hooks) {
    const count = hookCount(hooks.label);
    parts.push(
      count === undefined ? hooks.label : chrome('project hooks ({count})', zh, { count })
    );
  }
  if (items.some((item) => item.kind === 'status-line')) parts.push(chrome('status line', zh));
  if (stdio.length > 0) {
    parts.push(chrome('stdio MCP ({names})', zh, { names: stdio.join(', ') }));
  }
  if (http.length > 0) parts.push(chrome('HTTP MCP ({names})', zh, { names: http.join(', ') }));
  if (agents.length > 0) parts.push(chrome('agent {names}', zh, { names: agents.join(', ') }));
  if (plugins.length > 0) parts.push(chrome('plugin {names}', zh, { names: plugins.join(', ') }));
  return parts.join(zh ? '、' : ', ');
}

/**
 * Fullscreen hides anything printed before the alternate screen. An interactive
 * TUI therefore keeps this one line for the transcript; `-p` and the REPL stay
 * on stderr.
 */
export function deliverWorkspaceTrustNotice(
  notice: string | undefined,
  useTui: boolean,
  sinks: {
    transcript: (line: string) => void;
    stderr: (line: string) => void;
  }
): void {
  if (!notice) return;
  if (useTui) sinks.transcript(notice);
  else sinks.stderr(notice);
}

export function trustQuestion(summary: string, zh: boolean): string {
  return zh
    ? `信任此工作区并运行 ${summary}？[y/N] `
    : `Trust this workspace to run ${summary}? [y/N] `;
}

export function untrustedWorkspaceLine(summary: string, zh: boolean): string {
  return zh
    ? `[moss] 工作区未信任 — 已跳过 ${summary}。用 --trust-workspace 或 MOSS_TRUST_WORKSPACE=1 启用。`
    : `[moss] Untrusted workspace — skipped ${summary}. Enable with --trust-workspace or MOSS_TRUST_WORKSPACE=1.`;
}

function isYes(answer: string): boolean {
  return /^(y|yes|是)$/i.test(answer.trim());
}

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const finish = (answer: string) => {
      rl.close();
      resolve(isYes(answer));
    };
    rl.once('SIGINT', () => finish(''));
    rl.question(question, finish);
  });
}

export async function resolveWorkspaceTrust(input: {
  workspaceDir: string;
  configDir: string;
  items: readonly TrustItem[];
  interactive: boolean;
  headlessUntrusted: boolean;
  trustFlag: boolean;
  env?: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<boolean>;
  zh?: boolean;
}): Promise<{ trusted: boolean; skipped: TrustItem[] }> {
  if (input.items.length === 0) return { trusted: true, skipped: [] };
  const env = resolvedEnv(input.env);
  if (input.trustFlag || trustEnvEnabled(env)) return { trusted: true, skipped: [] };
  const key = workspaceKey(input.workspaceDir);
  const store = readStore(input.configDir);
  if (store[key] === true) return { trusted: true, skipped: [] };
  if (store[key] === false) return { trusted: false, skipped: [...input.items] };
  if (input.interactive) {
    const zh = input.zh ?? isZhLocale();
    const yes = await (input.ask ?? askYesNo)(
      trustQuestion(summarizeTrustItems(input.items, zh), zh)
    );
    store[key] = yes;
    writeStore(input.configDir, store);
    return { trusted: yes, skipped: yes ? [] : [...input.items] };
  }
  if (input.headlessUntrusted) return { trusted: false, skipped: [...input.items] };
  return { trusted: true, skipped: [] };
}

export interface ResolvedProjectCapabilities {
  hooks: HooksConfig | undefined;
  mcp: LoadMcpConfigOptions;
  notice?: string;
  /** Claude project files were accepted for this workspace. */
  claudeOptIn: boolean;
  trusted: boolean;
}

export async function resolveProjectCapabilities(input: {
  workspaceDir: string;
  configDir: string;
  configPath: string;
  projectConfigPath?: string;
  interactive: boolean;
  headlessUntrusted: boolean;
  trustFlag: boolean;
  env?: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<boolean>;
  zh?: boolean;
}): Promise<ResolvedProjectCapabilities> {
  const env = resolvedEnv(input.env);
  const userFile = loadConfigFile(input.configPath);
  const userHooks = userFile.hooks;
  const projectFile = input.projectConfigPath ? loadConfigFile(input.projectConfigPath) : undefined;
  const projectHooks = projectFile?.hooks;
  // A walk up from the workspace can land on `~/.moss/config.json`. That file
  // is the user's, so it loads like `~/.config/moss` and does not ask.
  const inheritedUserHooks =
    input.projectConfigPath && isInsideDir(userMossDir(env), input.projectConfigPath)
      ? projectHooks
      : undefined;
  const gatedProjectHooks = inheritedUserHooks ? undefined : projectHooks;
  const gatedProjectFile = inheritedUserHooks ? undefined : projectFile;
  const statusCommand =
    userFile.statusLine === undefined && Boolean(gatedProjectFile?.statusLine?.command?.trim());
  const userOwnedWorkspace = workspaceUsesUserMoss(input.workspaceDir, env);
  const claudeOptIn = await resolveClaudeCompatOptIn({
    workspaceDir: input.workspaceDir,
    configDir: input.configDir,
    interactive: input.interactive,
    ...(input.ask ? { ask: input.ask } : {}),
    ...(input.zh !== undefined ? { zh: input.zh } : {}),
  });
  const claudeHooks = claudeOptIn ? readClaudeProjectHooks(input.workspaceDir) : undefined;
  const mcpBrief = (file: string) =>
    describeMcpFile(file, {}).map((brief) => ({
      name: brief.name,
      transport: brief.transport,
    }));
  const projectMcp = userOwnedWorkspace
    ? []
    : mcpBrief(path.join(input.workspaceDir, '.moss', 'mcp.json'));
  const claudeMcp = claudeOptIn ? describeClaudeMcp(input.workspaceDir) : [];
  const items = listProjectTrustItems({
    workspaceDir: input.workspaceDir,
    projectHooks: gatedProjectHooks,
    claudeHooks,
    projectMcp,
    claudeMcp,
    statusCommand,
    includeClaudeAgents: claudeOptIn,
    scanMossExtensions: !userOwnedWorkspace,
    homeDir: homeDir(env),
  });
  const decision = await resolveWorkspaceTrust({
    workspaceDir: input.workspaceDir,
    configDir: input.configDir,
    items,
    interactive: input.interactive,
    headlessUntrusted: input.headlessUntrusted,
    trustFlag: input.trustFlag,
    env,
    ...(input.ask ? { ask: input.ask } : {}),
    ...(input.zh !== undefined ? { zh: input.zh } : {}),
  });
  // Project hooks run before Claude hooks; both run before the user file.
  // Hooks inherited from `~/.moss/config.json` stay with the user file.
  const projectLayer = decision.trusted
    ? mergeHooksConfig(claudeHooks, gatedProjectHooks)
    : undefined;
  const hooks = mergeHooksConfig(mergeHooksConfig(userHooks, inheritedUserHooks), projectLayer);
  const extraFiles = claudeOptIn ? [claudeMcpPath(input.workspaceDir)] : [];
  const zh = input.zh ?? isZhLocale();
  const summary = summarizeTrustItems(decision.skipped, zh);
  return {
    hooks,
    mcp: {
      projectServers: decision.trusted,
      ...(extraFiles.length > 0 ? { extraFiles } : {}),
    },
    ...(summary && !decision.trusted ? { notice: untrustedWorkspaceLine(summary, zh) } : {}),
    claudeOptIn,
    trusted: decision.trusted,
  };
}
