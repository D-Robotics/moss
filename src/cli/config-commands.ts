import fs from 'node:fs';
import path from 'node:path';
import { stdout as standardOutput } from 'node:process';
import { WORKSPACE_WRITE_LIMIT_EN, WORKSPACE_WRITE_LIMIT_ZH } from './workspace-write-copy.js';
import { isHttpUrl } from '../provider/api-v1-url.js';
import {
  auditResolvedCliConfig,
  isBroadTrustedToolPattern,
  loadCliConfigFile,
  loadConfigFile,
  normalizeApprovalPolicyConfig,
  normalizeConfigProfile,
  normalizeSafetyModeConfig,
  parseConfigBoolean,
  parseProviderPreset,
  parseTrustedTools,
  PROVIDER_PRESETS,
  resolveCliConfig,
  resolveConfigPath,
  resolveProjectConfigPath,
  saveConfigFileAtPath,
  type CliConfigOverrides,
  type CliProviderPreset,
  type ConfigFile,
} from './config.js';
import { errorMessage } from '../errors.js';
import { isZhLocale, parseLanguageSetting, uiText } from './cli-locale.js';
import { guessModelProvider, print, renderAuthStatus, sanitizeBaseUrl } from './setup-wizard.js';
import { withoutSecret } from './config-snapshot.js';
import { parsePermissionRuleSpec } from './permission-rules.js';
import { parseCliInteractionMode } from './interaction-mode.js';

function serializeResolvedConfig(
  resolved: ReturnType<typeof resolveCliConfig>
): Record<string, unknown> {
  return {
    schema: 'moss_cli_config.v1',
    profile: resolved.profile,
    profileSource: resolved.profileSource,
    provider: resolved.provider,
    providerSource: resolved.providerSource,
    model: resolved.model,
    modelSource: resolved.modelSource,
    baseUrl: withoutSecret(resolved.baseUrl),
    baseUrlSource: resolved.baseUrlSource,
    apiKeyConfigured: Boolean(resolved.apiKey),
    apiKeySource: resolved.apiKeySource,
    ignoredModelEnvVars: [...resolved.ignoredModelEnvVars],
    workspace: resolved.workspace,
    workspaceSource: resolved.workspaceSource,
    safetyMode: resolved.safetyMode,
    safetyModeSource: resolved.safetyModeSource,
    approvalPolicy: resolved.approvalPolicy,
    approvalPolicySource: resolved.approvalPolicySource,
    trustedTools: [...resolved.trustedTools],
    trustedToolsSource: resolved.trustedToolsSource,
    deniedTools: [...resolved.deniedTools],
    deniedToolsSource: resolved.deniedToolsSource,
    promptCacheEnabled: resolved.promptCacheEnabled,
    promptCacheSource: resolved.promptCacheSource,
    promptCacheDebug: resolved.promptCacheDebug,
    promptCacheDebugSource: resolved.promptCacheDebugSource,
    guardrails: {
      input: {
        blockPatterns: [...resolved.guardrails.input.blockPatterns],
        redactPatterns: [...resolved.guardrails.input.redactPatterns],
      },
      output: {
        blockPatterns: [...resolved.guardrails.output.blockPatterns],
        redactPatterns: [...resolved.guardrails.output.redactPatterns],
      },
    },
    guardrailsSource: resolved.guardrailsSource,
    maxAgentTurns: resolved.maxAgentTurns,
    maxAgentTurnsSource: resolved.maxAgentTurnsSource,
    contextTokens: resolved.contextTokens,
    contextTokensSource: resolved.contextTokensSource,
    compactionSettings: { ...resolved.compactionSettings },
    compactionSettingsSource: resolved.compactionSettingsSource,
    configWarnings: auditResolvedCliConfig(resolved),
    configPath: resolved.configPath,
    projectConfigPath: resolved.projectConfigPath ?? null,
  };
}

function serializeConfigValidation(
  resolved: ReturnType<typeof resolveCliConfig>,
  options: { strict: boolean; extraWarnings?: ReturnType<typeof auditResolvedCliConfig> }
): Record<string, unknown> {
  const warnings = options.extraWarnings ?? auditResolvedCliConfig(resolved);
  return {
    schema: 'moss_cli_config_validation.v1',
    ok: !options.strict || warnings.length === 0,
    strict: options.strict,
    warningCount: warnings.length,
    configWarnings: warnings,
    configPath: resolved.configPath,
    projectConfigPath: resolved.projectConfigPath ?? null,
  };
}

function parseConfigPositiveInteger(
  value: string,
  key: string
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: `Supported ${key} value: positive integer` };
  }
  return { ok: true, value: parsed };
}

