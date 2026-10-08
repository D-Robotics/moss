import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from '../context/compaction.js';
import { resolveMossMaxAgentTurns } from '../utils/max-agent-turns.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import {
  resolvePathFromSafeCwd,
  resolveSafeCwd,
  safeProcessCwd,
  type SafeCwdResult,
  type SafeCwdSource,
} from '../utils/safe-cwd.js';
import { errorMessage, throwMoss, ErrorCode } from '../errors.js';
import { maybeDecryptApiKeyInConfig, maybeEncryptApiKeyInConfig } from './config-api-key-crypto.js';
import { CliConfigFileError, CliConfigWriteError } from './config-errors.js';
import { writeConfigFileAtomic } from './config-durable-write.js';
import {
  type CliProviderPreset,
  type ProviderPreset,
  PROVIDER_PRESETS,
  parseProviderPreset,
  normalizeProvider,
  inferProviderFromBaseUrl,
} from '../provider/provider-presets.js';
import {
  DEFAULT_CLI_INTERACTION_MODE,
  deriveEngineQuantas,
  modeFromLegacySafetyPair,
  parseCliInteractionMode,
  type CliInteractionMode,
} from './interaction-mode.js';

export {
  CliConfigFileError,
  CliConfigWriteError,
  maybeDecryptApiKeyInConfig,
  maybeEncryptApiKeyInConfig,
  resolveSafeCwd,
  safeProcessCwd,
  type SafeCwdResult,
  type SafeCwdSource,
  type CliProviderPreset,
  type ProviderPreset,
  PROVIDER_PRESETS,
  parseProviderPreset,
  normalizeProvider,
};

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MOSS_CONFIG_DIR;
  if (explicit) return explicit;
  const base =
    process.platform === 'win32'
      ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'moss');
}

function readArgvValue(argv: string[], index: number): string | null {
  const arg = argv[index] || '';
  const eqIdx = arg.indexOf('=');
  if (eqIdx !== -1) return arg.slice(eqIdx + 1);
  const next = argv[index + 1];
  return next && !next.startsWith('-') ? next : null;
}

function resolveCliConfigFileArg(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--config-file' || arg.startsWith('--config-file=')) {
      const value = readArgvValue(argv, i);
      return value && value.trim() ? resolvePathFromSafeCwd(value, env) : null;
    }
  }
  return null;
}

export interface ConfigFile {
  profile?: CliConfigProfile | string;
  provider?: CliProviderPreset | string;
  apiKey?: string;

  _apiKeyEncrypted?: boolean;
  model?: string;
  baseUrl?: string;
  workspace?: string;
  safetyMode?: CliSafetyModeConfig | string;
  approvalPolicy?: ConfigApprovalPolicy | string;
  trustedTools?: string[];
  deniedTools?: string[];
  /**
   * v0.26 permission block (PRD 2026-10-08): the single source for the mode
   * engine. `defaultMode` replaces the safetyMode × approvalPolicy pair as
   * the user-facing knob; allow/ask/deny are rule lists (consumed by the
   * permission-rules engine from T03).
   */
  permissions?: PermissionsConfig;
  promptCache?: PromptCacheConfig | boolean;
  guardrails?: GuardrailsConfig;
  agent?: AgentRuntimeConfig;
  hooks?: HooksConfig;
  /** Network egress policy for web tools (hostname allowlist). */
  net?: { allowHosts?: string[] };
  _examples?: Record<string, unknown>;
}

/**
 * The v0.26 permissions block shape. `defaultMode` accepts the mode name
 * (manual | acceptEdits | plan | full); rule arrays use the Tool(pattern)
 * syntax parsed by the permission-rules engine (T03).
 */
export interface PermissionsConfig {
  defaultMode?: CliInteractionMode | string;
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface LoadedCliConfigFile {
  config: ConfigFile;
  configPath: string;
  projectConfigPath?: string;
}

export type CliConfigProfile = 'cautious' | 'balanced' | 'autonomous';
export type CliSafetyModeConfig = 'read-only' | 'workspace-write' | 'full-access';
export type ConfigApprovalPolicy = 'prompt' | 'never';

export interface PromptCacheConfig {
  enabled?: boolean;
  debug?: boolean;
}

export interface TextGuardrailConfig {
  blockPatterns?: string[];
  redactPatterns?: string[];
}

export interface GuardrailsConfig {
  input?: TextGuardrailConfig;
  output?: TextGuardrailConfig;
}

export interface AgentRuntimeConfig {
  maxTurns?: number;
  contextTokens?: number;
  /** Unattended-run guardrails (v0.9 W3). Env overrides:
   *  MOSS_BUDGET_MAX_TOKENS / MOSS_BUDGET_MAX_TOOL_CALLS /
   *  MOSS_BUDGET_MAX_TURNS / MOSS_BUDGET_MAX_WALL_MS. */
  budget?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxTurns?: number;
    maxWallMs?: number;
  };
  /** v0.10 W2: >=2 enables the verification-gated best-of-n fix engine. */
  bestOfN?: number;
  /** v0.10 W4: 'off' | 'adaptive' | 'high' (default adaptive). */
  reasoningBudget?: 'off' | 'adaptive' | 'high';
  /** v0.12 model routing tiers (env MOSS_MODEL_CHEAP/BALANCED/STRONG). */
  modelTiers?: { cheap?: string; balanced?: string; strong?: string };
  /** Max output tokens per LLM response. If unset, moss derives a default from
   * the probed context window (contextTokens/4, capped to 32k) — NOT a hardcoded
   * 4096, which truncated long answers on modern large-output models. */
  maxOutputTokens?: number;
  compaction?: Partial<Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>>;
}

export interface HookCommandConfig {
  matcher?: string;

  command: string;

  timeoutMs?: number;

  blocking?: boolean;
}

export interface HooksConfig {
  PreToolUse?: HookCommandConfig[];

  PostToolUse?: HookCommandConfig[];

  SessionStart?: HookCommandConfig[];

  /** Fires after each completed agent run; a blocking non-zero exit vetoes the stop. */
  Stop?: HookCommandConfig[];

  /** Fires when a spawned subagent finishes its task. */
  SubagentStop?: HookCommandConfig[];

  /** Fires before a context compaction splices the transcript. */
  PreCompact?: HookCommandConfig[];

  /** Fires after a context compaction (success or failure). */
  PostCompact?: HookCommandConfig[];

  /** Fires once when the CLI session is shutting down. */
  SessionEnd?: HookCommandConfig[];

  /** Fires when user attention is needed (e.g. an approval prompt). */
  Notification?: HookCommandConfig[];
}

export interface ResolvedTextGuardrailConfig {
  blockPatterns: string[];
  redactPatterns: string[];
}

export interface ResolvedGuardrailsConfig {
  input: ResolvedTextGuardrailConfig;
  output: ResolvedTextGuardrailConfig;
}

export interface CliConfigOverrides {
  profile?: CliConfigProfile;
  provider?: CliProviderPreset | string;
  model?: string;
  baseUrl?: string;
  workspace?: string;
  safetyMode?: CliSafetyModeConfig;
  approvalPolicy?: ConfigApprovalPolicy;
  trustedTools?: string[];
  deniedTools?: string[];
  promptCacheEnabled?: boolean;
  promptCacheDebug?: boolean;
  maxAgentTurns?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
}

