import fs from 'node:fs';
import path from 'node:path';
import type { MossAgent } from '../core/index.js';
import type { Tool } from '../core/tools/tool-types.js';
import {
  auditResolvedCliConfig,
  BASE_URL,
  resolveCliConfig,
  resolveConfigDir,
  resolveConfigPath,
  WORKSPACE,
  type ResolvedCliConfig,
} from './config.js';
import { formatInteractiveCommandSections } from './interactive-commands.js';
import { hookEntryWarnings } from './hooks-view.js';
import { resolveCliDetailMode, type CliDetailMode } from './output.js';
import { getPackageVersion } from './package-info.js';
import { compactPath, label, ui } from './ui.js';
import { configSnapshotLines, localizeConfigSource } from './config-snapshot.js';
import {
  ok as doctorOk,
  warn as doctorWarn,
  renderAuthDoctorLine,
  renderNodeDoctorLine,
} from './doctor.js';
import { isZhLocale } from './cli-locale.js';
import { PermissionRuleRegistry, unmatchedRuleToolNames } from './permission-rules.js';
import { workspaceWriteLimit } from './workspace-write-copy.js';
import { formatCliInteractionModeLabel, type CliInteractionMode } from './interaction-mode.js';

export interface CliRuntimeStatus {
  workspace?: string;
  runtimeDir?: string;
  configDir?: string;
  baseUrl?: string;
  execBackend?: string;
  safetyMode?: string;
  sessionKey?: string;
  config?: ResolvedCliConfig;
  /**
   * v0.26 (T03): live rule-table getter (user + workspace + session rules
   * merged). In-session commands (/permissions, T04) mutate the registry;
   * consumers read through this getter so changes apply to the next call.
   */
  permissionsRules?: () => import('./permission-rules.js').ResolvedPermissionRules;
  /**
   * v0.26 (T04 will wire /permissions add/remove): the session registry.
   * Present from T03 wiring on.
   */
  permissionRuleRegistry?: import('./permission-rules.js').PermissionRuleRegistry;
  /**
   * Live lifecycle hooks (user + project merged, after capability resolution).
   * `/hooks` reads this: `config` here is the resolved CLI config, which does not
   * carry the hooks table.
   */
  hooksConfig?: Record<string, readonly import('./hooks-view.js').HookViewEntry[]>;
  /**
   * Live MCP server statuses (connected / failed / connecting). `/mcp` reads
   * this: the resolved CLI config does not carry the mcp.json server map, and
   * the status only exists once the registry is built.
   */
  listMcpServers?: () => ReadonlyArray<{
    name: string;
    state: string;
    toolCount?: number;
    error?: string;
  }>;
  /**
   * Live MCP prompt templates (`/mcp prompts`) and expansion (`/mcp prompt`).
   * Claude Code surfaces server prompts as first-class slash commands; Moss
   * keeps them under one `/mcp` command so a server cannot grow the slash
   * namespace (and so the catalog stays explicit and reviewable).
   */
  mcpPrompts?:
    | {
        catalog: () => Promise<import('../core/mcp/registry.js').McpPromptCatalog>;
        expand: (
          server: string,
          name: string,
          args: Record<string, string>
        ) => Promise<{ text: string; messages: number }>;
      }
    | undefined;
  /**
   * D4 parity: read one MCP resource for a user `@server:uri` mention. Same
   * lifecycle rules as prompts (deferred starts, dropped reconnects once).
   */
  mcpResources?:
    | {
        read: (server: string, uri: string) => Promise<{ text: string; mimeType?: string }>;
      }
    | undefined;
}

interface ToolGroupSummary {
  id: string;
  title: string;
  enabled: boolean;
  tools: Tool[];
}

function loadDefaultRuntimeConfig(): ResolvedCliConfig {
  try {
    return resolveCliConfig();
  } catch {
    return resolveCliConfig(process.env, {}, {}, { configPath: resolveConfigPath() });
  }
}

/** Everything the welcome screen reads has a default; MCP prompts stay optional. */
type DefaultRuntimeStatus = Required<Omit<CliRuntimeStatus, 'mcpPrompts' | 'mcpResources'>> & {
  mcpPrompts: CliRuntimeStatus['mcpPrompts'];
  mcpResources: CliRuntimeStatus['mcpResources'];
};