function parseConfigPatternList(value: string, key: string): string[] {
  const patterns = value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  const unique = [...new Set(patterns)];
  for (const pattern of unique) {
    if (pattern.length > 500) {
      throw new Error(`Unsupported ${key} pattern: values must be 500 characters or less`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (err) {
      const message = errorMessage(err);
      throw new Error(`Invalid ${key} pattern "${pattern}": ${message}`);
    }
    if (regex.test('')) {
      throw new Error(`Invalid ${key} pattern "${pattern}": pattern must not match empty text`);
    }
  }
  return unique;
}

function setGuardrailPatternList(config: ConfigFile, key: string, value: string): boolean {
  if (
    key !== 'guardrails.input.blockPatterns' &&
    key !== 'guardrails.input.redactPatterns' &&
    key !== 'guardrails.output.blockPatterns' &&
    key !== 'guardrails.output.redactPatterns'
  ) {
    return false;
  }
  const [, direction, listKey] = key.split('.') as [
    'guardrails',
    'input' | 'output',
    'blockPatterns' | 'redactPatterns',
  ];
  config.guardrails = {
    ...config.guardrails,
    [direction]: {
      ...config.guardrails?.[direction],
      [listKey]: parseConfigPatternList(value, key),
    },
  };
  return true;
}

// ── v0.26 permissions write side (T04) ───────────────────────────────────────

/**
 * Append one rule spec to the user config's permissions.<level> list
 * (dedup; `moss config set permissions.allow=...` REPLACES the whole list —
 * this helper is the additive path /permissions persist uses).
 */
export function appendUserPermissionRule(
  spec: string,
  level: 'allow' | 'ask' | 'deny'
): { ok: true; message: string } | { ok: false; message: string } {
  try {
    // Validate the spec BEFORE touching the file (parse throws MossError).
    parsePermissionRuleSpecPublic(spec, level);
    const configPath = resolveConfigPath();
    const current = loadConfigFile(configPath);
    const permissions = current.permissions ?? {};
    const list = [...new Set([...(permissions[level] ?? []), spec])];
    if (list.length === (permissions[level] ?? []).length) {
      return { ok: true, message: `already present in ${configPath}` };
    }
    saveConfigFileAtPath(
      { ...current, permissions: { ...permissions, [level]: list } },
      configPath
    );
    return { ok: true, message: `saved to ${configPath}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Thin re-export so config-commands keeps one import surface for the parser. */
function parsePermissionRuleSpecPublic(
  spec: string,
  level: 'allow' | 'ask' | 'deny'
): ReturnType<typeof parsePermissionRuleSpec> {
  return parsePermissionRuleSpec(spec, 'user', level);
}

/**
 * v0.26 `permissions.*` set keys. Array lists REPLACE the whole table (same
 * semantics as the guardrails array keys — comma-separated specs).
 * permissions.defaultMode validates against the mode enum.
 */
function setPermissionsKey(config: ConfigFile, key: string, value: string): boolean {
  if (
    key !== 'permissions.defaultMode' &&
    key !== 'permissions.allow' &&
    key !== 'permissions.ask' &&
    key !== 'permissions.deny' &&
    key !== 'permissions.deviceTrust' &&
    key !== 'permissions.trustedDevices'
  ) {
    return false;
  }
  const subKey = key.split('.')[1] as
    | 'defaultMode'
    | 'allow'
    | 'ask'
    | 'deny'
    | 'deviceTrust'
    | 'trustedDevices';
  const permissions = { ...(config.permissions ?? {}) };
  if (subKey === 'defaultMode') {
    permissions.defaultMode = value;
  } else if (subKey === 'deviceTrust') {
    permissions.deviceTrust = value;
  } else if (subKey === 'trustedDevices') {
    permissions.trustedDevices = parseConfigPatternList(value, key);
  } else {
    permissions[subKey] = parseConfigPatternList(value, key);
  }
  config.permissions = permissions;
  return true;
}

export function renderConfigJson(
  config?: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
  startDir = process.cwd(),
  overrides: CliConfigOverrides = {}
): string {
  const loaded =
    config === undefined ? loadCliConfigFile(env, process.argv.slice(2), startDir) : undefined;
  const resolved = resolveCliConfig(env, config ?? loaded?.config, overrides, loaded);
  return JSON.stringify(serializeResolvedConfig(resolved), null, 2);
}

/** Short usage — printed on error paths; points at `moss config --help`. */
export function renderConfigUsage(): string {
  if (isZhLocale()) {
    return [
      '用法：',
      '  moss config                          显示解析后的值和来源',
      '  moss config init [--project] [--force]',
      '  moss config show [--json]',
      '  moss config validate [--strict] [--json]',
      '  moss config env                      Moss 实际读取的每个 MOSS_* 覆盖',
      '  moss config set <key> <value>|<key>=<value> [--project]',
      '  moss config unset <key> [--project]',
      '',
      '每个可设置的键和示例：moss config --help',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss config                          show resolved values and sources',
    '  moss config init [--project] [--force]',
    '  moss config show [--json]',
    '  moss config validate [--strict] [--json]',
    '  moss config env                      every MOSS_* override moss reads',
    '  moss config set <key> <value>|<key>=<value> [--project]',
    '  moss config unset <key> [--project]',
    '',
    'Every settable key with examples: moss config --help',
  ].join('\n');
}

/**
 * The authoritative MOSS_* environment-variable reference. A coverage test
 * scans src/ for /MOSS_[A-Z0-9_]+/ and fails when a new variable is read but
 * missing here (or listed here but read nowhere).
 */
export const MOSS_ENV_REFERENCE: ReadonlyArray<{ group: string; vars: readonly string[] }> = [
  {
    group: 'config & identity',
    vars: [
      'MOSS_CONFIG_DIR (process env only; a project .env cannot set this)',
      'MOSS_CONFIG_FILE (process env or --config-file; a project .env cannot set this)',
      'MOSS_CONFIG_PATH (legacy alias of MOSS_CONFIG_FILE; a project .env cannot set this)',
      'MOSS_WORKSPACE',
      'MOSS_PROFILE (process env only; a project .env cannot set this)',
      'MOSS_CONFIG_PROFILE (legacy alias of MOSS_PROFILE; a project .env cannot set this)',
      'MOSS_CLI_IDENTITY',
      'MOSS_RUN_ID',
      'MOSS_BUNDLED_DEFAULT_FILE',
      'MOSS_NO_BUNDLED_DEFAULT',
      'MOSS_SOURCE_DIR (checkout for moss update; --dir wins)',
    ],
  },
  {
    group:
      'safety & approval (v0.26: these are MODE overrides — read-only arms the read-only ceiling, never/ full, prompt/manual; rules live in permissions.*, not env)',
    vars: [
      `MOSS_SAFETY_MODE (${WORKSPACE_WRITE_LIMIT_EN})`,
      'MOSS_CLI_SAFETY_MODE (legacy alias of MOSS_SAFETY_MODE)',
      'MOSS_APPROVAL_POLICY',
      'MOSS_ASK_FOR_APPROVAL (legacy alias of MOSS_APPROVAL_POLICY)',
      'MOSS_TRUSTED_TOOLS (legacy — translated to allow rules on read)',
      'MOSS_DENIED_TOOLS (legacy — translated to deny rules on read)',
      'MOSS_CLI_AUTO_APPROVE',
      'MOSS_AUTO_APPROVE (legacy alias of MOSS_CLI_AUTO_APPROVE)',
    ],
  },
  {
    group: 'runs, loops & budgets',
    vars: [
      'MOSS_MAX_AGENT_TURNS',
      'MOSS_DEFAULT_MAX_AGENT_TURNS',
      'MOSS_MAX_AGENT_TURNS_HARD_CAP',
      'MOSS_CONTEXT_TOKENS',
      'MOSS_MAX_OUTPUT_TOKENS',
      'MOSS_LOOP_MAX',
      'MOSS_GOAL_VERIFY_CMD (process env only; a project .env cannot set this)',
      'MOSS_GOAL_VERIFY_LOOP (process env only; a project .env cannot set this)',
      'MOSS_DISABLE_NUDGES (comma-separated nudge ids to suppress; unset leaves every nudge on)',
      'MOSS_PLAN_GATE (1 enables the /plan approval gate; default off)',
      'MOSS_GOAL_AUTO_MAX_RUNS',
      'MOSS_ACCEPT_LOGIN_PATH (0 stops acceptance commands from appending the login-shell PATH)',
      'MOSS_BUDGET_MAX_TOKENS',
      'MOSS_BUDGET_MAX_TOOL_CALLS',
      'MOSS_BUDGET_MAX_TURNS',
      'MOSS_BUDGET_MAX_WALL_MS',
      'MOSS_BUDGET_ (prefix of the MOSS_BUDGET_MAX_* keys)',
      'MOSS_CAPABILITY_LAYER',
      'MOSS_WORKTREE_SUBAGENTS',
      'MOSS_EXPERIENCE (1 enables the project-local experience experiment)',
    ],
  },
  {
    group: 'device (robotics closed loop)',
    vars: [
      'MOSS_DEVICE_HOST (project .env applies only after that folder is trusted)',
      'MOSS_DEVICE_PORT (project .env applies only after that folder is trusted)',
      'MOSS_DEVICE_USER (project .env applies only after that folder is trusted)',
      'MOSS_DEVICE_PASSWORD',
      'MOSS_DEVICE_KEY (project .env applies only after that folder is trusted)',
      'MOSS_DEVICE_KEY_PASSPHRASE',
      'MOSS_DEVICE_KIND (project .env applies only after that folder is trusted)',
      'MOSS_DEVICE_ID (project .env applies only after that folder is trusted)',
      'MOSS_DEVICE_TRUST (full|1|true|yes opts this process into destructive device operations)',
      'MOSS_TRUST_WORKSPACE (1|true|yes|on; process env or --trust-workspace only, never a project .env)',
      'MOSS_DEVICE_TRUST_DEVICES (comma-separated host or device-id allowlist)',
      'MOSS_DEVICE_ (prefix of every MOSS_DEVICE_* key)',
      'MOSS_NO_RDK_DOCS (1|true|yes|on skips the built-in rdk-docs MCP server)',
      'MOSS_WAIT_MCP_STARTUP (1 waits for the in-flight MCP connect before shutdown; default does not)',
      'MOSS_RDK_DOCS_PACKAGE (npm spec or local path; process env only, not project config or .env)',
      'MOSS_RDK_DOCS_PIN_CHECK (1|true|yes|on asks npm if rdk-docs-mcp latest is newer than the pin; off by default, not used at startup)',
    ],
  },
  {
    group: 'context & compaction',
    vars: [
      'MOSS_AUTOCOMPACT_BUFFER_RATIO',
      'MOSS_AUTOCOMPACT_BUFFER_TOKENS',
      'MOSS_COMPACTION_PREPARE_TIMEOUT_MS',
      'MOSS_CONTEXT_CHARS_PER_TOKEN_UNIT',
      'MOSS_CONTEXT_HARD_CLEAR_RATIO',
      'MOSS_CONTEXT_KEEP_LAST_ASSISTANTS',
      'MOSS_CONTEXT_MAX_HISTORY_SHARE',
      'MOSS_CONTEXT_SOFT_TRIM_RATIO',
      'MOSS_REMOTE_COMPACT_ENDPOINT',
      'MOSS_REMOTE_COMPACT_API_KEY',
      'MOSS_REMOTE_COMPACT_TIMEOUT_MS',
    ],
  },
  {
    group: 'providers, models & fallback',
    vars: [
      'MOSS_BEST_OF_N',
      'MOSS_REASONING_BUDGET',
      'MOSS_MODEL_BALANCED',
      'MOSS_MODEL_CHEAP',
      'MOSS_MODEL_STRONG',
      'MOSS_TEMPERATURE',
      'MOSS_TOP_P',
      'MOSS_FALLBACK_PROVIDERS',
      'MOSS_FALLBACK_MAX_RETRIES',
      'MOSS_FALLBACK_COOLDOWN_MS',
      'MOSS_PROMPT_CACHE',
      'MOSS_PROMPT_CACHE_DEBUG',
      'MOSS_PROMPT_CACHE_ENABLED (legacy alias)',
      'MOSS_PROMPT_PREFIX_DEBUG (legacy alias)',
      'MOSS_PRICE_IN',
      'MOSS_PRICE_OUT',
      'MOSS_DISABLE_CONN_WARMUP',
      'MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS',
      'MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS',
      'MOSS_PI_AI_INTER_EVENT_TIMEOUT_MS',
      'MOSS_PI_AI_TOOL_CHOICE',
      'MOSS_TRACE_PI_AI_STREAM',
    ],
  },
  {
    group: 'tools, exec & guardrails',
    vars: [
      'MOSS_EXEC_BACKEND',
      'MOSS_EXEC_TIMEOUT_MS',
      'MOSS_NET_ALLOW_HOSTS',
      'MOSS_TOOL_RETRY_MAX',
      'MOSS_TOOL_RETRY_BACKOFF_BASE_MS',
      'MOSS_TOOL_RETRY_BACKOFF_MAX_MS',
      'MOSS_TOOL_LOOP_DISCOVERY_FAILURE_LIMIT',
      'MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT',
      'MOSS_TOOL_LOOP_FAILURE_LIMIT',
      'MOSS_TOOL_LOOP_IDENTICAL_LIMIT',
      'MOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT',
      'MOSS_TOOL_LOOP_TOTAL_LIMIT',
      'MOSS_TOOL_NAME',
      'MOSS_TUI_LOCAL_SHELL',
      'MOSS_OVERFLOW_PATTERNS',
      'MOSS_HOOK_EVENT',
    ],
  },
  {
    group: 'ui, logging & notifications',
    vars: [
      'MOSS_NO_TUI',
      'MOSS_TUI_DEBUG',
      'MOSS_TUI_HW_CURSOR',
      'MOSS_TUI_INCREMENTAL',
      'MOSS_TUI_RENDERER',
      'MOSS_TUI_RENDERER_CONFIG',
      'MOSS_TUI_THEME',
      'MOSS_LANG (auto|en|zh; process env or --lang; a project .env cannot set this; flag > env > config language > system locale)',
      'MOSS_NO_COLOR',
      'MOSS_LOG_LEVEL',
      'MOSS_LOG_JSON',
      'MOSS_SHOW_THINKING',
      'MOSS_CLI_DETAIL',
      'MOSS_VERBOSE_CLI',
      'MOSS_VERBOSE_TOOLS',
      'MOSS_QUIET',
      'MOSS_NOTIFY',
    ],
  },
  {
    group: 'network & telemetry',
    vars: ['MOSS_TELEMETRY_ALLOW', 'MOSS_WEB_SEARCH_VARIATION_LIMIT'],
  },
  {
    group: 'test-only',
    vars: ['MOSS_TEST_PIPED_STDIN_CAP'],
  },
  {
    group: 'read but IGNORED (model settings are config-only)',
    vars: ['MOSS_PROVIDER', 'MOSS_MODEL', 'MOSS_BASE_URL', 'MOSS_API_KEY'],
  },
];

const ENV_GROUP_ZH: Record<string, string> = {
  'config & identity': '配置与身份',
  'safety & approval (v0.26: these are MODE overrides — read-only arms the read-only ceiling, never/ full, prompt/manual; rules live in permissions.*, not env)':
    '安全与审批（这些是模式覆盖：只读会打开只读上限，从不询问对应完全访问，每次询问对应手动确认；规则在权限表里，不在环境变量里）',
  'runs, loops & budgets': '运行、循环与预算',
  'device (robotics closed loop)': '设备（机器人闭环）',
  'context & compaction': '上下文与压缩',
  'providers, models & fallback': '服务商、模型与回退',
  'tools, exec & guardrails': '工具、执行与护栏',
  'ui, logging & notifications': '界面、日志与通知',
  'network & telemetry': '网络与遥测',
  'test-only': '仅测试',
  'read but IGNORED (model settings are config-only)': '会读到但忽略（模型设置只来自配置）',
};

const ENV_NOTE_ZH: Record<string, string> = {
  'process env only; a project .env cannot set this': '仅进程环境；项目 .env 不能设置',
  'process env or --config-file; a project .env cannot set this':
    '进程环境或 --config-file；项目 .env 不能设置',
  'legacy alias of MOSS_CONFIG_FILE; a project .env cannot set this':
    'MOSS_CONFIG_FILE 的旧别名；项目 .env 不能设置',
  'legacy alias of MOSS_PROFILE; a project .env cannot set this':
    'MOSS_PROFILE 的旧别名；项目 .env 不能设置',
  'project .env applies only after that folder is trusted': '项目 .env 仅在该文件夹被信任后生效',
  'legacy alias of MOSS_SAFETY_MODE': 'MOSS_SAFETY_MODE 的旧别名',
  'legacy alias of MOSS_APPROVAL_POLICY': 'MOSS_APPROVAL_POLICY 的旧别名',
  'legacy — translated to allow rules on read': '旧键 — 读取时译成允许规则',
  'legacy — translated to deny rules on read': '旧键 — 读取时译成拒绝规则',
  'legacy alias of MOSS_CLI_AUTO_APPROVE': 'MOSS_CLI_AUTO_APPROVE 的旧别名',
  'comma-separated nudge ids to suppress; unset leaves every nudge on':
    '逗号分隔的要关掉的提示编号；不设置则全部开启',
  '1 enables the /plan approval gate; default off': '设为 1 打开 /plan 审批门；默认关闭',
  'prefix of the MOSS_BUDGET_MAX_* keys': 'MOSS_BUDGET_MAX_* 键的前缀',
  '1 enables the project-local experience experiment': '设为 1 打开项目本地经验实验',
  'full|1|true|yes opts this process into destructive device operations':
    'full|1|true|yes 让本进程允许毁灭性设备操作',
  '1|true|yes|on; process env or --trust-workspace only, never a project .env':
    '1|true|yes|on；仅进程环境或 --trust-workspace，不能写进项目 .env',
  'comma-separated host or device-id allowlist': '逗号分隔的主机或设备标识允许列表',
  'prefix of every MOSS_DEVICE_* key': '所有 MOSS_DEVICE_* 键的前缀',
  '1|true|yes|on skips the built-in rdk-docs MCP server':
    '1|true|yes|on 跳过内置 rdk-docs MCP 服务器',
  '1 waits for the in-flight MCP connect before shutdown; default does not':
    '设为 1 时，退出前等待进行中的 MCP 连接；默认不等待',
  'npm spec or local path; process env only, not project config or .env':
    'npm 规格或本地路径；仅进程环境，不是项目配置或 .env',
  '1|true|yes|on asks npm if rdk-docs-mcp latest is newer than the pin; off by default, not used at startup':
    '1|true|yes|on 向 npm 查询 rdk-docs-mcp 的 latest 是否新于钉住的版本；默认关闭，启动时不用',
  '0 stops acceptance commands from appending the login-shell PATH':
    '设为 0 时，验收命令不再追加登录 shell 的 PATH',
  'legacy alias': '旧别名',
  'auto|en|zh; process env or --lang; a project .env cannot set this; flag > env > config language > system locale':
    'auto|en|zh；进程环境或 --lang；项目 .env 不能设置；优先级为参数、环境变量、配置 language、系统区域',
  'checkout for moss update; --dir wins': 'moss update 要升级的克隆；--dir 优先',
};

function localizeEnvEntry(entry: string): string {
  if (!isZhLocale()) return entry;
  const withLimit = entry.replace(WORKSPACE_WRITE_LIMIT_EN, WORKSPACE_WRITE_LIMIT_ZH);
  return withLimit.replace(/\(([^)]*)\)/g, (full, inner: string) => {
    const note = ENV_NOTE_ZH[inner];
    if (note) return `（${note}）`;
    if (/[\u4e00-\u9fff]/.test(inner)) return `（${inner}）`;
    return full;
  });
}

export function renderConfigEnv(): string {
  const zh = isZhLocale();
  const lines: string[] = [
    zh ? 'Moss 实际读取的 MOSS_* 环境变量：' : 'MOSS_* environment variables moss actually reads:',
  ];
  for (const { group, vars } of MOSS_ENV_REFERENCE) {
    lines.push('', `  ${zh ? (ENV_GROUP_ZH[group] ?? group) : group}`);
    for (const v of vars) lines.push(`    ${localizeEnvEntry(v)}`);
  }
  lines.push(
    '',
    zh
      ? '凭据放在配置文件或服务商自己的密钥变量里 — 不要写进命令历史。'
      : 'Credentials belong in the config file or a provider-specific key var — never in shell history.',
    zh
      ? '审批、配置档、目标验收、信任、脱敏、钩子和工具权限变量只认真实进程环境和命令行。项目或上级目录的 .env 不能设置它们。'
      : 'Approval, profile, goal-verify, trust, redaction, hook, and tool-permission variables are read from the real process environment and CLI flags only. A project or ancestor .env cannot set them.'
  );
  return lines.join('\n');
}

export function runConfigEnv(): void {
  standardOutput.write(`${renderConfigEnv()}\n`);
}

/** Full reference — the single home for settable keys and examples. */
export function renderConfigHelp(zh = false): string {
  if (zh) return renderConfigHelpZh();
  return [
    'Usage:',
    '  moss config',
    '  moss config init [--project] [--force]',
    '  moss config show',
    '  moss config show --json',
    '  moss config validate [--strict] [--json]',
    '  moss config set <provider|model|baseUrl|apiKey|apiKeyEnv> <value>              # model',
    '  moss config set <profile|safetyMode|approvalPolicy|trustedTools|deniedTools|promptCache|promptCacheDebug|guardrails.*|agent.*> <value>   # operational',
    '  moss config set <key>=<value> [<key>=<value>...]                               # batch',
    '  moss config set --project <key>=<value> [<key>=<value>...]',
    '  moss config set --project <key> <value>',
    '  moss config unset <key>',
    '  moss config unset --project <key>',
    '',
    'Config file:',
    '  Without an explicit file, Moss reads the user config and merges',
    '  .moss/config.json from the current workspace as project defaults.',
    '  --config-file and MOSS_CONFIG_FILE load only that file; the project',
    '  .moss/config.json layer is not loaded.',
    '  moss --config-file /path/to/config.json config show',
    '  set MOSS_CONFIG_FILE=/path/to/config.json to use an explicit config file',
    '',
    'Examples:',
    '  moss config init --project',
    '  moss config validate --strict',
    '  moss config set profile autonomous',
    '  moss config set provider openai-compatible',
    '  moss config set model <your-model>',
    '  moss config set baseUrl https://your-gateway.example   # API root, not /v1 or /chat/completions',
    '  moss setup                                     # stores the API key (hidden prompt, safer than command line)',
    '  moss config set --project safetyMode workspace-write',
    `  # ${WORKSPACE_WRITE_LIMIT_EN}`,
    '  moss config set approvalPolicy prompt',
    '  moss config set trustedTools exec,filesystem__*',
    '  moss config set deniedTools write_file,exec',
    '  moss config set guardrails.input.redactPatterns SECRET=[^\\\\s]+',
    '  moss config set agent.maxTurns 96',
    '  moss config set agent.contextTokens 200000',
    '  moss config set agent.compaction.reserveTokens 20000',
    '  moss config set rdkDocs false',
    '  moss config set rdkDocs.package ../rdk-docs-mcp',
    '  moss config set language auto|en|zh   # user config only (not --project, not a project .env)',
    '  # UI language precedence: --lang > MOSS_LANG > language > system locale. auto = zh only when the locale starts with zh.',
    '',
    'Options:',
    '  --project              init/set/unset write .moss/config.json in the workspace',
    '  --force                init overwrites an existing config file',
    '  --json                 machine-readable show or validate output',
    '  --strict               validate fails on warnings',
    '  --config-file <path>   load only that file; the project layer is not merged',
  ].join('\n');
}

function renderConfigHelpZh(): string {
  return [
    '用法：',
    '  moss config',
    '  moss config init [--project] [--force]',
    '  moss config show',
    '  moss config show --json',
    '  moss config validate [--strict] [--json]',
    '  moss config set <provider|model|baseUrl|apiKey|apiKeyEnv> <值>',
    '  moss config set <profile|safetyMode|approvalPolicy|trustedTools|deniedTools|promptCache|promptCacheDebug|guardrails.*|agent.*> <值>',
    '  moss config set <key>=<值> [<key>=<值>...]',
    '  moss config set --project <key>=<值> [<key>=<值>...]',
    '  moss config unset <key>',
    '  moss config unset --project <key>',
    '',
    '配置文件：',
    '  未指定文件时，Moss 读取用户配置，并把当前工作区的',
    '  .moss/config.json 当作项目默认值合并。',
    '  --config-file 与 MOSS_CONFIG_FILE 只加载那个文件，',
    '  项目 .moss/config.json 这一层不会进入本次配置。',
    '',
    '选项：',
    '  --project              init/set/unset 写入工作区 .moss/config.json',
    '  --force                init 覆盖已有配置文件',
    '  --json                 show / validate 的机器可读输出',
    '  --strict               validate 把警告也当成失败',
    '  --config-file <path>   只加载该文件，不合并项目层',
    '',
    '示例：',
    '  moss config init --project',
    '  moss config validate --strict',
    '  `moss config set --project safetyMode workspace-write`',
    `  # ${WORKSPACE_WRITE_LIMIT_ZH}`,
    '  `moss config set provider openai-compatible`',
    '  `moss config set model <模型>`',
    '  `moss config set rdkDocs false`',
    '  `moss config set rdkDocs.package ../rdk-docs-mcp`',
    '  `moss config set language auto|en|zh`   # 只写用户配置（不能 --project，项目 .env 也不能设置）',
    '  # 界面语言优先级：--lang > MOSS_LANG > `language` > 系统区域。auto 仅在区域以 zh 开头时用中文。',
  ].join('\n');
}

export function runConfigShow(
  startDir = process.cwd(),
  options: { json?: boolean; overrides?: CliConfigOverrides } = {}
): void {
  const overrides = options.overrides ?? {};
  if (options.json) {
    standardOutput.write(`${renderConfigJson(undefined, process.env, startDir, overrides)}\n`);
    return;
  }

  standardOutput.write(
    `${renderAuthStatus(undefined, process.env, startDir, overrides, '[config]')}\n`
  );
}

export function runConfigValidate(args: string[] = [], startDir = process.cwd()): void {
  let json = false;
  let strict = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else {
      print(renderConfigUsage());
      process.exitCode = 1;
      return;
    }
  }

  const loaded = loadCliConfigFile(process.env, process.argv.slice(2), startDir);
  const resolved = resolveCliConfig(process.env, loaded.config, {}, loaded);
  const warnings = [...auditResolvedCliConfig(resolved)];
  for (const value of [loaded.userConfig?.language, loaded.projectConfig?.language]) {
    if (typeof value !== 'string' || value.trim() === '' || parseLanguageSetting(value)) continue;
    warnings.push({
      code: 'language.invalid',
      severity: 'warn',
      source: 'config',
      message: uiText(
        `language "${value}" is not auto|en|zh`,
        `语言「${value}」不是 auto、en 或 zh`
      ),
    });
  }
  if (!resolved.usingBundledDefault && !resolved.model) {
    warnings.push({
      code: 'model.missing',
      severity: 'warn',
      source: 'default',
      message: uiText(
        `no model configured for provider "${resolved.provider}"; run \`moss config set model=<name>\` or \`moss setup\``,
        `服务商「${resolved.provider}」没有配置模型；运行 \`moss config set model=<name>\` 或 \`moss setup\``
      ),
    });
  }
  if (!resolved.usingBundledDefault && !resolved.apiKey) {
    warnings.push({
      code: 'model.missing_api_key',
      severity: 'warn',
      source: 'default',
      message: uiText(
        `no API key configured for provider "${resolved.provider}"; moss will fail at runtime — run \`moss setup\` to add one`,
        `服务商「${resolved.provider}」没有配置 API key；运行时会失败 — 运行 \`moss setup\` 补上`
      ),
    });
  }
  // v0.26 (T04): validate the permissions block — spec syntax per rule and
  // the defaultMode enum (through the policy layer's own parser).
  {
    const permissions = loaded.config.permissions;
    if (permissions) {
      if (permissions.defaultMode !== undefined) {
        const mode = parseCliInteractionMode(String(permissions.defaultMode));
        if (!mode) {
          warnings.push({
            code: 'permissions.default_mode',
            severity: 'warn',
            source: 'config',
            message: `permissions.defaultMode "${permissions.defaultMode}" is not a mode; expected manual | acceptEdits | plan | full`,
          });
        }
      }
      if (
        permissions.deviceTrust !== undefined &&
        permissions.deviceTrust !== 'full' &&
        permissions.deviceTrust !== 'gated'
      ) {
        warnings.push({
          code: 'permissions.device_trust',
          severity: 'warn',
          source: 'config',
          message: `permissions.deviceTrust "${permissions.deviceTrust}" is not full or gated`,
        });
      }
      for (const level of ['allow', 'ask', 'deny'] as const) {
        for (const spec of permissions[level] ?? []) {
          try {
            parsePermissionRuleSpec(spec, 'user', level);
          } catch (err) {
            warnings.push({
              code: `permissions.${level}`,
              severity: 'warn',
              source: 'config',
              message: `invalid ${level} rule "${spec}": ${errorMessage(err)}`,
            });
          }
        }
      }
    }
  }
  if (strict && warnings.length > 0) process.exitCode = 1;

  if (json) {
    standardOutput.write(
      `${JSON.stringify(serializeConfigValidation(resolved, { strict, extraWarnings: warnings }), null, 2)}\n`
    );
    return;
  }

  if (isZhLocale()) {
    print(`[配置] 有效 ${resolved.configPath}`);
    if (resolved.projectConfigPath) print(`[配置] 项目配置 ${resolved.projectConfigPath}`);
    if (warnings.length === 0) {
      print('[配置] 警告 无');
      return;
    }
    for (const warning of warnings) {
      print(`[配置] 警告 ${warning.code}：${warning.message}`);
    }
    if (strict) print('[配置] 严格校验失败，因为存在警告。');
    return;
  }
  print(`[config] valid: ${resolved.configPath}`);
  if (resolved.projectConfigPath) print(`[config] project config: ${resolved.projectConfigPath}`);
  if (warnings.length === 0) {
    print('[config] warnings: none');
    return;
  }
  for (const warning of warnings) {
    print(`[config] warning ${warning.code}: ${warning.message}`);
  }
  if (strict) print('[config] strict validation failed because warnings are present.');
}

function resolveConfigEditTarget(
  args: string[],
  startDir: string
): { args: string[]; configPath: string; scope: 'user' | 'project' } {
  if (args[0] !== '--project') {
    return { args, configPath: resolveConfigPath(), scope: 'user' };
  }
  const root = path.resolve(startDir);
  return {
    args: args.slice(1),
    configPath: resolveProjectConfigPath(root) ?? path.join(root, '.moss', 'config.json'),
    scope: 'project',
  };
}

function resolveConfigInitTarget(
  args: string[],
  startDir: string
): { configPath: string; scope: 'user' | 'project'; force: boolean } | null {
  let scope: 'user' | 'project' = 'user';
  let force = false;
  for (const arg of args) {
    if (arg === '--project') {
      scope = 'project';
    } else if (arg === '--force') {
      force = true;
    } else {
      print(renderConfigUsage());
      process.exitCode = 1;
      return null;
    }
  }
  const root = path.resolve(startDir);
  return {
    scope,
    force,
    configPath:
      scope === 'project'
        ? (resolveProjectConfigPath(root) ?? path.join(root, '.moss', 'config.json'))
        : resolveConfigPath(),
  };
}

function buildUserConfigTemplate(): ConfigFile {
  const resolved = resolveCliConfig(process.env, {});
  return removeEmptyNestedConfig({
    profile: resolved.profile,
    provider: resolved.provider,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    workspace: resolved.workspaceSource === 'cwd' ? undefined : resolved.workspace,
    safetyMode: resolved.safetyMode,
    approvalPolicy: resolved.approvalPolicy,
    trustedTools: [...resolved.trustedTools],
    deniedTools: [...resolved.deniedTools],
    promptCache: {
      enabled: resolved.promptCacheEnabled,
      debug: resolved.promptCacheDebug,
    },
    agent: {
      maxTurns: resolved.maxAgentTurns,
      contextTokens: resolved.contextTokens,
      compaction: { ...resolved.compactionSettings },
    },
    _examples: {
      customModel: {
        provider: 'openai-compatible',
        baseUrl: 'https://your-gateway.example',
        model: 'your-model-name',
        apiKey: 'paste-your-api-key',
      },
    },
  });
}

function buildProjectConfigTemplate(): ConfigFile {
  const resolved = resolveCliConfig(process.env, {});
  return removeEmptyNestedConfig({
    profile: resolved.profile,
    safetyMode: resolved.safetyMode,
    approvalPolicy: resolved.approvalPolicy,
    trustedTools: [...resolved.trustedTools],
    deniedTools: [...resolved.deniedTools],
    promptCache: {
      enabled: resolved.promptCacheEnabled,
      debug: resolved.promptCacheDebug,
    },
    agent: {
      maxTurns: resolved.maxAgentTurns,
      contextTokens: resolved.contextTokens,
      compaction: { ...resolved.compactionSettings },
    },

    _examples: {
      customModel: {
        _comment: 'set these via moss config set --project provider|model|baseUrl <value>',
        _apiKey: 'use moss setup for the key (hidden prompt); stored in config file (0600)',
      },
    },
  });
}

function supportedConfigKeys(): string {
  return uiText(
    'Supported keys — model: provider, model, baseUrl, apiKey, apiKeyEnv; operational: profile, workspace, safetyMode, approvalPolicy, trustedTools, deniedTools, permissions.defaultMode, permissions.allow, permissions.ask, permissions.deny, permissions.deviceTrust, permissions.trustedDevices, rdkDocs, rdkDocs.enabled, rdkDocs.package, promptCache, promptCacheDebug, guardrails.input.blockPatterns, guardrails.input.redactPatterns, guardrails.output.blockPatterns, guardrails.output.redactPatterns, agent.maxTurns, agent.contextTokens, agent.compaction.reserveTokens, agent.compaction.keepRecentTokens, language',
    '支持的键：provider、model、baseUrl、apiKey、apiKeyEnv、profile、workspace、safetyMode、approvalPolicy、trustedTools、deniedTools、permissions.defaultMode、permissions.allow、permissions.ask、permissions.deny、permissions.deviceTrust、permissions.trustedDevices、rdkDocs、rdkDocs.enabled、rdkDocs.package、promptCache、promptCacheDebug、guardrails.input.blockPatterns、guardrails.input.redactPatterns、guardrails.output.blockPatterns、guardrails.output.redactPatterns、agent.maxTurns、agent.contextTokens、agent.compaction.reserveTokens、agent.compaction.keepRecentTokens、language'
  );
}

function configHelpHint(): string {
  return uiText(
    'Run `moss config --help` for supported keys and usage.',
    '运行 `moss config --help` 查看支持的键和用法。'
  );
}

function removeEmptyNestedConfig(config: ConfigFile): ConfigFile {
  const next = { ...config };
  if (
    next.promptCache &&
    typeof next.promptCache === 'object' &&
    Object.keys(next.promptCache).length === 0
  ) {
    delete next.promptCache;
  }
  if (next.agent?.compaction && Object.keys(next.agent.compaction).length === 0) {
    next.agent = { ...next.agent };
    delete next.agent.compaction;
  }
  if (next.agent && Object.keys(next.agent).length === 0) {
    delete next.agent;
  }
  if (next.guardrails) {
    const guardrails = { ...next.guardrails };
    if (guardrails.input && Object.keys(guardrails.input).length === 0) delete guardrails.input;
    if (guardrails.output && Object.keys(guardrails.output).length === 0) delete guardrails.output;
    if (Object.keys(guardrails).length === 0) delete next.guardrails;
    else next.guardrails = guardrails;
  }
  if (
    typeof next.rdkDocs === 'object' &&
    next.rdkDocs !== null &&
    Object.keys(next.rdkDocs).length === 0
  ) {
    delete next.rdkDocs;
  }
  return next;
}

export function runConfigInit(args: string[], startDir = process.cwd()): void {
  const target = resolveConfigInitTarget(args, startDir);
  if (!target) return;
  if (fs.existsSync(target.configPath) && !target.force) {
    print(
      uiText(
        `[config] ${target.configPath} already exists. Use --force to overwrite.`,
        `[配置] ${target.configPath} 已存在。加上 --force 可以覆盖。`
      )
    );
    process.exitCode = 1;
    return;
  }
  const template =
    target.scope === 'project' ? buildProjectConfigTemplate() : buildUserConfigTemplate();
  saveConfigFileAtPath(template, target.configPath);
  const scope = target.scope === 'project' ? 'project ' : '';
  print(
    uiText(
      `[config] ${scope}config initialized in ${target.configPath}`,
      target.scope === 'project'
        ? `[配置] 项目配置已初始化：${target.configPath}`
        : `[配置] 配置已初始化：${target.configPath}`
    )
  );
}

function applyConfigSetPair(
  next: ConfigFile,
  current: ConfigFile,
  key: string,
  value: string
): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  if (key === 'language') {
    const setting = parseLanguageSetting(value);
    if (!setting) {
      return {
        ok: false,
        messages: [
          uiText('Supported language values: auto, en, zh', 'language 只能是 auto、en 或 zh。'),
        ],
      };
    }
    next.language = setting;
  } else if (key === 'profile') {
    const profile = normalizeConfigProfile(value);
    if (!profile) {
      return { ok: false, messages: ['Supported profile values: cautious, balanced, autonomous'] };
    }
    next.profile = profile;
    // v0.26 (T04): deprecated write-side notice — the read side migrates
    // profile → defaultMode; the write stays for one release (PRD 决策 5).
    messages.push(
      '[config] NOTE: profile is a legacy key (deprecated next release) — cautious→manual(+read-only ceiling), balanced→manual, autonomous→full. Prefer `permissions.defaultMode`.'
    );
  } else if (key === 'provider') {
    const provider = parseProviderPreset(value);
    if (!provider) {
      return {
        ok: false,
        messages: [
          `Unknown provider: ${value}`,
          'Supported provider values: deepseek, qwen, openai, anthropic, openai-compatible, d-robotics',
          configHelpHint(),
        ],
      };
    }
    next.provider = provider;
    const existingModel = ((next.model ?? '') as string).toLowerCase().trim();
    if (existingModel && provider !== 'openai-compatible') {
      const guessed = guessModelProvider(existingModel);
      if (
        guessed &&
        guessed !== provider &&
        !(provider === 'd-robotics' && guessed === 'deepseek')
      ) {
        messages.push(
          `[config] Warning: model "${existingModel}" looks like a ${PROVIDER_PRESETS[guessed].displayName} model, but provider is ${PROVIDER_PRESETS[provider].displayName}. Mismatch?`
        );
      }
    }
  } else if (key === 'model') {
    next.model = value;
    const resolvedProvider = next.provider ?? current.provider;
    if (resolvedProvider && resolvedProvider !== 'openai-compatible') {
      const guessed = guessModelProvider(value);
      if (
        guessed &&
        guessed !== resolvedProvider &&
        !(resolvedProvider === 'd-robotics' && guessed === 'deepseek')
      ) {
        messages.push(
          `[config] Warning: model "${value}" looks like a ${PROVIDER_PRESETS[guessed].displayName} model, but provider is ${PROVIDER_PRESETS[resolvedProvider as CliProviderPreset].displayName}. Mismatch?`
        );
      }
    }
  } else if (key === 'apiKey') {
    next.apiKey = value;
  } else if (key === 'apiKeyEnv') {
    const name = value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return {
        ok: false,
        messages: [
          'apiKeyEnv must be an environment variable name (letters, digits, and underscore). The value is the name, not the key.',
        ],
      };
    }
    next.apiKeyEnv = name;
  } else if (key === 'baseUrl') {
    if (!isHttpUrl(value)) {
      return {
        ok: false,
        messages: [
          `Invalid baseUrl: ${value.trim()}`,
          'baseUrl must be a full http(s) URL, e.g. https://your-gateway.example (API root, no /v1)',
        ],
      };
    }
    const sanitized = sanitizeBaseUrl(value);
    const wasNormalized = sanitized !== value.trim().replace(/\/+$/, '');
    if (wasNormalized) {
      messages.push(`[config] baseUrl normalized to API root: ${sanitized}`);
      messages.push(
        '[config] (Moss appends /v1/chat/completions itself — endpoint paths, query strings, and credentials are stripped.)'
      );
    }
    next.baseUrl = sanitized;
  } else if (key === 'workspace') {
    next.workspace = path.resolve(value);
  } else if (key === 'permissions.defaultMode') {
    // v0.26 (T04): the canonical mode knob. Validates against the mode enum
    // through the policy layer's own parser (aliases accepted, resolved and
    // stored as the canonical name).
    const mode = parseCliInteractionMode(value);
    if (!mode) {
      return {
        ok: false,
        messages: [
          'Supported permissions.defaultMode values: manual, acceptEdits, plan, full',
          '(accepted aliases: default/d/normal, accept-edits, plan, full/bypass)',
        ],
      };
    }
    next.permissions = { ...next.permissions, defaultMode: mode };
  } else if (key === 'permissions.deviceTrust') {
    const trust = value.trim().toLowerCase();
    if (trust !== 'full' && trust !== 'gated') {
      return {
        ok: false,
        messages: ['Supported permissions.deviceTrust values: gated, full'],
      };
    }
    next.permissions = { ...next.permissions, deviceTrust: trust };
  } else if (key === 'permissions.trustedDevices') {
    if (!setPermissionsKey(next, key, value)) {
      return { ok: false, messages: [supportedConfigKeys()] };
    }
  } else if (
    key === 'permissions.allow' ||
    key === 'permissions.ask' ||
    key === 'permissions.deny'
  ) {
    // Array lists REPLACE the whole table (guardrails-array-key semantics).
    // Every spec is validated through the permission-rules parser first.
    const specs = parseConfigPatternList(value, key);
    try {
      const level = key.split('.')[1] as 'allow' | 'ask' | 'deny';
      for (const spec of specs) parsePermissionRuleSpec(spec, 'user', level);
    } catch (err) {
      return {
        ok: false,
        messages: [
          `Invalid rule spec: ${errorMessage(err)}`,
          'Rules look like ToolName (whole tool) or ToolName(pattern), e.g. exec(npm run *)',
        ],
      };
    }
    if (!setPermissionsKey(next, key, value)) {
      return { ok: false, messages: [supportedConfigKeys()] };
    }
  } else if (key === 'safetyMode') {
    const mode = normalizeSafetyModeConfig(value);
    if (!mode) {
      return {
        ok: false,
        messages: ['Supported safetyMode values: read-only, workspace-write, full-access'],
      };
    }
    next.safetyMode = mode;
    // v0.26 (T04): deprecated write-side notice — one release of grace
    // (PRD 决策 5). The key still writes and the read side translates it.
    messages.push(
      '[config] NOTE: safetyMode is a legacy key (deprecated next release) — prefer `moss config set permissions.defaultMode=manual|acceptEdits|plan|full`.'
    );
  } else if (key === 'approvalPolicy') {
    const policy = normalizeApprovalPolicyConfig(value);
    if (!policy) {
      return { ok: false, messages: ['Supported approvalPolicy values: prompt, never'] };
    }
    next.approvalPolicy = policy;
    // v0.26 (T04): deprecated write-side notice (PRD 决策 6 收编).
    messages.push(
      '[config] NOTE: approvalPolicy is a legacy key (deprecated next release) — prefer `moss config set permissions.defaultMode=full` (never) or `=manual` (prompt).'
    );
  } else if (key === 'trustedTools') {
    try {
      const parsedTrusted = parseTrustedTools(value) ?? [];
      next.trustedTools = parsedTrusted;
      // v0.26 (T04): deprecated write-side notice + the synced translation
      // into permissions.allow (one release of grace — both surfaces stay
      // equivalent on read because the migration unions them).
      next.permissions = {
        ...next.permissions,
        allow: [...new Set([...(next.permissions?.allow ?? []), ...parsedTrusted])],
      };
      messages.push(
        '[config] NOTE: trustedTools is a legacy key (deprecated next release) — the same names were added to permissions.allow; prefer that key for new rules.'
      );
      const broad = parsedTrusted.filter(isBroadTrustedToolPattern);
      if (broad.length > 0) {
        messages.push(
          `[config] WARNING: broad trusted pattern(s) ${broad.join(', ')} auto-approve every mutating tool the safety mode allows; prefer exact tool names or narrow server__tool globs.`
        );
      }
    } catch (err) {
      return { ok: false, messages: [errorMessage(err)] };
    }
  } else if (key === 'deniedTools') {
    try {
      const parsedDenied = parseTrustedTools(value) ?? [];
      next.deniedTools = parsedDenied;
      // v0.26 (T04): deprecated write-side notice + synced translation.
      next.permissions = {
        ...next.permissions,
        deny: [...new Set([...(next.permissions?.deny ?? []), ...parsedDenied])],
      };
      messages.push(
        '[config] NOTE: deniedTools is a legacy key (deprecated next release) — the same names were added to permissions.deny; prefer that key for new rules.'
      );
    } catch (err) {
      return { ok: false, messages: [errorMessage(err)] };
    }
  } else if (key === 'rdkDocs') {
    const enabled = parseConfigBoolean(value);
    if (enabled === null) {
      return {
        ok: false,
        messages: ['Supported rdkDocs values: true/false (yes/no, on/off, 1/0 also accepted)'],
      };
    }
    next.rdkDocs = enabled;
  } else if (key === 'rdkDocs.enabled') {
    const enabled = parseConfigBoolean(value);
    if (enabled === null) {
      return {
        ok: false,
        messages: [
          'Supported rdkDocs.enabled values: true/false (yes/no, on/off, 1/0 also accepted)',
        ],
      };
    }
    const currentRdkDocs =
      typeof current.rdkDocs === 'object' && current.rdkDocs !== null ? current.rdkDocs : {};
    next.rdkDocs = { ...currentRdkDocs, enabled };
  } else if (key === 'rdkDocs.package') {
    const packageSpec = value.trim();
    if (!packageSpec) {
      return { ok: false, messages: ['rdkDocs.package must not be empty'] };
    }
    const currentRdkDocs =
      typeof current.rdkDocs === 'object' && current.rdkDocs !== null ? current.rdkDocs : {};
    next.rdkDocs = { ...currentRdkDocs, package: packageSpec };
  } else if (key === 'promptCache') {
    const enabled = parseConfigBoolean(value);
    if (enabled === null) {
      return {
        ok: false,
        messages: ['Supported promptCache values: true/false (yes/no, on/off, 1/0 also accepted)'],
      };
    }
    const previous =
      typeof next.promptCache === 'object' && next.promptCache !== null ? next.promptCache : {};
    next.promptCache = { ...previous, enabled };
  } else if (key === 'promptCacheDebug') {
    const debug = parseConfigBoolean(value);
    if (debug === null) {
      return {
        ok: false,
        messages: [
          'Supported promptCacheDebug values: true/false (yes/no, on/off, 1/0 also accepted)',
        ],
      };
    }
    const previous =
      typeof next.promptCache === 'object' && next.promptCache !== null
        ? next.promptCache
        : { enabled: typeof next.promptCache === 'boolean' ? next.promptCache : true };
    next.promptCache = { ...previous, debug };
  } else if (key.startsWith('guardrails.')) {
    try {
      if (!setGuardrailPatternList(next, key, value)) {
        return {
          ok: false,
          messages: [supportedConfigKeys(), configHelpHint()],
        };
      }
    } catch (err) {
      return { ok: false, messages: [errorMessage(err)] };
    }
  } else if (key === 'agent.maxTurns' || key === 'agent.contextTokens') {
    const parsed = parseConfigPositiveInteger(value, key);
    if (!parsed.ok) {
      return { ok: false, messages: [parsed.error] };
    }
    next.agent = { ...next.agent };
    if (key === 'agent.maxTurns') next.agent.maxTurns = parsed.value;
    else next.agent.contextTokens = parsed.value;
  } else if (
    key === 'agent.compaction.reserveTokens' ||
    key === 'agent.compaction.keepRecentTokens'
  ) {
    const parsed = parseConfigPositiveInteger(value, key);
    if (!parsed.ok) {
      return { ok: false, messages: [parsed.error] };
    }
    next.agent = {
      ...next.agent,
      compaction: {
        ...next.agent?.compaction,
      },
    };
    if (key === 'agent.compaction.reserveTokens') {
      next.agent.compaction = { ...next.agent.compaction, reserveTokens: parsed.value };
    } else {
      next.agent.compaction = { ...next.agent.compaction, keepRecentTokens: parsed.value };
    }
  } else {
    return {
      ok: false,
      messages: [supportedConfigKeys(), configHelpHint()],
    };
  }
  return { ok: true, messages };
}