export interface CliProfileDefaults {
  safetyMode: CliSafetyModeConfig;
  approvalPolicy: ConfigApprovalPolicy;
  trustedTools: string[];
  promptCacheEnabled: boolean;
  promptCacheDebug: boolean;
}

export const CLI_PROFILE_DEFAULTS: Record<CliConfigProfile, CliProfileDefaults> = {
  cautious: {
    safetyMode: 'read-only',
    approvalPolicy: 'prompt',
    trustedTools: [],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
  // v0.26 (PRD 2026-10-08 W1): balanced is the DEFAULT profile and now maps to
  // the `full` mode equivalent — full-access + never — matching the new
  // out-of-box default (defaultMode=full). The field VALUES are kept (SDK
  // surface compat) but their resolution semantics give way to
  // permissions.defaultMode: the mode engine derives safetyMode/approvalPolicy
  // and these profile fields are no longer consulted for them. An explicit
  // legacy `profile: balanced` key in a config file migrates to `manual`
  // (PRD migration table), NOT to full — the flip only applies to the
  // no-config default.
  balanced: {
    safetyMode: 'full-access',
    approvalPolicy: 'never',
    trustedTools: [],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
  // autonomous is the most permissive — full-access + never prompt, for
  // explicitly trusted / disposable environments.
  autonomous: {
    safetyMode: 'full-access',
    approvalPolicy: 'never',
    trustedTools: ['exec', 'apply_patch'],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
};

/**
 * Migration result for the legacy permission keys (read-side only).
 * `defaultMode` is only set when a legacy key actually maps; `ceiling` carries
 * the read-only override; `allowRules`/`denyRules` translate trustedTools /
 * deniedTools into whole-tool rule specs; `legacyKeysUsed` feeds the
 * doctor/config-show deprecated notice.
 */
export interface LegacyPermissionMigration {
  defaultMode?: CliInteractionMode;
  ceiling: 'read-only' | undefined;
  allowRules: string[];
  denyRules: string[];
  legacyKeysUsed: string[];
}

/**
 * v0.26 read-side migration (PRD 2026-10-08 「旧键迁移兼容（读侧）」 mapping
 * table, a pure function — no IO):
 *
 *   profile: cautious     → defaultMode manual + ceiling read-only
 *   profile: balanced     → defaultMode manual
 *   profile: autonomous   → defaultMode full
 *   safetyMode+approvalPolicy: full-access+never → full; read-only →
 *                             manual+ceiling; anything else → manual
 *   trustedTools          → allow rules (whole tool names)
 *   deniedTools           → deny rules (whole tool names)
 *
 * Unknown values do not migrate (validation stays at the normal parse path).
 */
export function migrateLegacyPermissionConfig(legacy: {
  profile?: string;
  safetyMode?: string;
  approvalPolicy?: string;
  trustedTools?: string[];
  deniedTools?: string[];
}): LegacyPermissionMigration {
  const legacyKeysUsed: string[] = [];
  const allowRules: string[] = [];
  const denyRules: string[] = [];
  let defaultMode: CliInteractionMode | undefined;
  let ceiling: 'read-only' | undefined;

  if (legacy.profile !== undefined) {
    legacyKeysUsed.push('profile');
    const normalized = normalizeConfigProfile(legacy.profile);
    if (normalized === 'cautious') {
      defaultMode = 'manual';
      ceiling = 'read-only';
    } else if (normalized === 'balanced') {
      defaultMode = 'manual';
    } else if (normalized === 'autonomous') {
      defaultMode = 'full';
    }
    // Unknown profile values do not migrate (the resolution path validates
    // them earlier; direct callers get no defaultMode from this key).
  }

  const hasLegacyPair = legacy.safetyMode !== undefined || legacy.approvalPolicy !== undefined;
  if (hasLegacyPair) {
    if (legacy.safetyMode !== undefined) legacyKeysUsed.push('safetyMode');
    if (legacy.approvalPolicy !== undefined) legacyKeysUsed.push('approvalPolicy');
    const safetyMode = normalizeSafetyModeConfig(legacy.safetyMode) ?? undefined;
    const approvalPolicy = normalizeApprovalPolicyConfig(legacy.approvalPolicy) ?? undefined;
    if (safetyMode === 'read-only') {
      // read-only is a ceiling that compresses ANY mode including full (PRD
      // decision 2). The mode itself stays manual; the ceiling rides along.
      defaultMode = 'manual';
      ceiling = 'read-only';
    } else {
      // The explicit safetyMode/approvalPolicy pair is more specific than the
      // profile migration, so it wins: full-access+never → full; anything
      // else → manual.
      defaultMode = modeFromLegacySafetyPair(safetyMode, approvalPolicy);
    }
  }

  if (legacy.trustedTools !== undefined) {
    legacyKeysUsed.push('trustedTools');
    allowRules.push(...legacy.trustedTools);
  }
  if (legacy.deniedTools !== undefined) {
    legacyKeysUsed.push('deniedTools');
    denyRules.push(...legacy.deniedTools);
  }

  return {
    ...(defaultMode !== undefined ? { defaultMode } : {}),
    ceiling,
    allowRules,
    denyRules,
    legacyKeysUsed,
  };
}

function resolveExplicitConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): string | null {
  const fromArgv = resolveCliConfigFileArg(argv, env);
  if (fromArgv) return fromArgv;
  const explicit = env.MOSS_CONFIG_FILE || env.MOSS_CONFIG_PATH;
  return explicit && explicit.trim() ? resolvePathFromSafeCwd(explicit, env) : null;
}

function hasExplicitConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): boolean {
  return resolveExplicitConfigPath(env, argv) !== null;
}

export function resolveConfigPath(
  configDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): string {
  if (configDir) return path.join(configDir, 'config.json');
  return resolveExplicitConfigPath(env, argv) || path.join(resolveConfigDir(env), 'config.json');
}

export function resolveProjectConfigPath(startDir = safeProcessCwd(), maxHops = 16): string | null {
  let dir = resolvePathFromSafeCwd(startDir);
  for (let i = 0; i < maxHops; i++) {
    const paths = getMossWorkspacePaths(dir);
    if (fs.existsSync(paths.projectConfigPath)) return paths.projectConfigPath;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadConfigFile(configPath = resolveConfigPath()): ConfigFile {
  if (!fs.existsSync(configPath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const message = errorMessage(err);
    throw new CliConfigFileError(configPath, message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = errorMessage(err);
    throw new CliConfigFileError(configPath, message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliConfigFileError(configPath, 'expected a JSON object');
  }
  const config = parsed as ConfigFile;

  const configDir = path.dirname(configPath);
  return maybeDecryptApiKeyInConfig(config, configDir, configPath);
}

function mergePromptCacheConfig(
  userPromptCache: ConfigFile['promptCache'],
  projectPromptCache: ConfigFile['promptCache']
): ConfigFile['promptCache'] {
  if (
    projectPromptCache &&
    typeof projectPromptCache === 'object' &&
    userPromptCache &&
    typeof userPromptCache === 'object'
  ) {
    return { ...userPromptCache, ...projectPromptCache };
  }
  return projectPromptCache ?? userPromptCache;
}

function mergeTextGuardrailConfig(
  userGuardrail: TextGuardrailConfig | undefined,
  projectGuardrail: TextGuardrailConfig | undefined
): TextGuardrailConfig | undefined {
  if (!projectGuardrail && !userGuardrail) return undefined;
  return {
    ...userGuardrail,
    ...projectGuardrail,
  };
}

function mergeGuardrailsConfig(
  userGuardrails: ConfigFile['guardrails'],
  projectGuardrails: ConfigFile['guardrails']
): ConfigFile['guardrails'] {
  if (!projectGuardrails && !userGuardrails) return undefined;
  return {
    input: mergeTextGuardrailConfig(userGuardrails?.input, projectGuardrails?.input),
    output: mergeTextGuardrailConfig(userGuardrails?.output, projectGuardrails?.output),
  };
}

function mergeAgentRuntimeConfig(
  userAgent: ConfigFile['agent'],
  projectAgent: ConfigFile['agent']
): ConfigFile['agent'] {
  if (!projectAgent && !userAgent) return undefined;
  return {
    ...userAgent,
    ...projectAgent,
    compaction: {
      ...userAgent?.compaction,
      ...projectAgent?.compaction,
    },
  };
}

function mergeHooksConfig(user?: HooksConfig, project?: HooksConfig): HooksConfig | undefined {
  if (!project && !user) return undefined;

  return {
    PreToolUse: [...(project?.PreToolUse ?? []), ...(user?.PreToolUse ?? [])],
    PostToolUse: [...(project?.PostToolUse ?? []), ...(user?.PostToolUse ?? [])],
    SessionStart: [...(project?.SessionStart ?? []), ...(user?.SessionStart ?? [])],
  };
}

export function mergeConfigFiles(projectConfig: ConfigFile, userConfig: ConfigFile): ConfigFile {
  const projectDeclaresEndpoint =
    projectConfig.provider !== undefined || projectConfig.baseUrl !== undefined;
  const apiKey = projectDeclaresEndpoint
    ? projectConfig.apiKey
    : (projectConfig.apiKey ?? userConfig.apiKey);
  const apiKeyEncrypted = projectDeclaresEndpoint
    ? projectConfig._apiKeyEncrypted
    : projectConfig.apiKey !== undefined
      ? projectConfig._apiKeyEncrypted
      : userConfig._apiKeyEncrypted;

  return {
    ...userConfig,
    ...projectConfig,
    apiKey,
    _apiKeyEncrypted: apiKeyEncrypted,
    // Safety-sensitive fields: the USER's config wins over the PROJECT's.
    // A cloned repo's .moss/config.json is less trusted than the user's
    // ~/.config/moss/config.json — it must not silently lower the user's
    // safety stance (e.g. approvalPolicy: 'never', safetyMode: 'full-access',
    // or widening trustedTools). If the user hasn't set a field, the project
    // value is still used (project defaults are fine); the user's explicit
    // choice always wins. CLI flags and env vars override both (resolveCliConfig).
    safetyMode: userConfig.safetyMode ?? projectConfig.safetyMode,
    approvalPolicy: userConfig.approvalPolicy ?? projectConfig.approvalPolicy,
    trustedTools: userConfig.trustedTools ?? projectConfig.trustedTools,
    deniedTools: userConfig.deniedTools ?? projectConfig.deniedTools,
    permissions: mergePermissionsConfig(userConfig.permissions, projectConfig.permissions),
    promptCache: mergePromptCacheConfig(userConfig.promptCache, projectConfig.promptCache),
    guardrails: mergeGuardrailsConfig(userConfig.guardrails, projectConfig.guardrails),
    agent: mergeAgentRuntimeConfig(userConfig.agent, projectConfig.agent),
    hooks: mergeHooksConfig(userConfig.hooks, projectConfig.hooks),
  };
}

/**
 * v0.26 permission-block merge, safety-directional like the other safety
 * fields: user-wins on every scalar knob; rule lists union BOTH layers
 * (deny rules union across levels by design — a project cannot silently
 * remove the user's deny; allow/ask dedupe).
 */
function mergePermissionsConfig(
  user: PermissionsConfig | undefined,
  project: PermissionsConfig | undefined
): PermissionsConfig | undefined {
  if (!user && !project) return undefined;
  const unionList = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => {
    if (!a && !b) return undefined;
    return [...new Set([...(a ?? []), ...(b ?? [])])];
  };
  return {
    ...(user ?? {}),
    ...(project ?? {}),
    defaultMode: user?.defaultMode ?? project?.defaultMode,
    allow: unionList(user?.allow, project?.allow),
    ask: unionList(user?.ask, project?.ask),
    deny: unionList(user?.deny, project?.deny),
  };
}

export function loadCliConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  startDir = safeProcessCwd(env)
): LoadedCliConfigFile {
  const configPath = resolveConfigPath(undefined, env, argv);
  const userConfig = loadConfigFile(configPath);
  if (hasExplicitConfigPath(env, argv)) {
    return { config: userConfig, configPath };
  }

  const projectConfigPath = resolveProjectConfigPath(startDir) ?? undefined;
  if (!projectConfigPath) {
    return { config: userConfig, configPath };
  }
  return {
    config: mergeConfigFiles(loadConfigFile(projectConfigPath), userConfig),
    configPath,
    projectConfigPath,
  };
}

export function saveConfigFileAtPath(config: ConfigFile, configPath: string): void {
  try {
    const dir = path.dirname(configPath);
    const { _apiKeyEncrypted: _, ...stripped } = config as ConfigFile & {
      _apiKeyEncrypted?: boolean;
    };
    const configToSave = maybeEncryptApiKeyInConfig(stripped, dir, configPath);

    writeConfigFileAtomic(configPath, `${JSON.stringify(configToSave, null, 2)}\n`);
  } catch (err) {
    const reason = errorMessage(err);
    throw new CliConfigWriteError(configPath, reason);
  }
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {}
}

export function saveConfigFile(config: ConfigFile, configDir?: string): void {
  saveConfigFileAtPath(config, resolveConfigPath(configDir));
}

export function normalizeConfigProfile(value: string | undefined): CliConfigProfile | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'cautious' || raw === 'safe' || raw === 'readonly') return 'cautious';
  if (raw === 'balanced' || raw === 'default' || raw === 'codex') return 'balanced';
  if (raw === 'autonomous' || raw === 'auto' || raw === 'agentic') return 'autonomous';
  return null;
}

function parseConfigProfile(
  value: string | undefined,
  source: string
): CliConfigProfile | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const profile = normalizeConfigProfile(value);
  if (!profile) {
    throwMoss({
      code: ErrorCode.USER_INPUT_INVALID,
      message: `Unsupported ${source} profile "${value}".`,
      hint: 'Supported profiles: cautious, balanced, autonomous',
    });
  }
  return profile;
}

export function normalizeSafetyModeConfig(value: string | undefined): CliSafetyModeConfig | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'read-only' || raw === 'readonly' || raw === 'untrusted') return 'read-only';
  if (raw === 'workspace-write' || raw === 'workspace' || raw === 'write' || raw === 'on-request')
    return 'workspace-write';
  if (raw === 'full-access' || raw === 'full' || raw === 'danger-full-access') return 'full-access';
  return null;
}

