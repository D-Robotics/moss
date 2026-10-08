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
  fail as doctorFail,
  renderNodeDoctorLine,
} from './doctor.js';
import { isZhLocale } from './cli-locale.js';
import { PermissionRuleRegistry } from './permission-rules.js';

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
      ? `${ui.dim('下一步')} /status 查看配置、/model 切换模型，或 moss setup 配置自有服务商 API key`
      : `${ui.dim('next')} /status for the setup, /model to switch, or moss setup for your own provider key`,
  ].join('\n');
}

export function renderCliQuickStart(agent: MossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const toolNames = new Set(agent.tools.getNames());
  const apiKeyState = auth.usingBundledDefault
    ? 'built-in model (no model key required)'
    : auth.apiKey
      ? `configured via ${auth.apiKeySource}`
      : 'missing';
  const examples = [
    'Analyze this project structure and point out the key entry files and next steps',
    toolNames.has('exec')
      ? 'Check which scripts package.json defines, then suggest one command to verify the project'
      : null,
    toolNames.has('search_code')
      ? 'Find where the CLI parses arguments and summarize the flow in a few lines'
      : null,
    toolNames.has('run_tests')
      ? 'Run the test suite, then summarize the failures with the smallest next fix'
      : null,
  ].filter(Boolean) as string[];

  return [
    ui.bold(ui.black('Quick start')),
    '',
    `  ${label('1/3 Model')} ${agent.config.model} · provider ${auth.usingBundledDefault ? 'built-in model gateway' : auth.provider} · api key ${apiKeyState}`,
    auth.usingBundledDefault
      ? '      Built-in model gateway is ready without a model API key. Optional: `moss setup` uses your own provider.'
      : auth.apiKey
        ? '      Change it anytime: run `moss setup` (interactive), or `/model` to choose a model for this session.'
        : '      Configure it: run `moss setup` — choose a provider, choose a model, and paste your API key.',
    '      Model settings live in moss config only — env vars (DEEPSEEK_API_KEY, MOSS_PROVIDER, ...) are ignored.',
    `      Settings are saved to ${compactPath(auth.configPath)} — inspect them with /permissions.`,
    '',
    `  ${label('2/3 Workspace')} ${compactPath(rt.workspace)} · safety ${rt.safetyMode}`,
    '      The workspace is the folder you launch Moss in — cd into your project first, then run `moss`.',
    '      Set it without moving: `moss config set workspace /path/to/project`. See the full picture with /status.',
    '      Control what Moss may change: `moss config set safetyMode read-only|workspace-write|full-access` (or /permissions).',
    '',
    `  ${label('3/3 Try')} ask for an outcome in plain language — Moss chooses the tools automatically:`,
    ...examples.slice(0, 4).map((example) => `      - ${example}`),
    '',
    `  ${label('Customize')} drop an AGENTS.md in your workspace (or run /init) — it is auto-loaded into every session as your project's system prompt (build/test commands, layout, conventions).`,
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
    return [
      ui.bold(ui.black('Status')),
      `  ${label('model')} ${agent.config.model} (${auth.usingBundledDefault ? 'built-in' : auth.provider})`,
      `  ${label('workspace')} ${rt.workspace}`,
      `  ${label('changes')} ${auth.approvalPolicy === 'never' ? 'runs without asking' : 'asks you first'}`,
      `  ${label('tools')} ${agent.tools.size} available`,
      '',
      '  More: /status --verbose · switch model: /model',
    ].join('\n');
  }

  return [
    ui.bold('Status'),
    `  ${label('session')} ${rt.sessionKey}`,
    `  ${label('model')} ${agent.config.model}`,
    ...configSnapshotLines(auth, ['provider', 'baseUrl', 'profile', 'apiKey']),
    `  ${label('workspace')} ${rt.workspace}`,
    `  ${label('config')} ${rt.configDir}`,
    `  ${label('sessions')} ${sessionDir}`,
    `  ${label('detail')} ${describeDetail(detailMode)}`,
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
    `  ${label('exec')} ${rt.execBackend}`,
    `  ${label('memory')} ${memoryCount} entries`,
    `  ${label('skills')} ${skillCount}`,
    `  ${label('tools')} ${agent.tools.size} (${toolGroups.map((g) => g.title).join(', ')})`,
  ].join('\n');
}