function createDefaultRuntime(): DefaultRuntimeStatus {
  return {
    workspace: WORKSPACE,
    runtimeDir: path.join(WORKSPACE, '.moss'),
    configDir: resolveConfigDir(),
    baseUrl: BASE_URL,
    execBackend: process.env.MOSS_EXEC_BACKEND || 'local',
    safetyMode: process.env.MOSS_SAFETY_MODE || process.env.MOSS_CLI_SAFETY_MODE || 'full-access',
    sessionKey: 'cli',
    permissionsRules: () => ({ rules: [], sources: {} }),
    hooksConfig: {},
    listMcpServers: () => [],
    mcpPrompts: undefined,
    mcpResources: undefined,
    permissionRuleRegistry: new PermissionRuleRegistry(),
    config: loadDefaultRuntimeConfig(),
  };
}

function runtimeWithDefaults(runtime: CliRuntimeStatus = {}) {
  return { ...createDefaultRuntime(), ...runtime };
}

function countJsonIndex(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function countMarkdownFiles(dirPath: string): number {
  try {
    return fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function shortBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return value || '(not configured)';
  }
}

function describeDetail(mode: CliDetailMode): string {
  if (!isZhLocale()) {
    if (mode === 'quiet') return 'quiet';
    if (mode === 'verbose') return 'verbose';
    return 'progress';
  }
  if (mode === 'quiet') return '安静';
  if (mode === 'verbose') return '详细';
  return '进度';
}

interface ToolGroupDef {
  id: string;
  title: string;
  prefixes?: string[];
  names?: string[];
}

const TOOL_GROUPS: ToolGroupDef[] = [
  {
    id: 'workspace',
    title: 'Workspace',
    names: [
      'exec',
      'read_file',
      'write_file',
      'edit_file',
      'multi_edit',
      'move_file',
      'apply_patch',
      'list_directory',
      'search_files',
      'search_code',
      'run_tests',
      'todo_write',
      'ask_user_question',
    ],
  },
  { id: 'memory', title: 'Memory', prefixes: ['memory_'] },
  {
    id: 'agent',
    title: 'Sub-agents',
    names: [
      'tool_search',
      'create_subagent',
      'subagent_status',
      'subagent_stop',
      'fan_out_subagents',
      'merge_subagent_patch',
    ],
  },
  { id: 'web', title: 'Web', prefixes: ['web_'] },
  {
    id: 'background',
    title: 'Background',
    names: ['exec_background', 'exec_logs', 'exec_input', 'exec_stop'],
  },
  { id: 'other', title: 'Other' },
];

function classifyTool(tool: Tool): string {
  for (const group of TOOL_GROUPS) {
    if (group.names?.includes(tool.name)) return group.id;
  }
  for (const group of TOOL_GROUPS) {
    if (group.prefixes?.some((p) => tool.name.startsWith(p))) return group.id;
  }
  return 'other';
}

function groupTools(tools: Tool[]): ToolGroupSummary[] {
  const groups: ToolGroupSummary[] = TOOL_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    enabled: false,
    tools: [],
  }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const tool of tools) {
    const group = byId.get(classifyTool(tool)) ?? byId.get('other');
    if (!group) continue;
    group.tools.push(tool);
    group.enabled = true;
  }
  return groups;
}