export function normalizeApprovalPolicyConfig(
  value: string | undefined
): ConfigApprovalPolicy | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'never' || raw === 'auto' || raw === 'auto-approve') return 'never';
  if (raw === 'prompt' || raw === 'ask' || raw === 'on-request') return 'prompt';
  return null;
}

export function parseConfigBoolean(value: string | undefined): boolean | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === 'enabled')
    return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off' || raw === 'disabled')
    return false;
  return null;
}

export function parseTrustedTools(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const rawValues = Array.isArray(value) ? value : value.split(',');
  const tools = rawValues.map((tool) => tool.trim()).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_.:/\-*?]+$/.test(tool)) {
      throwMoss({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `Unsupported trusted tool name "${tool}"`,
        hint: 'Tool names must only contain letters, digits, _, ., :, /, -, *, or ?',
      });
    }
    if (!seen.has(tool)) {
      seen.add(tool);
      unique.push(tool);
    }
  }
  return unique.length > 0 ? unique : undefined;
}

function parsePatternList(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throwMoss({
      code: ErrorCode.USER_INPUT_INVALID,
      message: `Unsupported ${source}; expected an array of strings`,
      hint: 'Check your .moss/config.json — guardrail patterns must be an array.',
    });
  }
  const patterns = value
    .map((pattern) => (typeof pattern === 'string' ? pattern.trim() : ''))
    .filter(Boolean);
  for (const pattern of patterns) {
    if (pattern.length > 500) {
      throwMoss({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `Unsupported ${source} pattern: values must be 500 characters or less`,
        hint: 'Shorten the guardrail pattern in .moss/config.json.',
      });
    }
  }
  return [...new Set(patterns)];
}

