import fs from 'node:fs';
import path from 'node:path';
import type { MossAgent } from '../core/index.js';
import type { Tool } from '../core/tools/tool-types.js';
import type { DeviceSshSession } from '../tools/device-ssh-session.js';
import { formatCommunityAuthStatus, type MossCommunityAuthRuntime } from './community-auth.js';
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
import { MIN_NODE_MAJOR, MIN_NODE_MINOR, nodeVersionProblem } from './node-version-check.js';

export interface CliDeviceStatus {
  host: string;
  user?: string;
  port?: number;
  connectionState?: 'connected' | 'disconnected';
  connectionReason?: string;
}





export interface CliDeviceSessionHandle {
  registeredNames: string[];
  displaced: Tool[];
  promptLayer?: string;
  boardMode: boolean;
  sshSession?: DeviceSshSession;
}

export interface CliRuntimeStatus {
  workspace?: string;
  runtimeDir?: string;
  configDir?: string;
  baseUrl?: string;
  execBackend?: string;
  safetyMode?: string;
  dockerImage?: string;
  meshEnabled?: boolean;
  device?: CliDeviceStatus | null;
  deviceSession?: CliDeviceSessionHandle | null;
  sessionKey?: string;
  config?: ResolvedCliConfig;
  communityAuth?: MossCommunityAuthRuntime;
  mcp?: CliMcpServerStatus[];
  fullPower?: boolean;
}


export interface CliMcpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
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

function createDefaultRuntime(): Required<
  Omit<CliRuntimeStatus, 'device' | 'deviceSession' | 'dockerImage' | 'communityAuth' | 'mcp'>
> & {
  dockerImage?: string;
  device: CliDeviceStatus | null;
  deviceSession: CliDeviceSessionHandle | null;
  communityAuth?: MossCommunityAuthRuntime;
  mcp?: CliMcpServerStatus[];
} {
  return {
    workspace: WORKSPACE,
    runtimeDir: path.join(WORKSPACE, '.moss'),
    configDir: resolveConfigDir(),
    baseUrl: BASE_URL,
    execBackend: process.env.MOSS_EXEC_BACKEND || 'local',
    safetyMode: process.env.MOSS_SAFETY_MODE || process.env.MOSS_CLI_SAFETY_MODE || 'workspace-write',
    dockerImage: process.env.MOSS_DOCKER_IMAGE,
    meshEnabled: process.env.MOSS_MESH_ENABLED === 'true' || process.argv.includes('--mesh'),
    sessionKey: 'cli',
    fullPower: false,
    config: loadDefaultRuntimeConfig(),
    communityAuth: undefined,
    device: null,
    deviceSession: null,
  };
}

function runtimeWithDefaults(runtime: CliRuntimeStatus = {}) {
  return { ...createDefaultRuntime(), ...runtime };
}

export function formatCliDeviceStatus(
  runtime: Pick<CliRuntimeStatus, 'device' | 'deviceSession'>,
  options: { compact?: boolean } = {}
): string {
  const device = runtime.device;
  if (!device) return options.compact ? 'no device' : 'not connected';
  const target = `${device.user || 'root'}@${device.host}${options.compact ? '' : `:${device.port || 22}`}`;
  if (device.connectionState === 'disconnected') {
    return `${options.compact ? 'LOST ' : ''}${target}${options.compact ? '' : ' — CONNECTION LOST; run /connect to retry'}`;
  }
  if (options.compact) return `${runtime.deviceSession?.boardMode ? 'BOARD ' : ''}${target}`;
  return `${target}${runtime.deviceSession?.boardMode ? ' — BOARD MODE (default tools run on the board; /disconnect to leave)' : ' (hybrid)'}`;
}