/** Human "12m ago" for a ledger row; the welcome line must not print raw ms. */
export function formatAgo(timestamp: number, now = Date.now()): string {
  const ms = Math.max(0, now - timestamp);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function truncateOneLine(text: string, limit: number): string {
  const one = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length <= limit ? one : `${one.slice(0, limit - 1)}…`;
}

/**
 * B136: the first screen should answer "what happened last, what do I do now".
 * Reads the unified run ledger (`.moss/runs/<id>/run.json`) and AGENTS.md, so a
 * failed run surfaces its own resume command instead of a generic greeting.
 * Sync on purpose: it runs once at REPL startup over a few small files.
 */
/**
 * B144: the empty composer used to suggest the same prompt everywhere. When the
 * ledger says the newest run needs a human, suggest resuming it; on a fresh
 * workspace with no AGENTS.md, suggest `/init`. Returns a localized string (the
 * TUI composer passes already-rendered text through `tui()`'s default branch).
 */
export function welcomeComposerSuggestion(
  latest: { status: string; next?: string } | null,
  hasAgents: boolean,
  zh = isZhLocale()
): string | undefined {
  const t = (en: string, cn: string): string => (zh ? cn : en);
  if (latest && latest.status !== 'completed' && latest.next) {
    return t(`Resume with ${latest.next}`, `继续：${latest.next}`);
  }
  if (!latest && !hasAgents) {
    return t(
      'Try "/init" (detect this project, write AGENTS.md)',
      '试试 “/init”（检测项目、写 AGENTS.md）'
    );
  }
  return undefined;
}

/**
 * Which surface reads this hint. Interactive surfaces can type slash commands,
 * so `Next:` names `/init`, `/runs` and `/run resume …` instead of shell
 * commands the user would have to leave the session to run (B154).
 */
export type WelcomeSurface = 'cli' | 'interactive';

export function renderWelcomeContextLines(
  workspace: string,
  zh = isZhLocale(),
  surface: WelcomeSurface = 'cli'
): { lines: string[]; next: string; suggestion?: string } {
  const t = (en: string, cn: string): string => (zh ? cn : en);
  const runsDir = path.join(workspace, '.moss', 'runs');
  let latest: {
    runId: string;
    kind: string;
    status: string;
    goal: string;
    endedAt: number;
    next?: string;
    taskId?: string;
  } | null = null;
  try {
    const entries = fs.readdirSync(runsDir, { withFileTypes: true });
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(runsDir, entry.name, 'run.json'), 'utf8')
        ) as Record<string, unknown>;
        if (typeof raw.status !== 'string' || typeof raw.endedAt !== 'number') continue;
        if (!latest || raw.endedAt > latest.endedAt) {
          latest = {
            runId: typeof raw.runId === 'string' ? raw.runId : entry.name,
            kind: typeof raw.kind === 'string' ? raw.kind : 'run',
            status: raw.status,
            goal: typeof raw.goal === 'string' ? raw.goal : '',
            endedAt: raw.endedAt,
            ...(typeof raw.next === 'string' ? { next: raw.next } : {}),
            ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
          };
        }
      } catch {
        /* a partial record must not break the welcome screen */
      }
    }
  } catch {
    latest = null;
  }

  const hasAgents = fs.existsSync(path.join(workspace, 'AGENTS.md'));
  const lines: string[] = [];
  if (latest) {
    lines.push(
      `${label(t('last run', '上次运行'))} ${latest.status} · ${formatAgo(latest.endedAt)} · ${latest.kind} ${latest.runId} — ${truncateOneLine(latest.goal, 60)}`
    );
  }
  // The welcome line already prefixes `Next:`, so this is the command only.
  const interactive = surface === 'interactive';
  const allRuns = t('(all recent runs)', '（最近所有运行）');
  const initNote = t('(detect this project, write AGENTS.md)', '（检测项目、写 AGENTS.md）');
  let next: string;
  if (latest && latest.status !== 'completed' && latest.next) {
    const resume = /^moss task resume (\S+)$/.exec(latest.next);
    next = interactive && resume ? `/run resume ${resume[1]}` : latest.next;
  } else if (latest) {
    next = interactive ? `/runs    ${allRuns}` : `moss runs    ${allRuns}`;
  } else if (!hasAgents) {
    next = interactive ? `/init    ${initNote}` : `moss init    ${initNote}`;
  } else {
    next = interactive
      ? '/run "<intent>" --accept "<cmd>"'
      : 'moss run "<intent>" --accept "<cmd>"';
  }
  const suggestion = welcomeComposerSuggestion(
    latest ? { status: latest.status, ...(latest.next ? { next: latest.next } : {}) } : null,
    hasAgents,
    zh
  );
  return { lines, next, ...(suggestion ? { suggestion } : {}) };
}

/**
 * B151: `Next: <command>` for after a run settles. The REPL prints the same
 * ledger-derived hint at boot; a finished autonomous run changes the ledger, so
 * the primary non-TUI surface repeats it instead of leaving stale guidance.
 */
export function renderNextHint(
  workspace: string,
  zh = isZhLocale(),
  surface: WelcomeSurface = 'interactive'
): string {
  const { next } = renderWelcomeContextLines(workspace, zh, surface);
  return `${ui.dim(zh ? '下一步' : 'Next')} ${next}`;
}

