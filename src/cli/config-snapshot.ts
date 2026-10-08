/**
 * One renderer for the resolved-config snapshot. Every diagnostic view —
 * /status --verbose, /permissions --verbose, `moss auth status` — prints its
 * fields from here, so values and sources cannot drift between views.
 */
import { auditResolvedCliConfig, BASE_URL, type ResolvedCliConfig } from './config.js';
import { buildApiV1Url } from '../provider/api-v1-url.js';
import { label } from './ui.js';

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
  if (input === 0 && output === 0) return `none (${config.guardrailsSource})`;
  return `input ${input}, output ${output} (${config.guardrailsSource})`;
}

export function configAuditSummary(config: ResolvedCliConfig): string {
  const warnings = auditResolvedCliConfig(config);
  if (warnings.length === 0) return 'none';
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
    return value || '(not configured)';
  }
}

function apiKeyValue(c: ResolvedCliConfig): string {
  if (!c.apiKey) return 'missing — run `moss setup`';
  if (c.apiKeySource === 'built-in') return 'configured via built-in (shared gateway key)';
  return `configured via ${c.apiKeySource}, ${c.apiKeyEncrypted ? 'encrypted' : 'plain text'}`;
}

const FIELDS = {
  configPath: ['config file', (c: ResolvedCliConfig) => c.configPath],
  projectConfig: [
    'project config',
    (c: ResolvedCliConfig) =>
      c.projectConfigPath
        ? `${c.projectConfigPath} (overrides user config for this workspace)`
        : 'none',
  ],
  provider: [
    'provider',
    (c: ResolvedCliConfig) => `${c.provider} (${c.providerSource ?? 'default'})`,
  ],
  model: [
    'model',
    (c: ResolvedCliConfig) => `${c.model || '(not set)'} (${c.modelSource ?? 'default'})`,
  ],
  baseUrl: [
    'base URL',
    (c: ResolvedCliConfig) => {
      const url = c.baseUrl || BASE_URL;
      return `${withoutSecret(url)} (${c.baseUrlSource ?? 'default'}) → ${withoutSecret(buildApiV1Url(url, 'chat/completions'))}`;
    },
  ],
  apiKey: ['api key', apiKeyValue],
  profile: [
    'profile',
    (c: ResolvedCliConfig) => `${c.profile ?? 'autonomous'} (${c.profileSource ?? 'default'})`,
  ],
  safetyMode: [
    'safety',
    (c: ResolvedCliConfig) =>
      `${c.safetyMode} (${c.safetyModeSource ?? 'default'}${c.safetyModeSource === 'derived:mode' ? ', from permissions.defaultMode' : ''})`,
  ],
  approvalPolicy: [
    'approval',
    (c: ResolvedCliConfig) =>
      `${c.approvalPolicy} (${c.approvalPolicySource ?? 'default'}${c.approvalPolicySource === 'derived:mode' ? ', from permissions.defaultMode' : ''})`,
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
        legacyKeysUsed: [],
        source: 'default',
      };
      const counts = `allow ${view.allow.length} · ask ${view.ask.length} · deny ${view.deny.length}`;
      const ceiling = view.readOnlyCeiling ? ' + read-only ceiling' : '';
      const legacy =
        view.legacyKeysUsed.length > 0
          ? `; legacy keys migrated: ${view.legacyKeysUsed.join(', ')}`
          : '';
      return `mode ${view.defaultMode}${ceiling} (${view.source}), ${counts}${legacy}`;
    },
  ],
  trustedTools: [
    'trusted tools',
    (c: ResolvedCliConfig) =>
      `${c.trustedTools?.length ? c.trustedTools.join(', ') : 'none'} (${c.trustedToolsSource ?? 'default'})`,
  ],
  deniedTools: [
    'denied tools',
    (c: ResolvedCliConfig) =>
      `${c.deniedTools?.length ? c.deniedTools.join(', ') : 'none'} (${c.deniedToolsSource ?? 'default'})`,
  ],
  promptCache: [
    'prompt cache',
    (c: ResolvedCliConfig) =>
      `${c.promptCacheEnabled === false ? 'disabled' : 'enabled'} (${c.promptCacheSource ?? 'default'})`,
  ],
  promptCacheDebug: [
    'prompt cache debug',
    (c: ResolvedCliConfig) =>
      `${c.promptCacheDebug === true ? 'enabled' : 'disabled'} (${c.promptCacheDebugSource ?? 'default'})`,
  ],
  guardrails: ['guardrails', guardrailSummary],
  maxTurns: [
    'max turns',
    (c: ResolvedCliConfig) => `${c.maxAgentTurns} (${c.maxAgentTurnsSource ?? 'default'})`,
  ],
  contextTokens: [
    'context tokens',
    (c: ResolvedCliConfig) => `${c.contextTokens} (${c.contextTokensSource ?? 'default'})`,
  ],
  maxOutput: [
    'max output',
    (c: ResolvedCliConfig) =>
      `${c.maxOutputTokens ?? 'derived from context window (contextTokens/4, cap 8k)'}`,
  ],
  compaction: [
    'compaction',
    (c: ResolvedCliConfig) =>
      `reserve ${c.compactionSettings?.reserveTokens ?? 20000}, keepRecent ${c.compactionSettings?.keepRecentTokens ?? 20000} (${c.compactionSettingsSource ?? 'default'})`,
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
    return style === 'labeled' ? `  ${label(key)} ${value(config)}` : `  ${key}: ${value(config)}`;
  });
}