function guardrailLine(config: ResolvedCliConfig): string {
  const inputCount =
    (config.guardrails?.input?.blockPatterns?.length ?? 0) +
    (config.guardrails?.input?.redactPatterns?.length ?? 0);
  const outputCount =
    (config.guardrails?.output?.blockPatterns?.length ?? 0) +
    (config.guardrails?.output?.redactPatterns?.length ?? 0);
  if (inputCount === 0 && outputCount === 0) return 'guardrails off';
  return `guardrails in ${inputCount} out ${outputCount}`;
}

function configWarningLines(config: ResolvedCliConfig): string[] {
  const warnings = auditResolvedCliConfig(config);
  if (warnings.length === 0) return [`  ${label('config warnings')} none`];
  return [
    `  ${label('config warnings')} ${warnings.length}`,
    ...warnings.map((warning) => `    ${warning.code}: ${warning.message}`),
  ];
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
  { id: 'workspace', title: 'Workspace', names: ['exec', 'read_file', 'write_file', 'edit_file', 'move_file', 'apply_patch', 'list_directory', 'search_files', 'search_code', 'install_skill'] },
  { id: 'memory', title: 'Memory', prefixes: ['memory_'] },
  { id: 'device', title: 'Device SSH', prefixes: ['device_'] },
  { id: 'ros', title: 'ROS1/ROS2/TROS', prefixes: ['ros1_', 'ros2_'] },
  { id: 'mesh', title: 'Agent Mesh', prefixes: ['mesh_'] },
  { id: 'agent', title: 'Sub-agents', names: ['create_subagent', 'subagent_status', 'subagent_stop', 'fan_out_subagents'] },
  { id: 'web', title: 'Web & Browser', prefixes: ['web_'] },
  { id: 'vision', title: 'Vision', names: ['vision_analyze', 'screenshot_capture'] },
  { id: 'dev', title: 'Development', names: ['code_diagnostics'] },
  { id: 'eval', title: 'Eval & Planning', names: ['eval', 'plan', 'plan_step', 'generate_structured'] },
  { id: 'batch', title: 'Batch', names: ['fleet_batch'] },
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
  const community = rt.communityAuth?.getStatus();
  const providerState = auth.usingBundledDefault ? 'built-in D-Robotics model' : auth.provider;
  const loginState = community?.authenticated
    ? formatCommunityAuthStatus(community)
    : auth.usingBundledDefault
      ? 'optional; /auth login links community'
      : auth.apiKey
        ? 'own provider configured'
        : 'model key missing';
  const deviceState = formatCliDeviceStatus(rt);

  return [
    `${ui.bold('Moss Agent')} ${ui.dim(`v${getPackageVersion()}`)}`,
    `${label('model')} ${agent.config.model} (${providerState})`,
    `${label('workspace')} ${compactPath(rt.workspace)}`,
    `${label('login')} ${loginState}`,
    `${label('board')} ${deviceState}`,
    `${ui.dim('next')} /quickstart, /model, or moss setup to configure your own provider API key`,
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
    rt.device
      ? toolNames.has('device_resources')
        ? 'Check the board CPU, memory, temperature and processes, and flag anything abnormal'
        : 'Board connected but device_resources tool not available; check capability packs'
      : 'Connect a board: /connect <board-ip> (uses MOSS_DEVICE_USER/PASSWORD/KEY/PORT if set)',
    rt.device && toolNames.has('ros2_topic_list')
      ? 'List the ROS2 topics on the board and tell me whether the camera or perception nodes are online'
      : null,
    rt.device && toolNames.has('device_robotics_status')
      ? 'Inspect the robot development environment first, then recommend the safest next diagnostic step'
      : null,
  ].filter(Boolean) as string[];

  return [
    ui.bold(ui.black('Quick start')),
    '',
    `  ${label('1/3 Model')} ${agent.config.model} · provider ${auth.usingBundledDefault ? 'built-in D-Robotics model' : auth.provider} · api key ${apiKeyState}`,
    auth.usingBundledDefault
      ? '      Built-in D-Robotics model is ready without a model API key or forced login. Optional: `/auth login` links a community session; `moss setup` uses your own provider.'
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
    rt.device
      ? `      Board connected: ${rt.device.user || 'root'}@${rt.device.host}:${rt.device.port || 22} — device and ROS tools are on.`
      : '      /connect <board-ip> enables board and ROS tools for this session. Use env vars for SSH credentials: MOSS_DEVICE_USER/PASSWORD/KEY/PORT.',
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
  const skillCount = countMarkdownFiles(path.join(rt.workspace, '.moss', 'skills', 'learned'));
  const sessionDir = path.join(rt.runtimeDir, 'sessions');
  const detailMode = resolveCliDetailMode();
  const toolGroups = groupTools(agent.tools.getAll()).filter((g) => g.enabled);
  const auth = rt.config;
  const community = rt.communityAuth?.getStatus();
  if (!options.verbose) {
    return [
      ui.bold(ui.black('Status')),
      `  ${label('model')} ${agent.config.model} (${auth.usingBundledDefault ? 'built-in D-Robotics model' : auth.provider})`,
      `  ${label('login')} ${community ? formatCommunityAuthStatus(community, { includePath: false }) : 'unknown'}`,
      `  ${label('workspace')} ${rt.workspace}`,
      `  ${label('permissions')} ${auth.approvalPolicy === 'never' ? 'workspace auto-allow; outside workspace remains blocked' : 'ask before workspace changes'} (${auth.approvalPolicySource ?? 'default'})`,
      `  ${label('board')} ${formatCliDeviceStatus(rt)}`,
      `  ${label('tools')} ${agent.tools.size} (${toolGroups.map((g) => g.title).join(', ') || 'none'})`,
      `  ${label('memory')} ${memoryCount} entries`,
      `  ${label('skills')} ${skillCount}`,
      `  ${label('setup')} moss setup · /model · /quickstart`,
      '',
      '  Details: /status --verbose',
    ].join('\n');
  }

  return [
    ui.bold('Status'),
    `  ${label('session')} ${rt.sessionKey}`,
    `  ${label('model')} ${agent.config.model}`,
    `  ${label('provider')} ${auth.usingBundledDefault ? 'built-in D-Robotics model' : `${auth.provider} (${auth.providerSource}) via ${shortBaseUrl(rt.baseUrl)}`}`,
    `  ${label('community')} ${community ? formatCommunityAuthStatus(community) : 'unknown'}`,
    `  ${label('profile')} ${auth.profile ?? 'autonomous'} (${auth.profileSource ?? 'default'})`,
    `  ${label('api key')} ${auth.usingBundledDefault ? 'built-in model (hidden)' : auth.apiKey ? `configured via ${auth.apiKeySource}` : 'missing'}`,
    `  ${label('workspace')} ${rt.workspace}`,
    `  ${label('config')} ${rt.configDir}`,
    `  ${label('sessions')} ${sessionDir}`,
    `  ${label('detail')} ${describeDetail(detailMode)}`,
    `  ${label('safety')} ${rt.safetyMode}`,
    `  ${label('approval')} ${auth.approvalPolicy ?? 'prompt'} (${auth.approvalPolicySource ?? 'default'})`,
    `  ${label('trusted tools')} ${(auth.trustedTools ?? []).length ? (auth.trustedTools ?? []).join(', ') : 'none'} (${auth.trustedToolsSource ?? 'default'})`,
    `  ${label('denied tools')} ${(auth.deniedTools ?? []).length ? (auth.deniedTools ?? []).join(', ') : 'none'} (${auth.deniedToolsSource ?? 'default'})`,
    `  ${label('prompt cache')} ${auth.promptCacheEnabled === false ? 'disabled' : 'enabled'} (${auth.promptCacheSource ?? 'default'})`,
    `  ${label('prompt cache debug')} ${auth.promptCacheDebug === true ? 'enabled' : 'disabled'} (${auth.promptCacheDebugSource ?? 'default'})`,
    `  ${label('guardrails')} ${guardrailLine(auth)} (${auth.guardrailsSource ?? 'default'})`,
    `  ${label('max turns')} ${auth.maxAgentTurns} (${auth.maxAgentTurnsSource ?? 'default'})`,
    `  ${label('context tokens')} ${auth.contextTokens} (${auth.contextTokensSource ?? 'default'})`,
    `  ${label('max output')} ${auth.maxOutputTokens ?? 'derived from context window (contextTokens/4, cap 128k)'}`,
    `  ${label('compaction')} reserve ${auth.compactionSettings?.reserveTokens ?? 20000}, keepRecent ${auth.compactionSettings?.keepRecentTokens ?? 20000} (${auth.compactionSettingsSource ?? 'default'})`,
    `  ${label('exec')} ${rt.execBackend}${rt.execBackend === 'docker' && rt.dockerImage ? ` (${rt.dockerImage})` : ''}`,
    `  ${label('memory')} ${memoryCount} entries`,
    `  ${label('skills')} ${skillCount}`,
    `  ${label('tools')} ${agent.tools.size} (${toolGroups.map((g) => g.title).join(', ')})`,
    `  ${label('device')} ${formatCliDeviceStatus(rt)}`,
    `  ${label('mesh')} ${rt.meshEnabled ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

export function renderCliMcp(runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const mcpEnabled = rt.config?.mcpEnabled === true;
  const servers = rt.mcp ?? [];
  if (!mcpEnabled) {
    return [
      ui.bold(ui.black('MCP servers')),
      `  ${label('status')} disabled`,
      `  Enable with \`moss config set mcpEnabled true\`, then configure servers in ${rt.config?.mcpConfigPath ?? 'mcp.json'}.`,
    ].join('\n');
  }
  if (servers.length === 0) {
    return [
      ui.bold(ui.black('MCP servers')),
      `  ${label('status')} enabled, no servers connected`,
      `  ${label('config')} ${rt.config?.mcpConfigPath ?? '(not configured)'}`,
      '  Add a server with `moss mcp add <name> -- <command> [args...]`.',
    ].join('\n');
  }
  const connected = servers.filter((s) => s.connected).length;
  const totalTools = servers.reduce((n, s) => n + s.toolCount, 0);
  return [
    ui.bold(ui.black('MCP servers')),
    `  ${label('config')} ${rt.config?.mcpConfigPath ?? '(not configured)'}`,
    `  ${label('summary')} ${connected}/${servers.length} connected · ${totalTools} tools`,
    ...servers.map((server) => {
      const marker = server.connected ? ui.green('●') : ui.yellow('○');
      const state = server.connected ? `${server.toolCount} tools` : 'failed to connect';
      return `  ${marker} ${server.name}  ${ui.dim(state)}`;
    }),
  ].join('\n');
}


