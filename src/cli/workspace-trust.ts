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
import { isZhLocale } from './cli-locale.js';
import { ExitCode } from './exit-codes.js';
import {
  folderPathKey,
  forgetFolderTrust,
  isFilesystemRoot,
  isFolderTrusted,
  listTrustedFolders,
  rememberFolderTrust,
} from './folder-trust-store.js';
import { chrome } from './tui/copy.js';
import { runGit } from '../utils/git-spawn.js';
import {
  claudeMcpPath,
  claudeProjectConfigExists,
  describeClaudeMcp,
  readClaudeProjectHooks,
} from './claude-compat.js';
import {
  HOOK_EVENT_KEYS,
  envBeforeDotenv,
  loadConfigFile,
  mergeHooksConfig,
  resolveProjectConfigPath,
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

export {
  forgetFolderTrust,
  isFilesystemRoot,
  isFolderTrusted,
  listTrustedFolders,
  rememberFolderTrust,
};

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

/**
 * Keys left unset from an ancestor `.env` when this folder is already trusted.
 * Trusting the child does not apply the parent file.
 */
export function ancestorRoutingIgnoredLine(
  keys: readonly string[],
  directories: readonly string[],
  zh: boolean
): string {
  const list = keys.filter((key) => key.trim()).join(zh ? '、' : ', ');
  const dir = directories.filter((item) => item.trim()).join(zh ? '、' : ', ');
  return chrome(
    '[moss] Ancestor .env routing keys ignored from {dir}: {list}. Trust that directory to apply them.',
    zh,
    { dir, list }
  );
}

/** One stderr line for a folder that was not trusted. `-p` prints this and continues. */
export function untrustedFolderLine(parts: readonly string[], zh: boolean): string {
  const list = parts.filter((part) => part.trim()).join(zh ? '、' : ', ');
  if (list) {
    return chrome(
      '[moss] Untrusted folder — ignored project settings: {list}. Trust this folder with --trust-workspace or MOSS_TRUST_WORKSPACE=1.',
      zh,
      { list }
    );
  }
  return chrome(
    '[moss] Untrusted folder — project settings that change where traffic goes stay ignored. Trust this folder with --trust-workspace or MOSS_TRUST_WORKSPACE=1.',
    zh
  );
}

/**
 * Folder key: the git toplevel when `dir` is inside a work tree, otherwise
 * `dir` itself. Both are real paths. Git failure means "not a work tree".
 */
export async function resolveFolderKey(dir: string): Promise<string> {
  const cwd = folderPathKey(dir);
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 5_000,
      readOnly: true,
    });
    const top = result.stdout.trim();
    if (top) return folderPathKey(top);
  } catch {
    /* not a git work tree */
  }
  return cwd;
}

function sameFolder(a: string, b: string): boolean {
  try {
    return folderPathKey(a) === folderPathKey(b);
  } catch {
    return false;
  }
}

/**
 * What trusting `workspaceDir` would load. Reads project files only; it does
 * not run hooks or start MCP servers. Claude project files are included so
 * the one prompt can name them.
 */
export function discoverFolderTrustItems(input: {
  workspaceDir: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
}): TrustItem[] {
  const userFile = loadConfigFile(path.join(input.configDir, 'config.json'));
  const projectConfigPath = resolveProjectConfigPath(input.workspaceDir) ?? undefined;
  const inheritedUser =
    projectConfigPath !== undefined && isInsideDir(userMossDir(input.env), projectConfigPath);
  const userOwned = workspaceUsesUserMoss(input.workspaceDir, input.env);
  const projectFile =
    projectConfigPath && !inheritedUser && !userOwned
      ? loadConfigFile(projectConfigPath)
      : undefined;
  const statusCommand =
    userFile.statusLine === undefined && Boolean(projectFile?.statusLine?.command?.trim());
  const mcpBrief = (file: string) =>
    describeMcpFile(file, {}).map((brief) => ({
      name: brief.name,
      transport: brief.transport,
    }));
  return listProjectTrustItems({
    workspaceDir: input.workspaceDir,
    ...(projectFile?.hooks ? { projectHooks: projectFile.hooks } : {}),
    claudeHooks: readClaudeProjectHooks(input.workspaceDir),
    projectMcp: userOwned ? [] : mcpBrief(path.join(input.workspaceDir, '.moss', 'mcp.json')),
    claudeMcp: describeClaudeMcp(input.workspaceDir),
    statusCommand,
    includeClaudeAgents: true,
    scanMossExtensions: !userOwned,
    homeDir: homeDir(input.env),
  });
}