export function renderCliWelcome(
  agent: MossAgent,
  runtime: CliRuntimeStatus = {},
  surface: WelcomeSurface = 'cli'
): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const zh = isZhLocale();
  const providerState = auth.usingBundledDefault
    ? zh
      ? '内置模型网关'
      : 'built-in model gateway'
    : auth.provider;
  const authState = auth.usingBundledDefault
    ? zh
      ? '内置模型，无需模型 key'
      : 'built-in model, no model key needed'
    : auth.apiKey
      ? zh
        ? '已配置自有服务商'
        : 'own provider configured'
      : zh
        ? '缺少模型 key'
        : 'model key missing';

  const workspace = rt.workspace || process.cwd();
  const welcomeContext = renderWelcomeContextLines(workspace, zh, surface);
  const contextLines = welcomeContext.lines;
  const nextLine = welcomeContext.next;
  return [
    `${ui.bold('Moss Agent')} ${ui.dim(`v${getPackageVersion()}`)}`,
    `${label(zh ? '模型' : 'model')} ${agent.config.model} (${providerState})`,
    `${label(zh ? '工作区' : 'workspace')} ${compactPath(rt.workspace)}`,
    `${label(zh ? '模型密钥' : 'model key')} ${authState}`,
    ...contextLines,
    `${ui.dim(zh ? '下一步' : 'Next')} ${nextLine}`,
    ui.dim(workspaceWriteLimit(zh, rt.config.permissions?.osSandbox === true)),
  ].join('\n');
}

export function renderCliStatus(
  agent: MossAgent,
  runtime: CliRuntimeStatus = {},
  options: { verbose?: boolean } = {}
): string {
  const rt = runtimeWithDefaults(runtime);
  const memoryCount = countJsonIndex(path.join(rt.runtimeDir, 'memory', 'index.json'));
  const skillCount = countMarkdownFiles(path.join(rt.workspace, '.moss', 'skills'));
  const sessionDir = path.join(rt.runtimeDir, 'sessions');
  const detailMode = resolveCliDetailMode();
  const toolGroups = groupTools(agent.tools.getAll()).filter((g) => g.enabled);
  const auth = rt.config;
  if (!options.verbose) {
    // The human view: what am I running, where, and will it ask me first.
    // Diagnostics (api key, memory/skills counts, sources) live in --verbose.
    const zh = isZhLocale();
    return [
      ui.bold(ui.black(zh ? '状态' : 'Status')),
      `  ${label(zh ? '模型' : 'model')} ${agent.config.model} (${auth.usingBundledDefault ? (zh ? '内置' : 'built-in') : auth.provider})`,
      `  ${label(zh ? '工作区' : 'workspace')} ${rt.workspace}`,
      `  ${label(zh ? '变更' : 'changes')} ${
        auth.approvalPolicy === 'never'
          ? zh
            ? '直接执行，不再询问'
            : 'runs without asking'
          : zh
            ? '会先询问'
            : 'asks you first'
      }`,
      `  ${label(zh ? '工具' : 'tools')} ${agent.tools.size} ${zh ? '个可用' : 'available'}`,
      '',
      zh
        ? '  更多：/status --verbose · 切换模型：/model'
        : '  More: /status --verbose · switch model: /model',
    ].join('\n');
  }

  const zh = isZhLocale();
  const groupTitle = (title: string): string => {
    if (!zh) return title;
    const names: Record<string, string> = {
      Workspace: '工作区',
      Memory: '记忆',
      'Sub-agents': '子代理',
      Web: 'Web',
      Development: '开发',
      Background: '后台',
      Other: '其他',
    };
    return names[title] ?? title;
  };
  return [
    ui.bold(zh ? '状态' : 'Status'),
    `  ${label(zh ? '会话' : 'session')} ${rt.sessionKey}`,
    `  ${label(zh ? '模型' : 'model')} ${agent.config.model}`,
    ...configSnapshotLines(auth, ['provider', 'baseUrl', 'profile', 'apiKey']),
    `  ${label(zh ? '工作区' : 'workspace')} ${rt.workspace}`,
    `  ${label(zh ? '配置' : 'config')} ${rt.configDir}`,
    `  ${label(zh ? '会话目录' : 'sessions')} ${sessionDir}`,
    `  ${label(zh ? '详细程度' : 'detail')} ${describeDetail(detailMode)}`,
    ...configSnapshotLines(auth, [
      'permissions',
      'safetyMode',
      'approvalPolicy',
      'trustedTools',
      'deniedTools',
      'promptCache',
      'promptCacheDebug',
      'guardrails',
      'maxTurns',
      'contextTokens',
      'reasoningBudget',
      'maxOutput',
      'compaction',
    ]),
    `  ${label(zh ? '执行' : 'exec')} ${rt.execBackend}`,
    `  ${label(zh ? '记忆' : 'memory')} ${memoryCount} ${zh ? '条' : 'entries'}`,
    `  ${label(zh ? '技能' : 'skills')} ${skillCount}`,
    `  ${label(zh ? '工具' : 'tools')} ${agent.tools.size}${zh ? '（' : ' ('}${toolGroups.map((g) => groupTitle(g.title)).join(zh ? '、' : ', ')}${zh ? '）' : ')'}`,
  ].join('\n');
}