export function normalizeGuardrailsConfig(
  config: ConfigFile['guardrails']
): ResolvedGuardrailsConfig {
  return {
    input: {
      blockPatterns: parsePatternList(
        config?.input?.blockPatterns,
        'guardrails.input.blockPatterns'
      ),
      redactPatterns: parsePatternList(
        config?.input?.redactPatterns,
        'guardrails.input.redactPatterns'
      ),
    },
    output: {
      blockPatterns: parsePatternList(
        config?.output?.blockPatterns,
        'guardrails.output.blockPatterns'
      ),
      redactPatterns: parsePatternList(
        config?.output?.redactPatterns,
        'guardrails.output.redactPatterns'
      ),
    },
  };
}

function hasGuardrails(config: ResolvedGuardrailsConfig): boolean {
  return (
    config.input.blockPatterns.length > 0 ||
    config.input.redactPatterns.length > 0 ||
    config.output.blockPatterns.length > 0 ||
    config.output.redactPatterns.length > 0
  );
}

function parsePositiveInteger(value: unknown, source: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throwMoss({
      code: ErrorCode.USER_INPUT_INVALID,
      message: `Unsupported ${source}; expected a positive integer`,
      hint: 'Check the numeric value in .moss/config.json.',
    });
  }
  return value;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const IGNORED_MODEL_ENV_VARS = [
  'MOSS_PROVIDER',
  'MOSS_MODEL',
  'MOSS_BASE_URL',
  'MOSS_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DASHSCOPE_API_KEY',
  'ALIYUN_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'DASHSCOPE_BASE_URL',
] as const;

function listIgnoredModelEnvVars(env: NodeJS.ProcessEnv): string[] {
  return IGNORED_MODEL_ENV_VARS.filter((name) => Boolean(env[name]));
}

/**
 * v0.26 resolved permission view: the mode-engine output of the resolution
 * chain. `safetyMode`/`approvalPolicy` on ResolvedCliConfig become DERIVED
 * quantities of `defaultMode` (source 'derived:mode'); this view carries the
 * mode + rule lists + the read-only ceiling flag + which legacy keys fed the
 * migration (for doctor / config show deprecation notices).
 */
export interface ResolvedPermissionsView {
  defaultMode: CliInteractionMode;
  /** Startup read-only ceiling (--read-only / MOSS_SAFETY_MODE=read-only /
   * migrated cautious profile): compresses ANY mode including full. */
  readOnlyCeiling: boolean;
  allow: string[];
  ask: string[];
  deny: string[];
  /** Legacy keys that fed the read-side migration (profile/safetyMode/
   * approvalPolicy/trustedTools/deniedTools) — empty for pure new-key users. */
  legacyKeysUsed: string[];
  source: string;
}

export interface ResolvedCliConfig {
  profile: CliConfigProfile;
  profileSource: string;
  provider: CliProviderPreset;
  providerSource: string;
  apiKey: string;
  apiKeySource: string;

  usingBundledDefault: boolean;

  bundledDefaultSuppressedBy?: string;

  ignoredModelEnvVars: string[];
  model: string;
  modelSource: string;
  baseUrl: string;
  baseUrlSource: string;
  workspace: string;
  workspaceSource: string;
  /** v0.26: derived from permissions.defaultMode (source 'derived:mode'). */
  permissions: ResolvedPermissionsView;
  /** v0.26: derived output of the mode engine; kept for SDK/embed compat. */
  safetyMode: CliSafetyModeConfig;
  safetyModeSource: string;
  /** v0.26: derived output of the mode engine; kept for SDK/embed compat. */
  approvalPolicy: ConfigApprovalPolicy;
  approvalPolicySource: string;
  trustedTools: string[];
  trustedToolsSource: string;
  deniedTools: string[];
  deniedToolsSource: string;
  promptCacheEnabled: boolean;
  promptCacheSource: string;
  promptCacheDebug: boolean;
  promptCacheDebugSource: string;
  guardrails: ResolvedGuardrailsConfig;
  guardrailsSource: string;
  maxAgentTurns: number;
  maxAgentTurnsSource: string;
  contextTokens: number;
  contextTokensSource: string;
  /** Unattended-run guardrails (config agent.budget + MOSS_BUDGET_* env). */
  budget?: { maxTokens?: number; maxToolCalls?: number; maxTurns?: number; maxWallMs?: number };
  /** v0.10 W2 best-of-n (config agent.bestOfN + MOSS_BEST_OF_N env). */
  bestOfN?: number;
  /** v0.10 W4 (config agent.reasoningBudget + MOSS_REASONING_BUDGET env). */
  reasoningBudget?: 'off' | 'adaptive' | 'high';
  /** v0.12 (agent.modelTiers + MOSS_MODEL_CHEAP/BALANCED/STRONG env). */
  modelTiers?: { cheap?: string; balanced?: string; strong?: string };
  /** Max output tokens per LLM response. undefined → runtime derives from contextTokens. */
  maxOutputTokens?: number;
  compactionSettings: Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>;
  compactionSettingsSource: string;
  configPath: string;
  projectConfigPath?: string;

  apiKeyEncrypted: boolean;
}

export type CliConfigAuditSeverity = 'warn';

export interface CliConfigAuditWarning {
  code: string;
  severity: CliConfigAuditSeverity;
  source: string;
  message: string;
}

function hasToolPatternWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

export function isBroadTrustedToolPattern(pattern: string): boolean {
  const compact = pattern.trim();
  if (compact === '*' || compact === '**') return true;
  if (compact === '*_*' || compact === '*__*') return true;
  if (compact.endsWith('_*') && !compact.endsWith('__*')) return true;
  return false;
}

