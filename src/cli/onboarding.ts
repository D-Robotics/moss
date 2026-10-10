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
import { resolveCliDetailMode, type CliDetailMode } from './output.js';
import { getPackageVersion } from './package-info.js';
import { compactPath, label, ui } from './ui.js';
import { configSnapshotLines } from './config-snapshot.js';
import {
  ok as doctorOk,
  warn as doctorWarn,
  renderAuthDoctorLine,
  renderNodeDoctorLine,
} from './doctor.js';
import { isZhLocale } from './cli-locale.js';
import { PermissionRuleRegistry } from './permission-rules.js';
import { workspaceWriteLimit } from './workspace-write-copy.js';

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

function createDefaultRuntime(): Required<CliRuntimeStatus> {
  return {
    workspace: WORKSPACE,
    runtimeDir: path.join(WORKSPACE, '.moss'),
    configDir: resolveConfigDir(),
    baseUrl: BASE_URL,
    execBackend: process.env.MOSS_EXEC_BACKEND || 'local',
    safetyMode: process.env.MOSS_SAFETY_MODE || process.env.MOSS_CLI_SAFETY_MODE || 'full-access',
    sessionKey: 'cli',
    permissionsRules: () => ({ rules: [], sources: {} }),
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
  if (mode === 'quiet') return 'quiet';
  if (mode === 'verbose') return 'verbose';
  return 'progress';
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
      'verify_fix',
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
  { id: 'dev', title: 'Development', names: ['code_diagnostics'] },
  { id: 'background', title: 'Background', names: ['exec_background', 'exec_logs', 'exec_stop'] },
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

export function renderCliWelcome(agent: MossAgent, runtime: CliRuntimeStatus = {}): string {
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

  return [
    `${ui.bold('Moss Agent')} ${ui.dim(`v${getPackageVersion()}`)}`,
    `${label(zh ? '模型' : 'model')} ${agent.config.model} (${providerState})`,
    `${label(zh ? '工作区' : 'workspace')} ${compactPath(rt.workspace)}`,
    `${label(zh ? '模型密钥' : 'model key')} ${authState}`,
    zh
      ? `${ui.dim('下一步')} 让我看看这个目录里有什么。`
      : `${ui.dim('Next')} ask me to look around this folder.`,
    ui.dim(workspaceWriteLimit(zh)),
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
      'maxOutput',
      'compaction',
    ]),
    `  ${label(zh ? '执行' : 'exec')} ${rt.execBackend}`,
    `  ${label(zh ? '记忆' : 'memory')} ${memoryCount} ${zh ? '条' : 'entries'}`,
    `  ${label(zh ? '技能' : 'skills')} ${skillCount}`,
    `  ${label(zh ? '工具' : 'tools')} ${agent.tools.size} (${toolGroups.map((g) => groupTitle(g.title)).join(', ')})`,
  ].join('\n');
}

export function renderCliSessionDoctor(agent: MossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const zh = isZhLocale();
  const lines: string[] = [ui.bold(ui.black(zh ? '诊断' : 'Doctor')), renderNodeDoctorLine()];

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
    lines.push(doctorOk(zh ? '模型' : 'model', `${agent.config.model} (${auth.providerSource})`));
    lines.push(doctorOk(zh ? '服务商' : 'provider', `${auth.provider} (${auth.providerSource})`));
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
      '  模式只有一根轴 — /mode（Shift+Tab 在四种状态间循环，v0.26）：',
      '    /mode manual        逐项确认变更',
      '    /mode accept-edits  自动接受工作区文件工具的编辑',
      '    /mode plan          只读规划（变更会被拦住）',
      '    /mode full          不再询问（默认）— deny 规则仍然生效',
      '',
      '  规则管模式管不到的部分（ToolName 或 ToolName(pattern)）：',
      '    /permissions add deny "read_file(./.env)"     本会话拒绝',
      '    /permissions add allow "exec(npm run *)"      本会话放行',
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
    '  One mode axis — /mode (Shift+Tab cycles four states, v0.26):',
    '    /mode manual        approve mutations one by one',
    '    /mode accept-edits  auto-approve workspace file-tool edits',
    '    /mode plan          read-only planning (mutations blocked)',
    '    /mode full          skip prompts (default) — deny rules still apply',
    '',
    '  Rules manage what the mode cannot (ToolName or ToolName(pattern)):',
    '    /permissions add deny "read_file(./.env)"     session-level deny',
    '    /permissions add allow "exec(npm run *)"      session-level allow',
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
  rules: readonly { level: string; toolName: string; operandPattern?: string; source: string }[],
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
    return `    ${rule.level.padEnd(5)} ${spec}  —  ${describeSource(rule.source)}`;
  });
}

export function renderCliPermissions(
  runtime: CliRuntimeStatus = {},
  options: { verbose?: boolean; locale?: string } = {}
): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const permissions = auth.permissions;
  const zh = isZhLocale(options.locale);
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
  const allowCount = liveRules.filter((r) => r.level === 'allow').length;
  const askCount = liveRules.filter((r) => r.level === 'ask').length;
  const denyCount = liveRules.filter((r) => r.level === 'deny').length;

  if (options.verbose) {
    return [
      ui.bold(ui.black(zh ? '权限与配置' : 'Permissions & Config')),
      ...configSnapshotLines(auth, ['configPath', 'profile']),
      `  ${label(zh ? '工作区' : 'workspace')} ${auth.workspace} (${auth.workspaceSource})`,
      `  ${label(zh ? '默认模式' : 'default mode')} ${modeLabel}${ceiling ? (zh ? ' + 只读上限' : ' + read-only ceiling') : ''} (${permissions?.source ?? 'default'})`,
      `  ${workspaceWriteLimit(zh)}`,
      `  ${label(zh ? '规则' : 'rules')} allow ${allowCount} · ask ${askCount} · deny ${denyCount}`,
      ...(liveRules.length > 0
        ? [zh ? '  规则表：' : '  Rule table:']
        : [
            `    ${zh ? '无规则（默认 full 模式下可用 /permissions 添加 deny 规则）' : 'none (add deny rules with /permissions in the default full mode)'}`,
          ]),
      ...permissionRuleLines(liveRules, sources),
      ...(permissions && permissions.legacyKeysUsed.length > 0
        ? [
            `  ${label(zh ? '旧键迁移' : 'legacy keys')} ${permissions.legacyKeysUsed.join(', ')} ${zh ? '（已按迁移表翻译，建议改用 permissions.* 新键）' : '(migrated on read — prefer the permissions.* keys)'}`,
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
        'maxOutput',
        'compaction',
        'warnings',
      ]),
      permissionsHelpText(),
    ].join('\n');
  }
  return [
    ui.bold(ui.black(zh ? '权限' : 'Permissions')),
    `  ${label(zh ? '默认模式' : 'default mode')} ${modeLabel}${ceiling ? ' (read-only ceiling)' : ''}`,
    `  ${workspaceWriteLimit(zh)}`,
    `  ${label(zh ? '工作区' : 'workspace')} ${auth.workspace}`,
    `  ${label(zh ? '规则' : 'rules')} ${
      allowCount + askCount + denyCount === 0
        ? zh
          ? '无'
          : 'none'
        : `allow ${allowCount} · ask ${askCount} · deny ${denyCount}`
    }`,
    ...(liveRules.length > 0 ? permissionRuleLines(liveRules, sources) : []),
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
