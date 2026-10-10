/**
 * One renderer for the resolved-config snapshot. Every diagnostic view —
 * /status --verbose, /permissions --verbose, `moss auth status` — prints its
 * fields from here, so values and sources cannot drift between views.
 */
import { auditResolvedCliConfig, BASE_URL, type ResolvedCliConfig } from './config.js';
import { buildApiV1Url } from '../provider/api-v1-url.js';
import { isZhLocale, uiText } from './cli-locale.js';
import { label } from './ui.js';
import { workspaceWriteLimit } from './workspace-write-copy.js';

export interface GuardrailCounts {
  input: number;
  output: number;
}

export function guardrailCounts(config: ResolvedCliConfig): GuardrailCounts {
  const g = config.guardrails;
  return {
    input: (g?.input?.blockPatterns?.length ?? 0) + (g?.input?.redactPatterns?.length ?? 0),
    output: (g?.output?.blockPatterns?.length ?? 0) + (g?.output?.redactPatterns?.length ?? 0),
  };
}

export function guardrailSummary(config: ResolvedCliConfig): string {
  const { input, output } = guardrailCounts(config);
  if (input === 0 && output === 0)
    return `${displayWord('none')} ${sourceNote(config.guardrailsSource)}`;
  return isZhLocale()
    ? `输入 ${input}，输出 ${output} ${sourceNote(config.guardrailsSource)}`
    : `input ${input}, output ${output} ${sourceNote(config.guardrailsSource)}`;
}

export function configAuditSummary(config: ResolvedCliConfig): string {
  const warnings = auditResolvedCliConfig(config);
  if (warnings.length === 0) return displayWord('none');
  return warnings.map((warning) => `${warning.code}: ${warning.message}`).join('; ');
}

export function withoutSecret(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value || (isZhLocale() ? '（未配置）' : '(not configured)');
  }
}

function apiKeyValue(c: ResolvedCliConfig): string {
  const zh = isZhLocale();
  if (c.apiKeySource?.startsWith('env:')) {
    const name = c.apiKeySource.slice('env:'.length);
    return zh ? `环境变量 $${name}` : `environment variable $${name}`;
  }
  if (!c.apiKey) return zh ? '未配置 — 运行 `moss setup`' : 'missing — run `moss setup`';
  if (c.apiKeySource === 'built-in') {
    return zh ? '内置网关（共享 key）' : 'configured via built-in (shared gateway key)';
  }
  return zh
    ? `来自 ${c.apiKeySource}，${c.apiKeyEncrypted ? '已存入配置文件（0600）' : '明文'}`
    : `configured via ${c.apiKeySource}, ${
        c.apiKeyEncrypted ? 'stored in config file (0600)' : 'plain text'
      }`;
}

const ZH_FIELD: Record<string, string> = {
  'config file': '配置文件',
  'project config': '项目配置',
  provider: '服务商',
  model: '模型',
  'base URL': '地址',
  'api key': 'API key',
  profile: '配置档',
  safety: '安全',
  approval: '审批',
  permissions: '权限',
  'trusted tools': '信任工具',
  'denied tools': '拒绝工具',
  'prompt cache': '提示缓存',
  'prompt cache debug': '提示缓存调试',
  guardrails: '护栏',
  'max turns': '最大轮次',
  'context tokens': '上下文 token',
  'max output': '最大输出',
  compaction: '压缩',
  'config warnings': '配置警告',
};

function fieldLabel(key: string): string {
  return isZhLocale() ? (ZH_FIELD[key] ?? key) : key;
}

const ZH_SOURCE: Record<string, string> = {
  default: '默认',
  'provider default': '服务商默认',
  unconfigured: '未配置',
  'derived:mode': '由权限模式推导',
  missing: '缺失',
  config: '配置文件',
  cli: '命令行',
  'built-in': '内置',
  unprobed: '未探测',
};

const TYPED_GLOSS: Record<string, string> = {
  balanced: '均衡',
  cautious: '谨慎',
  autonomous: '自主',
  'full-access': '完全访问',
  'read-only': '只读',
  'workspace-write': '工作区可写',
  never: '从不询问',
  prompt: '每次询问',
  full: '完全访问',
  manual: '手动确认',
  plan: '只计划',
  acceptEdits: '接受编辑',
};