function findConflictingToolPatterns(
  trustedTools: readonly string[],
  deniedTools: readonly string[]
): string[] {
  const denied = new Set(deniedTools);
  return trustedTools.filter((pattern) => denied.has(pattern));
}

export function auditResolvedCliConfig(
  config: Pick<
    ResolvedCliConfig,
    | 'approvalPolicy'
    | 'approvalPolicySource'
    | 'safetyMode'
    | 'safetyModeSource'
    | 'trustedTools'
    | 'trustedToolsSource'
    | 'deniedTools'
    | 'deniedToolsSource'
    | 'permissions'
  >
): CliConfigAuditWarning[] {
  const warnings: CliConfigAuditWarning[] = [];
  // v0.26 audit re-check (PRD W1 告警重校): the old blanket auto-approval
  // warning would fire for every factory-default user now that full is the
  // default. The warning only fires when the auto-approval stance came from
  // an EXPLICIT source (cli/env/config/legacy — not the derived default) AND
  // there is no deny guardrail.
  const explicitAutoApproval =
    config.approvalPolicy === 'never' &&
    config.permissions !== undefined &&
    config.permissions.source !== 'default';
  if (explicitAutoApproval) {
    warnings.push({
      code: 'approval.auto_approval',
      severity: 'warn',
      source: config.approvalPolicySource,
      message: `auto-approval is enabled via ${config.permissions.source} (${config.approvalPolicySource}); keep deniedTools current for risky tools`,
    });
    if (config.deniedTools.length === 0) {
      warnings.push({
        code: 'approval.no_denied_tools',
        severity: 'warn',
        source: config.deniedToolsSource,
        message: `auto-approval has no deniedTools guardrail (${config.deniedToolsSource}); add high-risk tools or globs to deniedTools`,
      });
    }
  } else if (
    config.approvalPolicy === 'never' &&
    config.deniedTools.length === 0 &&
    config.permissions !== undefined &&
    config.permissions.source === 'default'
  ) {
    // The new factory default (full, no deny rules): a single informational
    // nudge toward /permissions, not a warning (PRD decision 7).
    warnings.push({
      code: 'approval.full_default_no_deny',
      severity: 'warn',
      source: 'default',
      message:
        'default full mode has no deny rules; add rules with /permissions (e.g. deny read_file(./.env)) to keep sensitive tools gated',
    });
  }

  const conflictingPatterns = findConflictingToolPatterns(config.trustedTools, config.deniedTools);
  if (conflictingPatterns.length > 0) {
    warnings.push({
      code: 'approval.conflicting_tool_patterns',
      severity: 'warn',
      source: `${config.trustedToolsSource}, ${config.deniedToolsSource}`,
      message: `trustedTools also appear in deniedTools: ${conflictingPatterns.join(', ')}; deniedTools takes precedence`,
    });
  }

  const broadTrustedPatterns = config.trustedTools.filter(isBroadTrustedToolPattern);
  if (broadTrustedPatterns.length > 0) {
    warnings.push({
      code: 'trustedTools.broad_patterns',
      severity: 'warn',
      source: config.trustedToolsSource,
      message: `broad trusted pattern(s): ${broadTrustedPatterns.join(', ')}; prefer exact tool names or narrow server__tool globs`,
    });
  }

  return warnings;
}

export function hasTrustedToolWildcard(config: Pick<ResolvedCliConfig, 'trustedTools'>): boolean {
  return config.trustedTools.some(hasToolPatternWildcard);
}

/**
 * v0.26 one-shot full-default notice (PRD decision 7 / design §8-6): a session
 * may surface the "you are in full mode with no deny rules" nudge at most
 * ONCE (in-memory boolean — no persisted counter). The audit-side info-level
 * warning stays separate: doctor / config show keep printing it on every
 * invocation (both sides implemented, per the adjudication).
 */
let fullDefaultNoticeShown = false;

export function shouldShowFullDefaultNotice(
  config: Pick<ResolvedCliConfig, 'approvalPolicy' | 'deniedTools' | 'permissions'>
): boolean {
  if (fullDefaultNoticeShown) return false;
  const applicable =
    config.approvalPolicy === 'never' &&
    config.deniedTools.length === 0 &&
    config.permissions !== undefined &&
    config.permissions.source === 'default';
  if (!applicable) return false;
  fullDefaultNoticeShown = true;
  return true;
}

let bundledDefaultReadWarned = false;

function readBundledZeroConfigDefault(env: NodeJS.ProcessEnv): Partial<ConfigFile> | null {
  if (env.MOSS_NO_BUNDLED_DEFAULT === '1') return null;
  const candidates: string[] = [];
  if (env.MOSS_BUNDLED_DEFAULT_FILE) {
    candidates.push(env.MOSS_BUNDLED_DEFAULT_FILE);
  } else {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '../../zero-config-default.json'));
      candidates.push(path.resolve(here, '../zero-config-default.json'));
    } catch {}
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Record<string, unknown>;
      const result: Partial<ConfigFile> = {};
      for (const key of ['provider', 'model', 'baseUrl', 'apiKey'] as const) {
        if (typeof parsed[key] === 'string' && parsed[key]) {
          (result as Record<string, string>)[key] = parsed[key] as string;
        }
      }
      if (Object.keys(result).length > 0) return result;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === 'EACCES' || code === 'EPERM') && !bundledDefaultReadWarned) {
        bundledDefaultReadWarned = true;
        console.error(
          `[config] built-in model gateway file exists but is not readable (${code}): ${candidate}\n` +
            '[config] Fix: sudo chmod 644 <that file> — or reinstall moss and retry.'
        );
      }
    }
  }
  return null;
}

function hasUserModelConfig(cfg: ConfigFile): boolean {
  return Boolean(cfg.model && cfg.apiKey && (cfg.provider || cfg.baseUrl));
}

/**
 * Conservative fallback context-window size used when the provider's actual
 * window could not be probed. 32k is small enough not to overrun most models
 * yet large enough for functional conversations; the user is prompted to set
 * `agent.contextTokens` explicitly or run `/model` once the value matters.
 *
 * This constant is intentionally NOT a guess at any specific model's window —
 * it means "we don't know, proceed carefully."
 *
 * @public
 */
export const CONSERVATIVE_DEFAULT_UNPROBED = 1_000_000; // changed from 32k — modern models are typically 1M+