export function runConfigSet(args: string[], startDir = process.cwd()): void {
  const target = resolveConfigEditTarget(args, startDir);
  args = target.args;

  const isBatch = args.length > 0 && args[0].includes('=');
  let pairs: { key: string; value: string }[];
  if (isBatch) {
    pairs = [];
    for (const arg of args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) {
        print(`Batch config set: each argument must be key=value, got "${arg}"`);
        process.exitCode = 1;
        return;
      }
      pairs.push({ key: arg.slice(0, eqIdx), value: arg.slice(eqIdx + 1) });
    }
  } else {
    const [key, ...rest] = args;
    const value = rest.join(' ').trim();
    if (!key) {
      print(renderConfigUsage());
      process.exitCode = 1;
      return;
    }
    if (!value) {
      print(
        `config ${key}: value must not be empty. Run \`moss config --help\` for supported keys and usage.`
      );
      process.exitCode = 1;
      return;
    }

    if (rest.length > 1) {
      print(
        `config set: "${key}" takes a single value (got ${rest.length}). Quote it if it contains spaces: moss config set ${key} "${value}".`
      );
      process.exitCode = 1;
      return;
    }
    pairs = [{ key, value }];
  }

  if (target.scope === 'project' && pairs.some((pair) => pair.key === 'language')) {
    print(
      uiText(
        'language is a user setting. Omit --project (`moss config set language auto|en|zh`). A project config and a project .env cannot set it.',
        'language 只能写在用户配置里。去掉 --project（`moss config set language auto|en|zh`）。项目配置和项目 .env 不能设置它。'
      )
    );
    process.exitCode = 1;
    return;
  }

  const current = loadConfigFile(target.configPath);
  const next = { ...current };
  const allMessages: string[] = [];
  let apiKeySet = false;

  for (const { key, value } of pairs) {
    if (!value) {
      print(
        `config ${key}: value must not be empty. Run \`moss config --help\` for supported keys and usage.`
      );
      process.exitCode = 1;
      return;
    }
    const result = applyConfigSetPair(next, current, key, value);
    if (!result.ok) {
      for (const msg of result.messages) print(msg);
      if (isBatch) print('[config] nothing saved — fix the error above and retry the batch.');
      process.exitCode = 1;
      return;
    }
    allMessages.push(...result.messages);
    if (key === 'apiKey') apiKeySet = true;
  }

  saveConfigFileAtPath(next, target.configPath);
  const scope = target.scope === 'project' ? 'project ' : '';
  const zh = isZhLocale();
  if (isBatch) {
    const keyList = pairs.map((p) => p.key).join(', ');
    print(
      zh
        ? `[config] ${scope}已更新 ${pairs.length} 项，文件 ${target.configPath}：${keyList}`
        : `[config] ${scope}updated ${pairs.length} key(s) in ${target.configPath}: ${keyList}`
    );
  } else {
    print(
      zh
        ? `[config] ${scope}${pairs[0].key} 已更新，文件 ${target.configPath}`
        : `[config] ${scope}${pairs[0].key} updated in ${target.configPath}`
    );
  }
  for (const msg of allMessages) print(msg);
  if (pairs.some((p) => p.key === 'baseUrl')) {
    print(zh ? `[config] 地址已保存：${next.baseUrl}` : `[config] baseUrl saved: ${next.baseUrl}`);
  }
  if (apiKeySet) {
    print(
      zh
        ? `[config] API key 已存入配置文件（0600）：${target.configPath}。`
        : `[config] API key stored in config file (0600) at ${target.configPath}.`
    );
    print(
      zh
        ? '[config] 注意：key 是从命令行传入的，可能留在 shell 历史里；下次用 `moss setup` 可以隐藏输入。'
        : '[config] NOTE: the key was sent via command line and may be in your shell history; for a hidden prompt, use `moss setup` next time.'
    );
  }
}