function doctorLine(kind: 'ok' | 'warn' | 'fail', name: string, detail: string): string {
  const dot = kind === 'ok' ? ui.green('●') : ui.yellow('○');
  return `  ${dot} ${kind.padEnd(4)} ${label(name)} ${detail}`;
}









export function renderCliSessionDoctor(agent: MossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const lines: string[] = [ui.bold(ui.black('Doctor'))];

  const nodeProblem = nodeVersionProblem(process.version);
  lines.push(
    !nodeProblem
      ? doctorLine('ok', 'node', process.version)
      : doctorLine(
          'fail',
          'node',
          `${process.version}; requires >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`
        )
  );
  if (auth.usingBundledDefault) {
    lines.push(doctorLine('ok', 'model', `${agent.config.model} (built-in D-Robotics model)`));
    lines.push(doctorLine('ok', 'auth', 'built-in gateway (no API key needed)'));
  } else {
    lines.push(doctorLine('ok', 'model', `${agent.config.model} (${auth.providerSource})`));
    lines.push(doctorLine('ok', 'provider', `${auth.provider} (${auth.providerSource})`));
    const authKeyDetail =
      auth.apiKeySource === 'built-in'
        ? 'built-in, shared gateway key'
        : `${auth.apiKeySource}, ${auth.apiKeyEncrypted ? 'encrypted' : 'plain text'}`;
    lines.push(
      auth.apiKey
        ? doctorLine('ok', 'auth', `API key configured (${authKeyDetail})`)
        : doctorLine('fail', 'auth', 'no API key; run `moss setup` or `moss config set apiKey ...`')
    );
  }

  
  
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (auth.usingBundledDefault) {
    lines.push(
      doctorLine(
        'ok',
        'egress',
        proxy ? `built-in gateway via proxy ${shortBaseUrl(proxy)}` : 'built-in gateway (direct)'
      )
    );
  } else {
    lines.push(
      doctorLine(
        'ok',
        'egress',
        proxy
          ? `${shortBaseUrl(auth.baseUrl)} via proxy ${shortBaseUrl(proxy)}`
          : `${shortBaseUrl(auth.baseUrl)} (direct, no proxy)`
      )
    );
  }

  if (rt.device) {
    const target = `${rt.device.user || 'root'}@${rt.device.host}:${rt.device.port || 22}`;
    lines.push(
      doctorLine(
        rt.device.connectionState === 'disconnected' ? 'warn' : 'ok',
        'board',
        rt.device.connectionState === 'disconnected'
          ? `${target} — CONNECTION LOST; run /connect to retry`
          : `${target}${rt.deviceSession?.boardMode ? ' — BOARD MODE' : ' (hybrid)'}`
      )
    );
  } else {
    lines.push(doctorLine('ok', 'board', 'not connected (/connect <ip> to attach an RDK board)'));
  }

  if (auth.mcpEnabled !== true) {
    lines.push(doctorLine('ok', 'mcp', `disabled (${auth.mcpEnabledSource ?? 'default'})`));
  } else {
    const servers = rt.mcp ?? [];
    if (servers.length === 0) {
      lines.push(
        doctorLine(
          'warn',
          'mcp',
          `enabled (${auth.mcpEnabledSource ?? 'config'}) but no servers connected; config ${auth.mcpConfigPath}`
        )
      );
    } else {
      const connected = servers.filter((s) => s.connected).length;
      const total = servers.reduce((n, s) => n + s.toolCount, 0);
      lines.push(
        connected === servers.length
          ? doctorLine(
              'ok',
              'mcp',
              `${connected}/${servers.length} servers connected · ${total} tools`
            )
          : doctorLine(
              'warn',
              'mcp',
              `${connected}/${servers.length} servers connected (${servers
                .filter((s) => !s.connected)
                .map((s) => s.name)
                .join(', ')} failed) · ${total} tools`
            )
      );
    }
  }

  const warnings = auditResolvedCliConfig(auth);
  if (warnings.length === 0) {
    lines.push(doctorLine('ok', 'config', 'no warnings'));
  } else {
    for (const w of warnings) lines.push(doctorLine('warn', w.code, w.message));
  }

  if ((auth.ignoredModelEnvVars ?? []).length > 0) {
    lines.push(
      doctorLine(
        'warn',
        'env ignored',
        `${auth.ignoredModelEnvVars.join(', ')} — model settings come only from moss config`
      )
    );
  }

  lines.push('', '  Full report: `moss doctor` (adds update-check and writable-path probes)');
  return lines.join('\n');
}