/** Labels Moss invents. Typed config values stay literal and get a gloss. */
function displayWord(value: 'none' | 'enabled' | 'disabled'): string {
  if (!isZhLocale()) return value;
  if (value === 'none') return '无';
  if (value === 'enabled') return '已启用';
  return '已关闭';
}

function showTyped(value: string): string {
  if (!isZhLocale()) return value;
  const gloss = TYPED_GLOSS[value];
  return gloss ? `\`${value}\`（${gloss}）` : value;
}

function sourceNote(source: string | undefined, extra = ''): string {
  const value = source ?? 'default';
  if (!isZhLocale()) return `(${value}${extra})`;
  const shown = ZH_SOURCE[value] ?? value;
  const extraZh =
    extra === ', from permissions.defaultMode' ? '，来自 permissions.defaultMode' : extra;
  return `（${shown}${extraZh}）`;
}

function missingValue(): string {
  return isZhLocale() ? '（未设置）' : '(not set)';
}

const FIELDS = {
  configPath: ['config file', (c: ResolvedCliConfig) => c.configPath],
  projectConfig: [
    'project config',
    (c: ResolvedCliConfig) =>
      c.projectConfigPath
        ? isZhLocale()
          ? `${c.projectConfigPath}（覆盖本工作区的用户配置）`
          : `${c.projectConfigPath} (overrides user config for this workspace)`
        : displayWord('none'),
  ],
  provider: [
    'provider',
    (c: ResolvedCliConfig) =>
      c.providerSource === 'unconfigured'
        ? isZhLocale()
          ? '未配置'
          : 'not configured'
        : `${c.provider} ${sourceNote(c.providerSource)}`,
  ],
  model: [
    'model',
    (c: ResolvedCliConfig) => `${c.model || missingValue()} ${sourceNote(c.modelSource)}`,
  ],
  baseUrl: [
    'base URL',
    (c: ResolvedCliConfig) => {
      const url = c.baseUrl || BASE_URL;
      return `${withoutSecret(url)} ${sourceNote(c.baseUrlSource)} → ${withoutSecret(buildApiV1Url(url, 'chat/completions'))}`;
    },
  ],
  apiKey: ['api key', apiKeyValue],
  profile: [
    'profile',
    (c: ResolvedCliConfig) =>
      `${showTyped(c.profile ?? 'autonomous')} ${sourceNote(c.profileSource)}`,
  ],
  safetyMode: [
    'safety',
    (c: ResolvedCliConfig) => {
      const base = `${showTyped(c.safetyMode)} ${sourceNote(c.safetyModeSource, c.safetyModeSource === 'derived:mode' ? ', from permissions.defaultMode' : '')}`;
      // The mode name is not an OS sandbox. Say so next to the value.
      return c.safetyMode === 'workspace-write'
        ? `${base}. ${workspaceWriteLimit(isZhLocale())}`
        : base;
    },
  ],
  approvalPolicy: [
    'approval',
    (c: ResolvedCliConfig) =>
      `${showTyped(c.approvalPolicy)} ${sourceNote(c.approvalPolicySource, c.approvalPolicySource === 'derived:mode' ? ', from permissions.defaultMode' : '')}`,
  ],
  permissions: [
    'permissions',
    (c: ResolvedCliConfig) => {
      // Tolerate hosts that hand-render partial configs (spec fixtures skip
      // the permissions view) — render counts as zero instead of crashing.
      const view = c.permissions ?? {
        defaultMode: 'full' as const,
        readOnlyCeiling: false,
        allow: [],
        ask: [],
        deny: [],
        deviceTrust: 'gated',
        trustedDevices: [],
        legacyKeysUsed: [],
        source: 'default',
      };
      const counts = `allow ${view.allow.length} · ask ${view.ask.length} · deny ${view.deny.length}`;
      const deviceTrust =
        view.deviceTrust === 'full'
          ? isZhLocale()
            ? '，设备信任 full'
            : ', device trust full'
          : view.trustedDevices?.length
            ? isZhLocale()
              ? `，已信任设备 ${view.trustedDevices.length}`
              : `, trusted devices ${view.trustedDevices.length}`
            : '';
      const ceiling = view.readOnlyCeiling
        ? isZhLocale()
          ? ' + 只读上限'
          : ' + read-only ceiling'
        : '';
      const legacy =
        view.legacyKeysUsed.length > 0
          ? isZhLocale()
            ? `；已迁移旧键：${view.legacyKeysUsed.join(', ')}`
            : `; legacy keys migrated: ${view.legacyKeysUsed.join(', ')}`
          : '';
      return isZhLocale()
        ? `模式 ${showTyped(view.defaultMode)}${ceiling} ${sourceNote(view.source)}，${counts}${deviceTrust}${legacy}`
        : `mode ${showTyped(view.defaultMode)}${ceiling} ${sourceNote(view.source)}, ${counts}${deviceTrust}${legacy}`;
    },
  ],
  trustedTools: [
    'trusted tools',
    (c: ResolvedCliConfig) =>
      `${c.trustedTools?.length ? c.trustedTools.join(', ') : displayWord('none')} ${sourceNote(c.trustedToolsSource)}`,
  ],
  deniedTools: [
    'denied tools',
    (c: ResolvedCliConfig) =>
      `${c.deniedTools?.length ? c.deniedTools.join(', ') : displayWord('none')} ${sourceNote(c.deniedToolsSource)}`,
  ],
  promptCache: [
    'prompt cache',
    (c: ResolvedCliConfig) =>
      `${displayWord(c.promptCacheEnabled === false ? 'disabled' : 'enabled')} ${sourceNote(c.promptCacheSource)}`,
  ],
  promptCacheDebug: [
    'prompt cache debug',
    (c: ResolvedCliConfig) =>
      `${displayWord(c.promptCacheDebug === true ? 'enabled' : 'disabled')} ${sourceNote(c.promptCacheDebugSource)}`,
  ],
  guardrails: ['guardrails', guardrailSummary],
  maxTurns: [
    'max turns',
    (c: ResolvedCliConfig) => `${c.maxAgentTurns} ${sourceNote(c.maxAgentTurnsSource)}`,
  ],
  contextTokens: [
    'context tokens',
    (c: ResolvedCliConfig) => `${c.contextTokens} ${sourceNote(c.contextTokensSource)}`,
  ],
  maxOutput: [
    'max output',
    (c: ResolvedCliConfig) =>
      `${
        c.maxOutputTokens ??
        uiText(
          'derived from context window (contextTokens/4, cap 8k)',
          '由上下文窗口推算（contextTokens/4，上限 8k）'
        )
      }`,
  ],
  compaction: [
    'compaction',
    (c: ResolvedCliConfig) =>
      isZhLocale()
        ? `预留 ${c.compactionSettings?.reserveTokens ?? 20000}，保留最近 ${c.compactionSettings?.keepRecentTokens ?? 20000} ${sourceNote(c.compactionSettingsSource)}`
        : `reserve ${c.compactionSettings?.reserveTokens ?? 20000}, keepRecent ${c.compactionSettings?.keepRecentTokens ?? 20000} ${sourceNote(c.compactionSettingsSource)}`,
  ],
  warnings: ['config warnings', configAuditSummary],
} as const;

export type SnapshotField = keyof typeof FIELDS;

/**
 * Snapshot lines in one of two styles: `labeled` (interactive views, keys
 * aligned via ui.label) or `plain` (`key: value`, for headless output).
 */

export function configSnapshotLines(
  config: ResolvedCliConfig,
  fields: readonly SnapshotField[],
  style: 'labeled' | 'plain' = 'labeled'
): string[] {
  return fields.map((field) => {
    const [key, value] = FIELDS[field];
    const shown = fieldLabel(key);
    return style === 'labeled'
      ? `  ${label(shown)} ${value(config)}`
      : `  ${shown}${isZhLocale() ? '：' : ':'} ${value(config)}`;
  });
}