export function resolveCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  config?: ConfigFile,
  overrides: CliConfigOverrides = {},
  loadedConfig?: Pick<LoadedCliConfigFile, 'configPath' | 'projectConfigPath'>
): ResolvedCliConfig {
  const safeCwd = resolveSafeCwd(env);
  const defaultLoadedConfig = config === undefined ? loadCliConfigFile(env) : undefined;
  let activeConfig: ConfigFile = config ?? defaultLoadedConfig?.config ?? {};
  let usingBundledDefault = false;
  let bundledDefaultKeys = new Set<keyof ConfigFile>();
  let bundledDefaultSuppressedBy: string | undefined;

  if (!hasUserModelConfig(activeConfig)) {
    const bundled = readBundledZeroConfigDefault(env);
    if (bundled) {
      activeConfig = { ...activeConfig, ...bundled };
      bundledDefaultKeys = new Set(Object.keys(bundled) as Array<keyof ConfigFile>);
      usingBundledDefault = true;
    }
  } else if (readBundledZeroConfigDefault(env)) {
    bundledDefaultSuppressedBy = 'moss config file';
  }
  const configPaths = loadedConfig ?? defaultLoadedConfig;
  const profileEnv = env.MOSS_PROFILE || env.MOSS_CONFIG_PROFILE;
  const configProfile = parseConfigProfile(
    typeof activeConfig.profile === 'string' ? activeConfig.profile : undefined,
    'config'
  );
  const envProfile = parseConfigProfile(
    profileEnv,
    env.MOSS_PROFILE ? 'MOSS_PROFILE' : 'MOSS_CONFIG_PROFILE'
  );

  const profile = overrides.profile ?? envProfile ?? configProfile ?? 'balanced';
  const profileSource = overrides.profile
    ? 'cli'
    : envProfile
      ? env.MOSS_PROFILE
        ? 'MOSS_PROFILE'
        : 'MOSS_CONFIG_PROFILE'
      : configProfile
        ? 'config'
        : 'default';
  const profileDefaults = CLI_PROFILE_DEFAULTS[profile];

  const ignoredModelEnvVars = listIgnoredModelEnvVars(env);
  const inferredProvider = inferProviderFromBaseUrl(overrides.baseUrl || activeConfig.baseUrl);
  const activeConfigSource = (key: keyof ConfigFile): string =>
    usingBundledDefault && bundledDefaultKeys.has(key) ? 'built-in' : 'config';
  const provider =
    overrides.provider || activeConfig.provider
      ? normalizeProvider(overrides.provider || activeConfig.provider)
      : inferredProvider || 'deepseek';
  const preset = PROVIDER_PRESETS[provider];
  const providerSource = overrides.provider
    ? 'cli'
    : activeConfig.provider
      ? activeConfigSource('provider')
      : inferredProvider
        ? 'baseUrl'
        : 'default';
  const workspaceEnv = env.MOSS_WORKSPACE;

  // ── v0.26 permission mode resolution (PRD 2026-10-08 W1 / design §3.3) ──
  // Chain: overrides (CLI flags → safetyMode/approvalPolicy override fields,
  // args.ts maps them to mode-override semantics) > env compat keys > config
  // permissions.defaultMode > legacy-key migration > default full.
  const safetyModeEnv = env.MOSS_SAFETY_MODE || env.MOSS_CLI_SAFETY_MODE;
  const envSafetyMode = normalizeSafetyModeConfig(safetyModeEnv);

  const approvalEnv =
    env.MOSS_CLI_AUTO_APPROVE === '1' || env.MOSS_AUTO_APPROVE === '1'
      ? 'never'
      : env.MOSS_APPROVAL_POLICY || env.MOSS_ASK_FOR_APPROVAL;
  const envApproval = normalizeApprovalPolicyConfig(approvalEnv);

  const legacyMigration = migrateLegacyPermissionConfig({
    profile:
      activeConfig.profile !== undefined && configProfile !== undefined
        ? String(activeConfig.profile)
        : undefined,
    safetyMode: typeof activeConfig.safetyMode === 'string' ? activeConfig.safetyMode : undefined,
    approvalPolicy:
      typeof activeConfig.approvalPolicy === 'string' ? activeConfig.approvalPolicy : undefined,
    trustedTools: Array.isArray(activeConfig.trustedTools)
      ? [...activeConfig.trustedTools]
      : undefined,
    deniedTools: Array.isArray(activeConfig.deniedTools)
      ? [...activeConfig.deniedTools]
      : undefined,
  });

  const configPermissionsMode = parseCliInteractionMode(
    typeof activeConfig.permissions?.defaultMode === 'string'
      ? activeConfig.permissions.defaultMode
      : undefined
  );

  // Mode-override layers, first match wins: overrides > env > permissions block
  // > legacy migration > default full (§3.3 mapping table). read-only inputs
  // (flag/env/migration) additionally arm the ceiling and map to manual.
  let resolvedMode: CliInteractionMode | undefined;
  let modeSource: string | undefined;
  let readOnlyCeiling = false;
  let ceilingSource: string | undefined;

  if (overrides.safetyMode !== undefined || overrides.approvalPolicy !== undefined) {
    // CLI flags reach resolveCliConfig as override fields with mode-override
    // semantics (args.ts performs the flag → mode mapping and conflict checks).
    const safety = overrides.safetyMode;
    const approval = overrides.approvalPolicy;
    if (safety === 'read-only') {
      resolvedMode = 'manual';
      readOnlyCeiling = true;
    } else if (safety !== undefined) {
      resolvedMode = modeFromLegacySafetyPair(safety, approval);
    } else if (approval !== undefined) {
      // --ask-for-approval=never alone → full; prompt → manual (§3.3).
      resolvedMode = approval === 'never' ? 'full' : 'manual';
    } else {
      resolvedMode = 'manual';
    }
    modeSource = 'cli';
    if (safety === 'read-only') ceilingSource = 'cli';
  } else if (envSafetyMode !== null) {
    if (envSafetyMode === 'read-only') {
      resolvedMode = 'manual';
      readOnlyCeiling = true;
      ceilingSource = env.MOSS_SAFETY_MODE ? 'MOSS_SAFETY_MODE' : 'MOSS_CLI_SAFETY_MODE';
    } else {
      resolvedMode = modeFromLegacySafetyPair(envSafetyMode, undefined);
    }
    modeSource = env.MOSS_SAFETY_MODE ? 'MOSS_SAFETY_MODE' : 'MOSS_CLI_SAFETY_MODE';
  } else if (envApproval !== null) {
    // env MOSS_APPROVAL_POLICY=never / MOSS_CLI_AUTO_APPROVE=1 → full;
    // prompt → manual (design §3.3 mapping table).
    resolvedMode = envApproval === 'never' ? 'full' : 'manual';
    modeSource =
      env.MOSS_CLI_AUTO_APPROVE === '1'
        ? 'MOSS_CLI_AUTO_APPROVE'
        : env.MOSS_AUTO_APPROVE === '1'
          ? 'MOSS_AUTO_APPROVE'
          : env.MOSS_APPROVAL_POLICY
            ? 'MOSS_APPROVAL_POLICY'
            : 'MOSS_ASK_FOR_APPROVAL';
  } else if (configPermissionsMode !== null) {
    resolvedMode = configPermissionsMode;
    modeSource = 'config';
  } else if (legacyMigration.defaultMode !== undefined) {
    resolvedMode = legacyMigration.defaultMode;
    modeSource = 'legacy';
    if (legacyMigration.ceiling === 'read-only') {
      readOnlyCeiling = true;
      ceilingSource = 'legacy';
    }
  }

  const defaultMode: CliInteractionMode = resolvedMode ?? DEFAULT_CLI_INTERACTION_MODE;
  const permissionsSource = modeSource ?? 'default';
  if (legacyMigration.ceiling === 'read-only' && !readOnlyCeiling) {
    // A legacy read-only pair arms the ceiling even when a stronger layer
    // already fixed the mode (the ceiling only tightens; it never conflicts).
    readOnlyCeiling = true;
    ceilingSource = ceilingSource ?? 'legacy';
  }

  // Derived outputs (design §1.2): safetyMode/approvalPolicy are now read
  // projections of the mode. Source stays 'derived:mode' unless an embed host
  // explicitly set the fields via overrides — the profile no longer owns them.
  const quantas = deriveEngineQuantas(defaultMode);
  const safetyMode: CliSafetyModeConfig = readOnlyCeiling ? 'read-only' : quantas.safetyMode;
  const safetyModeSource = ceilingSource ?? 'derived:mode';
  const approvalPolicy: ConfigApprovalPolicy = quantas.approvalPolicy;
  const approvalPolicySource = 'derived:mode';

  // Rule lists: permissions block wins (new canonical surface); the legacy
  // trustedTools/deniedTools keys translate to whole-tool rules and merge in.
  const permissionsBlock = activeConfig.permissions;
  const envTrustedTools = parseTrustedTools(env.MOSS_TRUSTED_TOOLS);
  const configTrustedTools = Array.isArray(activeConfig.trustedTools)
    ? parseTrustedTools(activeConfig.trustedTools)
    : undefined;
  const trustedTools =
    overrides.trustedTools ?? envTrustedTools ?? configTrustedTools ?? profileDefaults.trustedTools;
  const trustedToolsSource = overrides.trustedTools
    ? 'cli'
    : envTrustedTools
      ? 'MOSS_TRUSTED_TOOLS'
      : configTrustedTools
        ? 'config'
        : `profile:${profile}`;
  const envDeniedTools = parseTrustedTools(env.MOSS_DENIED_TOOLS);
  const configDeniedTools = Array.isArray(activeConfig.deniedTools)
    ? parseTrustedTools(activeConfig.deniedTools)
    : undefined;
  const deniedTools = overrides.deniedTools ?? envDeniedTools ?? configDeniedTools ?? [];
  const deniedToolsSource = overrides.deniedTools
    ? 'cli'
    : envDeniedTools
      ? 'MOSS_DENIED_TOOLS'
      : configDeniedTools
        ? 'config'
        : 'default';

  const permissionsAllow = [
    ...new Set([...(permissionsBlock?.allow ?? []), ...legacyMigration.allowRules]),
  ];
  const permissionsAsk = [...new Set([...(permissionsBlock?.ask ?? [])])];
  const permissionsDeny = [
    ...new Set([...(permissionsBlock?.deny ?? []), ...legacyMigration.denyRules]),
  ];
  const permissionsView: ResolvedPermissionsView = {
    defaultMode,
    readOnlyCeiling,
    allow: permissionsAllow,
    ask: permissionsAsk,
    deny: permissionsDeny,
    legacyKeysUsed: [...legacyMigration.legacyKeysUsed],
    source: permissionsSource,
  };

  const promptCacheEnv = env.MOSS_PROMPT_CACHE ?? env.MOSS_PROMPT_CACHE_ENABLED;
  const envPromptCache = parseConfigBoolean(promptCacheEnv);
  const promptCacheDebugEnv = env.MOSS_PROMPT_CACHE_DEBUG ?? env.MOSS_PROMPT_PREFIX_DEBUG;
  const envPromptCacheDebug = parseConfigBoolean(promptCacheDebugEnv);
  const configPromptCache =
    typeof activeConfig.promptCache === 'boolean'
      ? activeConfig.promptCache
      : activeConfig.promptCache &&
          typeof activeConfig.promptCache === 'object' &&
          typeof activeConfig.promptCache.enabled === 'boolean'
        ? activeConfig.promptCache.enabled
        : undefined;
  const configPromptCacheDebug =
    activeConfig.promptCache &&
    typeof activeConfig.promptCache === 'object' &&
    typeof activeConfig.promptCache.debug === 'boolean'
      ? activeConfig.promptCache.debug
      : undefined;
  const promptCacheEnabled =
    overrides.promptCacheEnabled ??
    envPromptCache ??
    configPromptCache ??
    profileDefaults.promptCacheEnabled;
  const promptCacheSource =
    overrides.promptCacheEnabled !== undefined
      ? 'cli'
      : envPromptCache !== null
        ? env.MOSS_PROMPT_CACHE !== undefined
          ? 'MOSS_PROMPT_CACHE'
          : 'MOSS_PROMPT_CACHE_ENABLED'
        : configPromptCache !== undefined
          ? 'config'
          : `profile:${profile}`;
  const promptCacheDebug =
    overrides.promptCacheDebug ??
    envPromptCacheDebug ??
    configPromptCacheDebug ??
    profileDefaults.promptCacheDebug;
  const promptCacheDebugSource =
    overrides.promptCacheDebug !== undefined
      ? 'cli'
      : envPromptCacheDebug !== null
        ? env.MOSS_PROMPT_CACHE_DEBUG !== undefined
          ? 'MOSS_PROMPT_CACHE_DEBUG'
          : 'MOSS_PROMPT_PREFIX_DEBUG'
        : configPromptCacheDebug !== undefined
          ? 'config'
          : `profile:${profile}`;
  const guardrails = normalizeGuardrailsConfig(activeConfig.guardrails);
  const guardrailsSource = hasGuardrails(guardrails) ? 'config' : 'default';
  const configMaxAgentTurns = parsePositiveInteger(activeConfig.agent?.maxTurns, 'agent.maxTurns');
  const envMaxAgentTurns = parsePositiveIntegerEnv(env.MOSS_MAX_AGENT_TURNS);
  const maxAgentTurns = resolveMossMaxAgentTurns(
    String(overrides.maxAgentTurns ?? envMaxAgentTurns ?? configMaxAgentTurns ?? '')
  );
  const maxAgentTurnsSource =
    overrides.maxAgentTurns !== undefined
      ? 'cli'
      : envMaxAgentTurns !== undefined
        ? 'MOSS_MAX_AGENT_TURNS'
        : configMaxAgentTurns !== undefined
          ? 'config'
          : 'default';
  const configContextTokens = parsePositiveInteger(
    activeConfig.agent?.contextTokens,
    'agent.contextTokens'
  );
  const envContextTokens = parsePositiveIntegerEnv(env.MOSS_CONTEXT_TOKENS);
  // Do NOT call resolveModelContextWindow here — that table is stale and must
  // not be a source of truth. Instead, contextTokens is left undefined until
  // the CLI startup probe (cli-main.ts) fills it in from the provider API.
  // Source 'unprobed' signals to doctor / /model that a real probe is needed.
  const contextTokens =
    overrides.contextTokens ??
    envContextTokens ??
    configContextTokens ??
    CONSERVATIVE_DEFAULT_UNPROBED;
  const contextTokensSource =
    overrides.contextTokens !== undefined
      ? 'cli'
      : envContextTokens !== undefined
        ? 'MOSS_CONTEXT_TOKENS'
        : configContextTokens !== undefined
          ? 'config'
          : 'unprobed';
  // Max output tokens per response. Host/user can pin via agent.maxOutputTokens
  // or MOSS_MAX_OUTPUT_TOKENS. If unset, leave undefined here — the runtime
  // derives a default from the (probed) context window so it scales with the
  // model, instead of the old hardcoded 4096 that truncated long answers.
  const configMaxOutputTokens = parsePositiveInteger(
    activeConfig.agent?.maxOutputTokens,
    'agent.maxOutputTokens'
  );
  const envMaxOutputTokens = parsePositiveIntegerEnv(env.MOSS_MAX_OUTPUT_TOKENS);
  const maxOutputTokens =
    overrides.maxOutputTokens ?? envMaxOutputTokens ?? configMaxOutputTokens ?? undefined;
  const configCompactionReserve = parsePositiveInteger(
    activeConfig.agent?.compaction?.reserveTokens,
    'agent.compaction.reserveTokens'
  );
  const configCompactionKeepRecent = parsePositiveInteger(
    activeConfig.agent?.compaction?.keepRecentTokens,
    'agent.compaction.keepRecentTokens'
  );
  const compactionSettings = {
    reserveTokens: configCompactionReserve ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: configCompactionKeepRecent ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
  const compactionSettingsSource =
    configCompactionReserve !== undefined || configCompactionKeepRecent !== undefined
      ? 'config'
      : 'default';
  const envBudgetNum = (name: string): number | undefined => {
    const raw = env[name];
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const budgetMaxTokens =
    envBudgetNum('MOSS_BUDGET_MAX_TOKENS') ?? activeConfig.agent?.budget?.maxTokens;
  const budgetMaxToolCalls =
    envBudgetNum('MOSS_BUDGET_MAX_TOOL_CALLS') ?? activeConfig.agent?.budget?.maxToolCalls;
  const budgetMaxTurns =
    envBudgetNum('MOSS_BUDGET_MAX_TURNS') ?? activeConfig.agent?.budget?.maxTurns;
  const budgetMaxWallMs =
    envBudgetNum('MOSS_BUDGET_MAX_WALL_MS') ?? activeConfig.agent?.budget?.maxWallMs;
  const envBestOfN = envBudgetNum('MOSS_BEST_OF_N');
  const bestOfN =
    envBestOfN !== undefined && envBestOfN >= 2
      ? Math.min(5, envBestOfN)
      : activeConfig.agent?.bestOfN && activeConfig.agent.bestOfN >= 2
        ? Math.min(5, activeConfig.agent.bestOfN)
        : undefined;
  const envModelTier = (name: string): string | undefined => {
    const raw = (env[name] ?? '').trim();
    return raw || undefined;
  };
  const modelTiers = {
    ...(envModelTier('MOSS_MODEL_CHEAP') ? { cheap: envModelTier('MOSS_MODEL_CHEAP') } : {}),
    ...(envModelTier('MOSS_MODEL_BALANCED')
      ? { balanced: envModelTier('MOSS_MODEL_BALANCED') }
      : {}),
    ...(envModelTier('MOSS_MODEL_STRONG') ? { strong: envModelTier('MOSS_MODEL_STRONG') } : {}),
    ...(activeConfig.agent?.modelTiers ?? {}),
  };
  const hasModelTiers = Object.keys(modelTiers).length > 0;
  const rawReasoningBudget = (env.MOSS_REASONING_BUDGET ?? '').toLowerCase().trim();
  const reasoningBudget =
    rawReasoningBudget === 'off' ||
    rawReasoningBudget === 'adaptive' ||
    rawReasoningBudget === 'high'
      ? rawReasoningBudget
      : activeConfig.agent?.reasoningBudget;
  const runBudget =
    budgetMaxTokens !== undefined ||
    budgetMaxToolCalls !== undefined ||
    budgetMaxTurns !== undefined ||
    budgetMaxWallMs !== undefined
      ? {
          ...(budgetMaxTokens !== undefined ? { maxTokens: budgetMaxTokens } : {}),
          ...(budgetMaxToolCalls !== undefined ? { maxToolCalls: budgetMaxToolCalls } : {}),
          ...(budgetMaxTurns !== undefined ? { maxTurns: budgetMaxTurns } : {}),
          ...(budgetMaxWallMs !== undefined ? { maxWallMs: budgetMaxWallMs } : {}),
        }
      : undefined;
  return {
    profile,
    profileSource,
    provider,
    providerSource,
    apiKey: activeConfig.apiKey || '',
    apiKeySource: activeConfig.apiKey ? activeConfigSource('apiKey') : 'missing',
    usingBundledDefault,
    ...(bundledDefaultSuppressedBy ? { bundledDefaultSuppressedBy } : {}),
    ignoredModelEnvVars,
    model: overrides.model || activeConfig.model || preset.defaultModel,

    modelSource: overrides.model
      ? 'cli'
      : activeConfig.model
        ? activeConfigSource('model')
        : preset.defaultModel
          ? 'provider default'
          : 'missing',
    baseUrl: overrides.baseUrl || activeConfig.baseUrl || preset.defaultBaseUrl,
    baseUrlSource: overrides.baseUrl
      ? 'cli'
      : activeConfig.baseUrl
        ? activeConfigSource('baseUrl')
        : 'provider default',
    workspace: overrides.workspace || workspaceEnv || activeConfig.workspace || safeCwd.cwd,
    workspaceSource: overrides.workspace
      ? 'cli'
      : workspaceEnv
        ? 'MOSS_WORKSPACE'
        : activeConfig.workspace
          ? 'config'
          : safeCwd.source,
    safetyMode,
    safetyModeSource,
    approvalPolicy,
    approvalPolicySource,
    permissions: permissionsView,
    trustedTools: [...trustedTools],
    trustedToolsSource,
    deniedTools: [...deniedTools],
    deniedToolsSource,
    promptCacheEnabled,
    promptCacheSource,
    promptCacheDebug,
    promptCacheDebugSource,
    guardrails,
    guardrailsSource,
    maxAgentTurns,
    maxAgentTurnsSource,
    contextTokens,
    contextTokensSource,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    compactionSettings,
    ...(runBudget ? { budget: runBudget } : {}),
    ...(bestOfN !== undefined ? { bestOfN } : {}),
    ...(reasoningBudget ? { reasoningBudget } : {}),
    ...(hasModelTiers ? { modelTiers } : {}),
    compactionSettingsSource,
    configPath: configPaths?.configPath ?? resolveConfigPath(undefined, env),
    projectConfigPath: configPaths?.projectConfigPath,
    apiKeyEncrypted: activeConfig._apiKeyEncrypted || false,
  };
}

export function loadEnvFile(envPath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadEnvFromAncestors(startDir: string, maxHops = 16): void {
  let dir = resolvePathFromSafeCwd(startDir);
  for (let i = 0; i < maxHops; i++) {
    loadEnvFile(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadEnvFromAncestors(safeProcessCwd());
loadEnvFromAncestors(path.dirname(fileURLToPath(import.meta.url)));

function loadResolvedConfigForModuleDefaults(): ResolvedCliConfig {
  try {
    const loadedConfigFile = loadCliConfigFile();
    return resolveCliConfig(process.env, loadedConfigFile.config, {}, loadedConfigFile);
  } catch {
    const configPath = resolveConfigPath();
    return resolveCliConfig(process.env, {}, {}, { configPath });
  }
}

const resolvedConfig = loadResolvedConfigForModuleDefaults();

export const API_KEY = resolvedConfig.apiKey;
export const BASE_URL = resolvedConfig.baseUrl;
export const WORKSPACE = resolvedConfig.workspace;