export function folderTrustPrompt(input: {
  folderKey: string;
  home: boolean;
  root: boolean;
  zh: boolean;
  items?: readonly TrustItem[];
}): string {
  const lines: string[] = [];
  if (input.home) lines.push(chrome('This folder is your home directory.', input.zh));
  if (input.root) {
    lines.push(
      chrome('This folder is the filesystem root. Trusting it is not remembered.', input.zh)
    );
  }
  const summary = summarizeTrustItems(input.items ?? [], input.zh);
  lines.push(
    summary
      ? chrome('Trusting loads {summary}.', input.zh, { summary })
      : chrome('This project has no hooks, MCP servers, agents, or plugins.', input.zh)
  );
  lines.push(chrome('A trusted project can change the model gateway, proxy, and TLS.', input.zh));
  lines.push(chrome('Trust this folder?', input.zh));
  lines.push(`  ${input.folderKey}`);
  lines.push(`  1  ${chrome('Yes, trust this folder', input.zh)}`);
  lines.push(`  2  ${chrome('No, exit', input.zh)}`);
  return lines.join('\n');
}

export type FolderTrustKey = 'yes' | 'no';

function classifyTrustKey(text: string): FolderTrustKey | undefined {
  if (text.includes('\u0003')) return 'no';
  const token = text
    .replace(/[\r\n]/g, '')
    .trim()
    .toLowerCase();
  const entered = text.includes('\r') || text.includes('\n');
  if (entered && (token === '' || token === '1' || token === 'y' || token === 'yes')) return 'yes';
  if (entered && (token === '2' || token === 'n' || token === 'no')) return 'no';
  if (!entered && (token === '1' || token === 'y')) return 'yes';
  if (!entered && (token === '2' || token === 'n')) return 'no';
  return undefined;
}

/** One keypress. Enter is Yes. Anything else waits. */
function readTrustKey(): Promise<FolderTrustKey> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const raw = Boolean(stdin.isTTY && typeof stdin.setRawMode === 'function');
    let settled = false;
    const finish = (answer: FolderTrustKey) => {
      if (settled) return;
      settled = true;
      stdin.off('data', onData);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const answer = classifyTrustKey(text);
      if (answer) finish(answer);
    };
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export interface FolderTrustDecision {
  trusted: boolean;
  folderKey: string;
  prompted: boolean;
  /** False when the folder is `/`. A yes still trusts this process. */
  persisted: boolean;
}

/**
 * Decide folder trust before any tool, hook, or model call.
 * Interactive: one prompt. Yes is stored on the user (never for `/`).
 * No exits. Non-interactive never prompts.
 */
export async function resolveFolderTrust(input: {
  startDir: string;
  configDir: string;
  interactive: boolean;
  trustFlag: boolean;
  env?: NodeJS.ProcessEnv;
  zh?: boolean;
  readKey?: () => Promise<FolderTrustKey>;
  /** Tests pass `return` so a decline does not exit the test runner. */
  onDecline?: 'exit' | 'return';
  write?: (text: string) => void;
}): Promise<FolderTrustDecision> {
  const env = resolvedEnv(input.env);
  const folderKey = await resolveFolderKey(input.startDir);
  const zh = input.zh ?? isZhLocale();
  const write = input.write ?? ((text: string) => console.error(text));
  const granted =
    input.trustFlag || trustEnvEnabled(env) || isFolderTrusted(input.configDir, input.startDir);
  if (granted) return { trusted: true, folderKey, prompted: false, persisted: false };
  const canPrompt =
    input.interactive && (input.readKey !== undefined || process.stdin.isTTY === true);
  if (!canPrompt) return { trusted: false, folderKey, prompted: false, persisted: false };
  const home = sameFolder(folderKey, homeDir(env));
  const root = isFilesystemRoot(folderKey);
  const items = discoverFolderTrustItems({
    workspaceDir: folderKey,
    configDir: input.configDir,
    env,
  });
  write(folderTrustPrompt({ folderKey, home, root, zh, items }));
  const answer = await (input.readKey ?? readTrustKey)();
  if (answer !== 'yes') {
    write(chrome('[moss] This folder was not trusted. Exiting.', zh));
    if (input.onDecline === 'return') {
      return { trusted: false, folderKey, prompted: true, persisted: false };
    }
    process.exit(ExitCode.USER_ABORTED);
  }
  const remembered = root ? { persisted: false } : rememberFolderTrust(input.configDir, folderKey);
  return { trusted: true, folderKey, prompted: true, persisted: remembered.persisted };
}