export function renderCliSessionDoctor(agent: MossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const zh = isZhLocale();
  const lines: string[] = [
    ui.bold(ui.black(zh ? '诊断' : 'Doctor')),
    renderNodeDoctorLine(),
    doctorOk(zh ? '版本' : 'version', getPackageVersion()),
  ];

  if (auth.usingBundledDefault) {
    lines.push(
      doctorOk(
        zh ? '模型' : 'model',
        zh
          ? `${agent.config.model}（内置模型网关）`
          : `${agent.config.model} (built-in model gateway)`
      )
    );
  } else {
    lines.push(
      doctorOk(
        zh ? '模型' : 'model',
        zh
          ? `${agent.config.model}（${localizeConfigSource(auth.providerSource)}）`
          : `${agent.config.model} (${auth.providerSource})`
      )
    );
    lines.push(
      doctorOk(
        zh ? '服务商' : 'provider',
        zh
          ? `${auth.provider}（${localizeConfigSource(auth.providerSource)}）`
          : `${auth.provider} (${auth.providerSource})`
      )
    );
  }
  lines.push(renderAuthDoctorLine(auth));

  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (auth.usingBundledDefault) {
    lines.push(
      doctorOk(
        zh ? '出口' : 'egress',
        proxy
          ? zh
            ? `内置网关经代理 ${shortBaseUrl(proxy)}`
            : `built-in gateway via proxy ${shortBaseUrl(proxy)}`
          : zh
            ? '内置网关（直连）'
            : 'built-in gateway (direct)'
      )
    );
  } else {
    lines.push(
      doctorOk(
        zh ? '出口' : 'egress',
        proxy
          ? zh
            ? `${shortBaseUrl(auth.baseUrl)} 经代理 ${shortBaseUrl(proxy)}`
            : `${shortBaseUrl(auth.baseUrl)} via proxy ${shortBaseUrl(proxy)}`
          : zh
            ? `${shortBaseUrl(auth.baseUrl)}（直连，无代理）`
            : `${shortBaseUrl(auth.baseUrl)} (direct, no proxy)`
      )
    );
  }

  const warnings = auditResolvedCliConfig(auth);
  if (warnings.length === 0) {
    lines.push(doctorOk(zh ? '配置' : 'config', zh ? '没有警告' : 'no warnings'));
  } else {
    for (const w of warnings) lines.push(doctorWarn(w.code, w.message));
  }

  // Behavior switches the summary would otherwise hide (B56 parity): what the
  // endpoint may receive, whether review runs, whether the L1 gate blocks.
  lines.push(
    doctorOk(
      zh ? '图片输入' : 'images',
      auth.supportsImages === false
        ? zh
          ? `仅文本（agent.supportsImages=false，${localizeConfigSource(auth.supportsImagesSource ?? 'default')}）`
          : `text-only (agent.supportsImages=false, ${auth.supportsImagesSource ?? 'default'})`
        : zh
          ? `允许图片输入（${localizeConfigSource(auth.supportsImagesSource ?? 'default')}）`
          : `image input allowed (${auth.supportsImagesSource ?? 'default'})`
    ),
    doctorOk(
      zh ? '评审模式' : 'review mode',
      auth.reviewMode
        ? zh
          ? `${auth.reviewMode}（配置或环境变量）`
          : `${auth.reviewMode} (config or env)`
        : zh
          ? `${auth.reviewMode ?? 'manual'}（默认）`
          : `${auth.reviewMode ?? 'manual'} (default)`
    ),
    doctorOk(
      zh ? '验证门' : 'verification gate',
      auth.verificationGate === false
        ? zh
          ? `关闭（${localizeConfigSource(auth.verificationGateSource ?? 'default')}）`
          : `off (${auth.verificationGateSource ?? 'default'})`
        : zh
          ? `开启（${localizeConfigSource(auth.verificationGateSource ?? 'default')}）`
          : `on (${auth.verificationGateSource ?? 'default'})`
    )
  );

  // MCP and hooks are config surfaces with their own failure modes; /doctor is
  // where a user looks when "something is off", so report live status here
  // instead of making them type /mcp and /hooks one at a time.
  const mcpServers = rt.listMcpServers?.() ?? [];
  if (mcpServers.length > 0) {
    const failed = mcpServers.filter((server) => server.state === 'failed');
    const connected = mcpServers.filter((server) => server.state === 'connected');
    const count = zh
      ? `${connected.length}/${mcpServers.length} 已连接`
      : `${connected.length}/${mcpServers.length} connected`;
    if (failed.length === 0) {
      lines.push(doctorOk(zh ? 'MCP' : 'MCP', count));
    } else {
      lines.push(
        doctorWarn(
          'MCP',
          zh
            ? `${count}；失败：${failed.map((server) => server.name).join(', ')} — 用 /mcp 重试，检查 mcp.json 里的命令`
            : `${count}; failed: ${failed.map((server) => server.name).join(', ')} — see /mcp to retry, check the command in mcp.json`
        )
      );
    }
  }
  const hooksConfig = rt.hooksConfig;
  const hookEntries = Object.entries(hooksConfig ?? {});
  if (hookEntries.length > 0) {
    const total = hookEntries.reduce((sum, [, entries]) => sum + (entries?.length ?? 0), 0);
    const knownToolNames = agent.tools.getAll().map((tool) => tool.name);
    lines.push(
      doctorOk(
        zh ? 'hooks' : 'hooks',
        zh
          ? `${total} 条，${hookEntries.length} 个事件`
          : `${total} hook${total === 1 ? '' : 's'} on ${hookEntries.length} event${hookEntries.length === 1 ? '' : 's'}`
      )
    );
    for (const [event, entries] of hookEntries) {
      for (const hook of entries ?? []) {
        for (const warning of hookEntryWarnings(event, hook, { zh, knownToolNames })) {
          lines.push(doctorWarn(zh ? 'hooks' : 'hooks', warning));
        }
      }
    }
  }

  if ((auth.ignoredModelEnvVars ?? []).length > 0) {
    lines.push(
      doctorWarn(
        zh ? '已忽略的环境变量' : 'env ignored',
        zh
          ? `${auth.ignoredModelEnvVars.join(', ')} — 模型设置只来自 moss 配置`
          : `${auth.ignoredModelEnvVars.join(', ')} — model settings come only from moss config`
      )
    );
  }

  const sessionLog = path.join(rt.runtimeDir, 'sessions', `${rt.sessionKey}.jsonl`);
  const eventLog = path.join(rt.runtimeDir, 'events', `${encodeURIComponent(rt.sessionKey)}.jsonl`);
  lines.push(
    '',
    zh ? `  会话日志：${sessionLog} · ${eventLog}` : `  Session logs: ${sessionLog} · ${eventLog}`,
    zh
      ? '  完整报告：`moss doctor`（另外探测可写路径和搜索后端）'
      : '  Full report: `moss doctor` (adds writable-path and search-backend probes)'
  );
  return lines.join('\n');
}