const PERMISSIONS_HELP_TEXT = [
  '',
  '  Profiles:',
  '    cautious        read-only, prompt approvals, stable prompt cache',
  '    balanced        workspace-write, auto approvals inside safety boundaries, stable prompt cache',
  '    autonomous      workspace-write, auto approvals, trusts exec/apply_patch, stable prompt cache (default)',
  '',
  '  Safety modes:',
  '    read-only        allow reads/search/status only; block mutations',
  '    workspace-write  allow workspace/runtime writes; block broader side effects',
  '    full-access      allow all declared tool side-effect classes',
  '',
  '  Approval policies:',
  '    prompt           ask before side-effectful tools',
  '    prompt + a       trust the approved tool for the current session',
  '    never            auto-approve allowed side-effectful tools',
  '',
  '  Grant full access (run allowed tools without per-call approval):',
  '    --full-access    launch flag for the whole run',
  '    /permissions     change safety mode and approval policy for this session',
  '    Denied tools stay blocked either way; the safety mode above is the ceiling.',
  '',
  '  Persist changes:',
  '    moss config init --project',
  '    moss setup',
  '    moss config set provider deepseek|qwen|openai|anthropic|openai-compatible',
  '    moss config set model <your-model>',
  '    moss config set baseUrl https://your-gateway.example/v1',
  '    moss config set profile cautious|balanced|autonomous',
  '    moss config set --project safetyMode workspace-write',
  '    moss config set workspace /path/to/workspace',
  '    moss config set safetyMode read-only|workspace-write|full-access',
  '    moss config set approvalPolicy prompt|never',
  '    moss config set trustedTools exec,filesystem__*',
  '    moss config set deniedTools device_*,write_file',
  '    moss config set promptCache true|false',
  '    moss config set promptCacheDebug true|false',
  '    moss config set mcp.enabled true|false',
  '    moss config set mcp.configPath .moss/mcp.json',
  '    edit guardrails.input/output blockPatterns or redactPatterns in config JSON',
  '    moss config set agent.maxTurns 96',
  '    moss config set agent.contextTokens 200000',
  '    moss config set agent.compaction.reserveTokens 20000',
  '    moss config unset --project safetyMode',
  '    moss config unset approvalPolicy',
  '',
  '  Environment overrides (model settings are config-only; provider/model/key/baseUrl env vars are ignored):',
  '    MOSS_PROFILE, MOSS_SAFETY_MODE, MOSS_APPROVAL_POLICY, MOSS_TRUSTED_TOOLS, MOSS_PROMPT_CACHE, MOSS_PROMPT_CACHE_DEBUG, MOSS_MCP_ENABLED, MOSS_MCP_CONFIG, MOSS_MAX_AGENT_TURNS, MOSS_CONTEXT_TOKENS (legacy MOSS_* still works)',
].join('\n');