/**
 * Folder trust replaces the per-item prompt. A stored `true` (including a
 * legacy workspace path) covers that folder and its subdirectories. A stored
 * `false` is not a decision. Declining is not remembered.
 */
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
  folderTrusted?: boolean;
}): Promise<{ trusted: boolean; skipped: TrustItem[] }> {
  void input.interactive;
  void input.ask;
  void input.zh;
  const env = resolvedEnv(input.env);
  const trusted =
    input.folderTrusted !== undefined
      ? input.folderTrusted
      : input.trustFlag ||
        trustEnvEnabled(env) ||
        isFolderTrusted(input.configDir, input.workspaceDir) ||
        (input.items.length === 0 && !input.headlessUntrusted);
  if (input.items.length === 0 && input.folderTrusted !== false) {
    return { trusted: true, skipped: [] };
  }
  if (trusted) return { trusted: true, skipped: [] };
  return { trusted: false, skipped: [...input.items] };
}

export interface ResolvedProjectCapabilities {
  hooks: HooksConfig | undefined;
  mcp: LoadMcpConfigOptions;
  notice?: string;
  /** Claude project files were accepted for this workspace. */
  claudeOptIn: boolean;
  trusted: boolean;
  /** Project code left unloaded because the folder is not trusted. */
  skipped: TrustItem[];
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
  /** Set by the startup prompt. `false` keeps project code off even when nothing is listed. */
  folderTrusted?: boolean;
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
  const folderAlreadyTrusted =
    input.folderTrusted === true ||
    (input.folderTrusted !== false &&
      (input.trustFlag ||
        trustEnvEnabled(env) ||
        isFolderTrusted(input.configDir, input.workspaceDir)));
  // Folder trust is the only grant. Claude project files load with it; there
  // is no second question and no second store.
  const claudePresent = claudeProjectConfigExists(input.workspaceDir);
  const claudeOptIn = folderAlreadyTrusted && claudePresent;
  const claudeHooks = claudePresent ? readClaudeProjectHooks(input.workspaceDir) : undefined;
  const mcpBrief = (file: string) =>
    describeMcpFile(file, {}).map((brief) => ({
      name: brief.name,
      transport: brief.transport,
    }));
  const projectMcp = userOwnedWorkspace
    ? []
    : mcpBrief(path.join(input.workspaceDir, '.moss', 'mcp.json'));
  const claudeMcp = claudePresent ? describeClaudeMcp(input.workspaceDir) : [];
  const items = listProjectTrustItems({
    workspaceDir: input.workspaceDir,
    projectHooks: gatedProjectHooks,
    claudeHooks,
    projectMcp,
    claudeMcp,
    statusCommand,
    includeClaudeAgents: claudePresent,
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
    ...(input.folderTrusted !== undefined ? { folderTrusted: input.folderTrusted } : {}),
  });
  // Project hooks run before Claude hooks; both run before the user file.
  // Hooks inherited from `~/.moss/config.json` stay with the user file.
  const projectLayer = decision.trusted
    ? mergeHooksConfig(claudeOptIn ? claudeHooks : undefined, gatedProjectHooks)
    : undefined;
  const hooks = mergeHooksConfig(mergeHooksConfig(userHooks, inheritedUserHooks), projectLayer);
  const extraFiles = claudeOptIn ? [claudeMcpPath(input.workspaceDir)] : [];
  const zh = input.zh ?? isZhLocale();
  const summary = summarizeTrustItems(decision.skipped, zh);
  // The user's own `~/.moss` is not project code, so it still loads.
  const projectServers = decision.trusted || userOwnedWorkspace;
  return {
    hooks,
    mcp: {
      projectServers,
      ...(extraFiles.length > 0 ? { extraFiles } : {}),
    },
    ...(summary && !decision.trusted ? { notice: untrustedWorkspaceLine(summary, zh) } : {}),
    claudeOptIn,
    trusted: decision.trusted,
    skipped: decision.skipped,
  };
}