function permissionsHelpText(): string {
  if (isZhLocale()) {
    return [
      '',
      '  模式只有一根轴 — /mode（TUI 里 Shift+Tab 在四种状态间循环，v0.26）：',
      '    /mode manual        逐项确认变更',
      '    /mode accept-edits  自动通过本文件夹内的文件编辑；终端命令仍需确认（-p 下会被拦下）',
      '    /mode plan          只读规划（变更会被拦住）',
      '    /mode full          不再询问（默认）— deny 规则仍然生效',
      '',
      '  规则管模式管不到的部分（ToolName 或 ToolName(pattern)）：',
      '    /permissions add deny "read_file(./.env)"     本会话拒绝',
      '    /permissions add allow "exec(npm run *)"      本会话放行',
      '    /permissions add deny "web_fetch(domain:example.com)"  按域名拦截',
      '    /permissions add ask "exec(rm *)"             执行 rm 前总是询问',
      '    /permissions persist deny "read_file(./.env)" 写入用户配置',
      '    /permissions remove "read_file(./.env)"       去掉一条会话规则',
      '  任何模式（包括 full）里 deny 都优先；allow 跳过询问；',
      '  ask 强制询问。规则在下一次工具调用时生效。',
      '',
      '  查看或保存每一项：`moss config --help`（可设置的键）。',
    ].join('\n');
  }
  return [
    '',
    '  One mode axis — /mode (Shift+Tab in the TUI cycles four states, v0.26):',
    '    /mode manual        approve mutations one by one',
    '    /mode accept-edits  auto-approve file edits in this folder; shell commands still ask (blocked in -p)',
    '    /mode plan          read-only planning (mutations blocked)',
    '    /mode full          skip prompts (default) — deny rules still apply',
    '',
    '  Rules manage what the mode cannot (ToolName or ToolName(pattern)):',
    '    /permissions add deny "read_file(./.env)"     session-level deny',
    '    /permissions add allow "exec(npm run *)"      session-level allow',
    '    /permissions add deny "web_fetch(domain:example.com)"  block a domain',
    '    /permissions add ask "exec(rm *)"             always ask before rm',
    '    /permissions persist deny "read_file(./.env)" write to user config',
    '    /permissions remove "read_file(./.env)"       drop a session rule',
    '  deny wins in ANY mode (full included); allow skips the prompt;',
    '  ask forces the prompt. Rules take effect on the next tool call.',
    '',
    '  Persist or inspect every knob: `moss config --help` (settable keys).',
  ].join('\n');
}