export function renderCliPermissions(runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const safety = auth.safetyMode ?? rt.safetyMode;
  const approval = auth.approvalPolicy ?? 'prompt';
  const configuredTrustedTools = auth.trustedTools ?? [];
  const trustedTools = configuredTrustedTools.length ? configuredTrustedTools.join(', ') : 'none';
  const configuredDeniedTools = auth.deniedTools ?? [];
  const deniedTools = configuredDeniedTools.length ? configuredDeniedTools.join(', ') : 'none';
  const cache = auth.promptCacheEnabled === false ? 'disabled' : 'enabled';
  const cacheDebug = auth.promptCacheDebug === true ? 'enabled' : 'disabled';
  const mcp = auth.mcpEnabled === true ? 'enabled' : 'disabled';
  
  
  const guardrails = auth.guardrails ?? {
    input: { blockPatterns: [], redactPatterns: [] },
    output: { blockPatterns: [], redactPatterns: [] },
  };
  const inputGuardrails =
    (guardrails.input?.blockPatterns?.length ?? 0) +
    (guardrails.input?.redactPatterns?.length ?? 0);
  const outputGuardrails =
    (guardrails.output?.blockPatterns?.length ?? 0) +
    (guardrails.output?.redactPatterns?.length ?? 0);
  const compaction = auth.compactionSettings ?? { reserveTokens: 20000, keepRecentTokens: 20000 };
  return [
    ui.bold(ui.black('Permissions & Config')),
    `  ${label('config file')} ${auth.configPath}`,
    `  ${label('profile')} ${auth.profile ?? 'autonomous'} (${auth.profileSource ?? 'default'})`,
    `  ${label('workspace')} ${auth.workspace} (${auth.workspaceSource})`,
    `  ${label('safety')} ${safety} (${auth.safetyModeSource ?? 'default'})`,
    `  ${label('approval')} ${approval} (${auth.approvalPolicySource ?? 'default'})`,
    `  ${label('trusted tools')} ${trustedTools} (${auth.trustedToolsSource ?? 'default'})`,
    `  ${label('denied tools')} ${deniedTools} (${auth.deniedToolsSource ?? 'default'})`,
    `  ${label('prompt cache')} ${cache} (${auth.promptCacheSource ?? 'default'})`,
    `  ${label('prompt cache debug')} ${cacheDebug} (${auth.promptCacheDebugSource ?? 'default'})`,
    `  ${label('mcp')} ${mcp} (${auth.mcpEnabledSource ?? 'default'})`,
    `  ${label('mcp config')} ${auth.mcpConfigPath} (${auth.mcpConfigPathSource ?? 'default'})`,
    `  ${label('guardrails')} input ${inputGuardrails}, output ${outputGuardrails} (${auth.guardrailsSource ?? 'default'})`,
    `  ${label('max turns')} ${auth.maxAgentTurns} (${auth.maxAgentTurnsSource ?? 'default'})`,
    `  ${label('context tokens')} ${auth.contextTokens} (${auth.contextTokensSource ?? 'default'})`,
    `  ${label('max output')} ${auth.maxOutputTokens ?? 'derived from context window (contextTokens/4, cap 128k)'}`,
    `  ${label('compaction')} reserve ${compaction.reserveTokens}, keepRecent ${compaction.keepRecentTokens} (${auth.compactionSettingsSource ?? 'default'})`,
    ...configWarningLines(auth),
    PERMISSIONS_HELP_TEXT,
  ].join('\n');
}