export function renderCliSessionDoctor(agent: MossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const lines: string[] = [ui.bold(ui.black('Doctor')), renderNodeDoctorLine()];

  if (auth.usingBundledDefault) {
    lines.push(doctorOk('model', `${agent.config.model} (built-in model gateway)`));
    lines.push(doctorOk('auth', 'built-in gateway (no API key needed)'));
  } else {
    lines.push(doctorOk('model', `${agent.config.model} (${auth.providerSource})`));
    lines.push(doctorOk('provider', `${auth.provider} (${auth.providerSource})`));
    const authKeyDetail =
      auth.apiKeySource === 'built-in'
        ? 'built-in, shared gateway key'
        : `${auth.apiKeySource}, ${auth.apiKeyEncrypted ? 'encrypted' : 'plain text'}`;
    lines.push(
      auth.apiKey
        ? doctorOk('auth', `API key configured (${authKeyDetail})`)
        : doctorFail('auth', 'no API key; run `moss setup` or `moss config set apiKey ...`')
    );
  }

  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (auth.usingBundledDefault) {
    lines.push(
      doctorOk(
        'egress',
        proxy ? `built-in gateway via proxy ${shortBaseUrl(proxy)}` : 'built-in gateway (direct)'
      )
    );
  } else {
    lines.push(
      doctorOk(
        'egress',
        proxy
          ? `${shortBaseUrl(auth.baseUrl)} via proxy ${shortBaseUrl(proxy)}`
          : `${shortBaseUrl(auth.baseUrl)} (direct, no proxy)`
      )
    );
  }

  const warnings = auditResolvedCliConfig(auth);
  if (warnings.length === 0) {
    lines.push(doctorOk('config', 'no warnings'));
  } else {
    for (const w of warnings) lines.push(doctorWarn(w.code, w.message));
  }

  if ((auth.ignoredModelEnvVars ?? []).length > 0) {
    lines.push(
      doctorWarn(
        'env ignored',
        `${auth.ignoredModelEnvVars.join(', ')} — model settings come only from moss config`
      )
    );
  }

  const sessionLog = path.join(rt.runtimeDir, 'sessions', `${rt.sessionKey}.jsonl`);
  const eventLog = path.join(rt.runtimeDir, 'events', `${encodeURIComponent(rt.sessionKey)}.jsonl`);
  lines.push(
    '',
    `  Session logs: ${sessionLog} · ${eventLog}`,
    '  Full report: `moss doctor` (adds writable-path and search-backend probes)'
  );
  return lines.join('\n');
}

const PERMISSIONS_HELP_TEXT = [
  '',
  '  One mode axis — /mode (Shift+Tab cycles four states, v0.26):',
  '    /mode manual        approve mutations one by one',
  '    /mode accept-edits  auto-approve sandboxed workspace edits',
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

/**
 * One line per permission rule, with its source level spelled out (user /
 * workspace / session — v0.26 T04: the rule manager makes sources visible).
 */
export function permissionRuleLines(
  rules: readonly { level: string; toolName: string; operandPattern?: string; source: string }[],
  sources: { userPath?: string; workspacePath?: string }
): string[] {
  const describeSource = (source: string): string => {
    if (source === 'user')
      return `user (${compactPath(sources.userPath ?? '~/.config/moss/config.json')})`;
    if (source === 'workspace')
      return `workspace (${compactPath(sources.workspacePath ?? '.moss/config.json')})`;
    return 'session (this session only)';
  };
  return rules.map((rule) => {
    const spec = rule.operandPattern ? `${rule.toolName}(${rule.operandPattern})` : rule.toolName;
    return `    ${rule.level.padEnd(5)} ${spec}  —  ${describeSource(rule.source)}`;
  });
}

export function renderCliPermissions(
  runtime: CliRuntimeStatus = {},
  options: { verbose?: boolean } = {}
): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const permissions = auth.permissions;
  const zh = isZhLocale();
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
      `  ${label('workspace')} ${auth.workspace} (${auth.workspaceSource})`,
      `  ${label(zh ? '默认模式' : 'default mode')} ${modeLabel}${ceiling ? ' + read-only ceiling' : ''} (${permissions?.source ?? 'default'})`,
      `  ${label('rules')} allow ${allowCount} · ask ${askCount} · deny ${denyCount}`,
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
      PERMISSIONS_HELP_TEXT,
    ].join('\n');
  }
  return [
    ui.bold(ui.black(zh ? '权限' : 'Permissions')),
    `  ${label(zh ? '默认模式' : 'default mode')} ${modeLabel}${ceiling ? ' (read-only ceiling)' : ''}`,
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