/**
 * One line per permission rule, with its source level spelled out (user /
 * workspace / session — v0.26 T04: the rule manager makes sources visible).
 */
export function permissionRuleLines(
  rules: readonly {
    level: string;
    toolName: string;
    operandPattern?: string;
    source: string;
    workspaceFileOnly?: boolean;
  }[],
  sources: { userPath?: string; workspacePath?: string }
): string[] {
  const zh = isZhLocale();
  const describeSource = (source: string): string => {
    if (source === 'user') {
      const shown = compactPath(sources.userPath ?? '~/.config/moss/config.json');
      return zh ? `用户（${shown}）` : `user (${shown})`;
    }
    if (source === 'workspace') {
      const shown = compactPath(sources.workspacePath ?? '.moss/config.json');
      return zh ? `工作区（${shown}）` : `workspace (${shown})`;
    }
    return zh ? '会话（仅本会话）' : 'session (this session only)';
  };
  return rules.map((rule) => {
    const spec = rule.operandPattern ? `${rule.toolName}(${rule.operandPattern})` : rule.toolName;
    const scope = rule.workspaceFileOnly
      ? zh
        ? '，仅工作区文件编辑'
        : ', workspace file edits only'
      : '';
    return `    ${rule.level.padEnd(5)} ${spec}  —  ${describeSource(rule.source)}${scope}`;
  });
}

/**
 * Rules whose tool name is not registered any more (typo, renamed tool, MCP
 * server not connected) parse fine and then match nothing. A deny rule in that
 * state protects nothing, so the view names it instead of showing a healthy
 * count. Patterns with glob syntax are skipped: they cannot be checked exactly.
 */
function unmatchedRuleToolLines(
  rules: readonly import('./permission-rules.js').PermissionRule[],
  knownToolNames: readonly string[],
  zh: boolean
): string[] {
  return unmatchedRuleToolNames(rules, knownToolNames).map((tool) =>
    zh
      ? `  ⚠ 规则 ${tool} 没有匹配的已注册工具——检查拼写；这条规则永远不会生效`
      : `  ⚠ rule ${tool} matches no registered tool — check the spelling; it never applies`
  );
}