export function runConfigUnset(args: string[], startDir = process.cwd()): void {
  const target = resolveConfigEditTarget(args, startDir);
  args = target.args;
  const [key, ...rest] = args;
  if (!key || rest.length > 0) {
    print(renderConfigUsage());
    process.exitCode = 1;
    return;
  }
  if (key === 'language' && target.scope === 'project') {
    print(
      uiText(
        'language is a user setting. Omit --project (`moss config unset language`). A project config cannot set it.',
        'language 只能写在用户配置里。去掉 --project（`moss config unset language`）。项目配置不能设置它。'
      )
    );
    process.exitCode = 1;
    return;
  }
  const current = loadConfigFile(target.configPath);
  let next: ConfigFile = { ...current };
  if (key === 'language') delete next.language;
  else if (key === 'profile') delete next.profile;
  else if (key === 'provider') delete next.provider;
  else if (key === 'model') delete next.model;
  else if (key === 'baseUrl') delete next.baseUrl;
  else if (key === 'apiKey') delete next.apiKey;
  else if (key === 'apiKeyEnv') delete next.apiKeyEnv;
  else if (key === 'workspace') delete next.workspace;
  else if (key === 'safetyMode') delete next.safetyMode;
  else if (key === 'approvalPolicy') delete next.approvalPolicy;
  else if (key === 'trustedTools') delete next.trustedTools;
  else if (key === 'deniedTools') delete next.deniedTools;
  else if (key === 'rdkDocs') delete next.rdkDocs;
  else if (key === 'rdkDocs.enabled' && typeof next.rdkDocs === 'object') {
    next.rdkDocs = { ...next.rdkDocs };
    delete next.rdkDocs.enabled;
  } else if (key === 'rdkDocs.package' && typeof next.rdkDocs === 'object') {
    next.rdkDocs = { ...next.rdkDocs };
    delete next.rdkDocs.package;
  } else if (key === 'permissions.deviceTrust') {
    next.permissions = { ...current.permissions };
    delete next.permissions.deviceTrust;
  } else if (key === 'permissions.trustedDevices') {
    next.permissions = { ...current.permissions };
    delete next.permissions.trustedDevices;
  } else if (key === 'promptCache') {
    if (typeof current.promptCache === 'object' && current.promptCache !== null) {
      next.promptCache = { ...current.promptCache };
      delete next.promptCache.enabled;
    } else {
      delete next.promptCache;
    }
  } else if (key === 'promptCacheDebug') {
    if (typeof current.promptCache === 'object' && current.promptCache !== null) {
      next.promptCache = { ...current.promptCache };
      delete next.promptCache.debug;
    }
  } else if (key === 'guardrails.input.blockPatterns') {
    next.guardrails = { ...current.guardrails, input: { ...current.guardrails?.input } };
    delete next.guardrails.input?.blockPatterns;
  } else if (key === 'guardrails.input.redactPatterns') {
    next.guardrails = { ...current.guardrails, input: { ...current.guardrails?.input } };
    delete next.guardrails.input?.redactPatterns;
  } else if (key === 'guardrails.output.blockPatterns') {
    next.guardrails = { ...current.guardrails, output: { ...current.guardrails?.output } };
    delete next.guardrails.output?.blockPatterns;
  } else if (key === 'guardrails.output.redactPatterns') {
    next.guardrails = { ...current.guardrails, output: { ...current.guardrails?.output } };
    delete next.guardrails.output?.redactPatterns;
  } else if (key === 'agent.maxTurns') {
    next.agent = { ...current.agent };
    delete next.agent.maxTurns;
  } else if (key === 'agent.contextTokens') {
    next.agent = { ...current.agent };
    delete next.agent.contextTokens;
  } else if (key === 'agent.compaction.reserveTokens') {
    next.agent = { ...current.agent, compaction: { ...current.agent?.compaction } };
    delete next.agent.compaction?.reserveTokens;
  } else if (key === 'agent.compaction.keepRecentTokens') {
    next.agent = { ...current.agent, compaction: { ...current.agent?.compaction } };
    delete next.agent.compaction?.keepRecentTokens;
  } else {
    print(supportedConfigKeys());
    print(configHelpHint());
    process.exitCode = 1;
    return;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  next = removeEmptyNestedConfig(next);
  saveConfigFileAtPath(next, target.configPath);
  const scope = target.scope === 'project' ? 'project ' : '';
  if (changed) {
    print(`[config] ${scope}${key} removed from ${target.configPath}`);
  } else {
    print(`[config] ${scope}${key}: not set (nothing to remove)`);
  }
}