export function renderCliInteractiveHelp(): string {
  return [
    ui.bold(ui.black('Commands')),
    ...formatInteractiveCommandSections({ indent: '    ', commandWidth: 24 }),
    '',
    '  Shortcuts',
    '    Ctrl+V                   attach a copied image, Finder file, or file path in the full TUI',
    '    Esc                      stop the active run in the full TUI',
    '    Ctrl+O                   expand/collapse tool calls in the full TUI',
    '    Ctrl+C                   exit',
    '',
    '  Advanced commands still work when needed: /status --verbose, /context, /cost, /rewind, /permissions, /memory, /skills, /queue.',
  ].join('\n');
}







export interface OnboardingState {
  hasApiKey: boolean;
  
  hasMissingApiKey: boolean;
  





  hasMissingModel: boolean;
  hasDeviceConnected: boolean;
  hasAgentsMdInWorkspace: boolean;
  hasPreviousSessions: boolean;
  isFirstRun: boolean;
}

export function renderProgressiveOnboardingTips(state: OnboardingState): string {
  
  if (state.isFirstRun) {
    const tips: string[] = [
      ui.bold(ui.black('Welcome to Moss — ask for a task whenever you are ready.')),
      `  ${ui.bold('/model')} choose model · ${ui.bold('moss setup')} provider · ${ui.bold('/help')} commands`,
      `  Optional: ${ui.bold('/connect <board-ip>')} board tools · ${ui.bold('/init')} project guidance`,
    ];
    return tips.join('\n');
  }

  
  const gaps: string[] = [];

  if (state.hasMissingApiKey) {
    
    
    gaps.push(
      ui.yellow('⚠  ') +
        'No API key configured — run ' +
        ui.bold('moss setup') +
        ' to add one, or ' +
        ui.bold('moss config validate') +
        ' for details.'
    );
  } else if (state.hasMissingModel) {
    
    
    gaps.push(
      ui.yellow('⚠  ') +
        'No model selected — run ' +
        ui.bold('/model') +
        " to pick from your gateway's available models."
    );
  }

  if (gaps.length > 0) {
    return [
      ui.bold(ui.black('Quick tips for this session:')),
      '',
      ...gaps,
    ].join('\n');
  }

  return '';
}