export function renderCliPermissions(
  runtime: CliRuntimeStatus = {},
  options: {
    verbose?: boolean;
    locale?: string;
    currentMode?: CliInteractionMode;
    /** Registered tool names, so a rule naming a typo'd tool can be flagged. */
    knownToolNames?: readonly string[];
  } = {}
): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const permissions = auth.permissions;
  const zh = isZhLocale(options.locale);
  const currentModeLine = options.currentMode
    ? `  ${label(zh ? '当前模式' : 'current mode')} ${formatCliInteractionModeLabel(options.currentMode, zh)}`
    : undefined;
  const modeLabel =
    permissions?.defaultMode === 'manual'
      ? 'manual'
      : permissions?.defaultMode === 'acceptEdits'
        ? 'accept-edits'
        : permissions?.defaultMode === 'plan'
          ? 'plan'
          : 'full';
  const ceiling = permissions?.readOnlyCeiling === true;
  // The live rule table (session layer included when the runtime carries the
  // T03 getter; the config view covers the startup rules).
  const liveRules = rt.permissionsRules?.().rules ?? [];
  const sources = rt.permissionsRules?.().sources ?? {};
  const unmatchedRuleLines =
    options.knownToolNames && options.knownToolNames.length > 0
      ? unmatchedRuleToolLines(liveRules, options.knownToolNames, zh)
      : [];
  const allowCount = liveRules.filter((r) => r.level === 'allow').length;
  const askCount = liveRules.filter((r) => r.level === 'ask').length;
  const denyCount = liveRules.filter((r) => r.level === 'deny').length;

  if (options.verbose) {
    return [
      ui.bold(ui.black(zh ? '权限与配置' : 'Permissions & Config')),
      ...configSnapshotLines(auth, ['configPath', 'profile']),
      `  ${label(zh ? '工作区' : 'workspace')} ${auth.workspace} (${auth.workspaceSource})`,
      ...(currentModeLine ? [currentModeLine] : []),
      `  ${label(zh ? '默认模式' : 'default mode')} ${modeLabel}${ceiling ? (zh ? ' + 只读上限' : ' + read-only ceiling') : ''} (${permissions?.source ?? 'default'})`,
      `  ${workspaceWriteLimit(zh, permissions?.osSandbox === true)}`,
      `  ${label(zh ? '规则' : 'rules')} allow ${allowCount} · ask ${askCount} · deny ${denyCount}`,
      ...(liveRules.length > 0
        ? [zh ? '  规则表：' : '  Rule table:']
        : [
            `    ${zh ? '无规则（默认 full 模式下可用 /permissions 添加 deny 规则）' : 'none (add deny rules with /permissions in the default full mode)'}`,
          ]),
      ...permissionRuleLines(liveRules, sources),
      ...unmatchedRuleLines,
      ...(permissions && permissions.legacyKeysUsed.length > 0
        ? [
            `  ${label(zh ? '旧键迁移' : 'legacy keys')} ${permissions.legacyKeysUsed.join(', ')} ${zh ? '（已按迁移表翻译，建议改用 permissions.* 新键）' : '(migrated on read — prefer the permissions.* keys)'}`,
          ]
        : []),
      ...(currentModeLine
        ? [
            zh
              ? '  启动时配置（会话模式可能已改变）：'
              : '  Startup configuration (the session mode may have changed):',
          ]
        : []),
      ...configSnapshotLines(auth, [
        'safetyMode',
        'approvalPolicy',
        'trustedTools',
        'deniedTools',
        'promptCache',
        'promptCacheDebug',
        'guardrails',
        'maxTurns',
        'contextTokens',
        'reasoningBudget',
        'maxOutput',
        'compaction',
        'warnings',
      ]),
      permissionsHelpText(),
    ].join('\n');
  }
  return [
    ui.bold(ui.black(zh ? '权限' : 'Permissions')),
    ...(currentModeLine ? [currentModeLine] : []),
    `  ${label(zh ? '默认模式' : 'default mode')} ${modeLabel}${ceiling ? ' (read-only ceiling)' : ''}`,
    `  ${workspaceWriteLimit(zh, permissions?.osSandbox === true)}`,
    `  ${label(zh ? '工作区' : 'workspace')} ${auth.workspace}`,
    `  ${label(zh ? '规则' : 'rules')} ${
      allowCount + askCount + denyCount === 0
        ? zh
          ? '无'
          : 'none'
        : `allow ${allowCount} · ask ${askCount} · deny ${denyCount}`
    }`,
    ...(liveRules.length > 0 ? permissionRuleLines(liveRules, sources) : []),
    ...unmatchedRuleLines,
    '',
    zh
      ? '  增删规则：/permissions add|remove|persist（下一次工具调用即生效）'
      : '  Manage: /permissions add|remove|persist (takes effect on the next call)',
    zh
      ? '  全部配置与来源：/permissions --verbose · 模式切换：/mode'
      : '  Full table & sources: /permissions --verbose · mode: /mode',
  ].join('\n');
}

export function renderCliInteractiveHelp(): string {
  return [
    ui.bold(ui.black('Commands')),
    ...formatInteractiveCommandSections({ indent: '    ', commandWidth: 24 }),
    '',
    '  Shortcuts',
    '    Ctrl+C                   exit',
  ].join('\n');
}
