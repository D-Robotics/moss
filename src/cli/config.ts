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
  isOfficialPresetBaseUrl,
} from '../provider/provider-presets.js';
import {
  DEFAULT_CLI_INTERACTION_MODE,
  deriveEngineQuantas,
  modeFromLegacySafetyPair,
  parseCliInteractionMode,
  type CliInteractionMode,
} from './interaction-mode.js';
import { isDotenvDeniedEnvKey } from '../utils/dotenv-denied-env.js';
import { isDotenvSafetyEnvKey, noteDotenvSafetyEnvKey } from '../safety/dotenv-safety-env.js';
import { uiText } from '../utils/ui-language.js';
import { zhConfigSource } from './config-source-label.js';
import { isProjectRoutingEnvKey } from '../utils/project-routing-env.js';
import { getPackageJsonPath } from '../utils/package-info.js';
import {
  endpointHost,
  officialBaseUrl,
  primaryKeyAllowedForHost,
} from '../provider/primary-key-host.js';
import { isFolderTrusted, folderPathKey } from './folder-trust-store.js';
import {
  captureEnvBeforeDotenv,
  envBeforeDotenv,
  isStartupEnvCaptured,
  recordDotenvOrigin,
} from '../utils/startup-env.js';
import { officialEnvOffers } from './env-credentials.js';
import { setupCopy } from './cli-locale.js';
import { isDeviceTrustEnv, parseDeviceTrustList } from '../safety/device-trust.js';
import type { PricingConfig } from './model-pricing.js';
import type { StatusLineConfig } from './status-line.js';

export { envBeforeDotenv };
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

/**
 * Copy of `process.env` taken before any project `.env` is applied.
 * Trust and config-dir resolution read this, so a project `.env` cannot
 * redirect `XDG_CONFIG_HOME`, `HOME`, `APPDATA`, or `USERPROFILE`.
 * `MOSS_CONFIG_DIR` / `FILE` / `PATH` stay live: `.env` cannot set them, and
 * in-process overrides (approval persist, tests) must still select a directory.
 * The object itself lives in `startup-env.ts` so child spawns can see it.
 */
let homeBeforeDotenv = '';

const LIVE_CONFIG_LOCATION_KEYS = [
  'MOSS_CONFIG_DIR',
  'MOSS_CONFIG_FILE',
  'MOSS_CONFIG_PATH',
] as const;

export function startupHomeDir(): string {
  return homeBeforeDotenv;
}

function locationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env !== process.env && env !== envBeforeDotenv) return env;
  const source: NodeJS.ProcessEnv = { ...envBeforeDotenv };
  for (const key of LIVE_CONFIG_LOCATION_KEYS) {
    const live = process.env[key];
    if (live === undefined) delete source[key];
    else source[key] = live;
  }
  return source;
}

function homeFrom(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const named = platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return homeBeforeDotenv;
}

export function resolveConfigDir(
  env: NodeJS.ProcessEnv = envBeforeDotenv,
  platform: NodeJS.Platform = process.platform
): string {
  const source = locationEnv(env);
  const explicit = source.MOSS_CONFIG_DIR;
  if (explicit) return explicit;
  const home = homeFrom(source, platform);
  const base =
    platform === 'win32'
      ? source.APPDATA || path.join(home, 'AppData', 'Roaming')
      : source.XDG_CONFIG_HOME || path.join(home, '.config');
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
  /**
   * Name of an environment variable that holds this config's own API key.
   * A project file may set it so a foreign project base URL does not reuse
   * the user's primary key. The value is read at resolve time and is never
   * written back into the config file.
   */
  apiKeyEnv?: string;

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
  /**
   * Built-in rdk-docs MCP. On unless `enabled: false` or MOSS_NO_RDK_DOCS=1.
   * The legacy boolean form remains supported. `package` accepts an npm spec
   * or a local directory/tarball. MOSS_RDK_DOCS_PACKAGE (process env only)
   * overrides `package`. A project config cannot set `package`.
   */
  rdkDocs?: boolean | RdkDocsConfig;
  /**
   * Per-model prices for gateway and custom models, per 1M tokens.
   * Built-in prices cover common DeepSeek, Qwen, OpenAI, and Anthropic ids.
   * Example: `{ "models": { "my-model": { "input": 2, "output": 8, "cached": 0.2, "currency": "CNY" } } }`.
   */
  pricing?: PricingConfig;
  /**
   * Status-line fields (`model`, `cwd`, `tokens`, `cost`, `context`, `device`,
   * `task`) and an optional `command` whose stdout replaces the line.
   */
  statusLine?: StatusLineConfig;
  /**
   * UI language for chrome, help, errors, and setup text. `auto` (the default
   * when unset) follows the system locale: Chinese only when it starts with
   * `zh`; `C`, `POSIX`, `C.UTF-8`, and unset stay English. User config only —
   * a project config cannot set this. Assistant replies are not affected.
   */
  language?: 'auto' | 'en' | 'zh';
  _examples?: Record<string, unknown>;
}

export interface RdkDocsConfig {
  enabled?: boolean;
  package?: string;
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
  /**
   * `full` opts every device into the destructive tier (reboot, flash, system
   * paths). Absent or `gated` keeps the safe default. A project file may set
   * `gated` to tighten the user, and cannot set `full`.
   */
  deviceTrust?: 'gated' | 'full' | string;
  /**
   * Hosts or device ids that may run the destructive tier without a prompt.
   * A project file cannot add an id the user did not already list.
   */
  trustedDevices?: string[];
}

export interface LoadedCliConfigFile {
  config: ConfigFile;
  configPath: string;
  projectConfigPath?: string;
  /** Which file won each field that config show labels. Absent when unknown. */
  fieldSources?: Record<string, 'user' | 'project'>;
  /** Project routing fields dropped because the folder is not trusted. */
  ignoredProjectRouting?: string[];
  /**
   * Project permission fields that would loosen the user's mode, dropped
   * because the folder is not trusted. Includes allow, defaultMode,
   * deviceTrust, trustedDevices, trustedTools, and a looser profile.
   * `deny` and `ask` are not in this list.
   */
  droppedProjectPermissions?: string[];
  /**
   * Project base URL whose host is neither the user's nor an official
   * provider URL, and which did not bring its own key.
   */
  blockedProjectBaseUrl?: string;
  userApiKey?: string;
  userBaseUrl?: string;
  userProvider?: string;
  /** Unmerged user file. Env-key reads use this layer, never the project file. */
  userConfig?: ConfigFile;
  /** Unmerged project file. Its apiKeyEnv and endpoint must not read env keys. */
  projectConfig?: ConfigFile;
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
   * the model and the probed context window. A global pin is also the ceiling:
   * truncation recovery will not raise it. */
  maxOutputTokens?: number;
  /**
   * Per-model output cap. Replaces the built-in table for that model id
   * (exact or prefix). Example: `{ "glm-5.3": { "maxOutputTokens": 32768 } }`.
   */
  models?: Record<string, { maxOutputTokens?: number }>;
  compaction?: Partial<Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>>;
}

export interface HookCommandConfig {
  matcher?: string;

  command: string;

  timeoutMs?: number;

  blocking?: boolean;

  /**
   * Claude-format command hooks block only on exit code 2 and match Claude
   * tool names (Bash, Edit, …). Moss-native hooks omit this and block on any
   * non-zero exit.
   */
  format?: 'claude';
}

export interface HooksConfig {
  PreToolUse?: HookCommandConfig[];

  PostToolUse?: HookCommandConfig[];

  /** Fires when the user submits a prompt, before the run starts. */
  UserPromptSubmit?: HookCommandConfig[];

  /** Fires when a tool approval would be shown. Deny is honored; allow is not. */
  PermissionRequest?: HookCommandConfig[];

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

export const HOOK_EVENT_KEYS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PermissionRequest',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'Notification',
] as const satisfies readonly (keyof HooksConfig)[];

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
  /** `--trust-device`: this process may run destructive device operations. */
  deviceTrust?: 'full';
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
  const source = locationEnv(env);
  const fromArgv = resolveCliConfigFileArg(argv, source);
  if (fromArgv) return fromArgv;
  const explicit = source.MOSS_CONFIG_FILE || source.MOSS_CONFIG_PATH;
  return explicit && explicit.trim() ? resolvePathFromSafeCwd(explicit, source) : null;
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
  const source = locationEnv(env);
  if (configDir) return path.join(configDir, 'config.json');
  return (
    resolveExplicitConfigPath(source, argv) || path.join(resolveConfigDir(source), 'config.json')
  );
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

function mergeModelOutputConfigs(
  user: AgentRuntimeConfig['models'],
  project: AgentRuntimeConfig['models']
): AgentRuntimeConfig['models'] {
  if (!user && !project) return undefined;
  const merged: NonNullable<AgentRuntimeConfig['models']> = { ...project, ...user };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeAgentRuntimeConfig(
  userAgent: ConfigFile['agent'],
  projectAgent: ConfigFile['agent']
): ConfigFile['agent'] {
  if (!projectAgent && !userAgent) return undefined;
  const models = mergeModelOutputConfigs(userAgent?.models, projectAgent?.models);
  return {
    ...userAgent,
    ...projectAgent,
    compaction: {
      ...userAgent?.compaction,
      ...projectAgent?.compaction,
    },
    ...(models ? { models } : {}),
  };
}

export function mergeHooksConfig(
  user?: HooksConfig,
  project?: HooksConfig
): HooksConfig | undefined {
  if (!project && !user) return undefined;
  const merged: HooksConfig = {};
  let any = false;
  for (const key of HOOK_EVENT_KEYS) {
    const list = [...(project?.[key] ?? []), ...(user?.[key] ?? [])];
    if (list.length === 0) continue;
    merged[key] = list;
    any = true;
  }
  return any ? merged : undefined;
}

const PROJECT_ROUTING_CONFIG_KEYS = [
  'provider',
  'baseUrl',
  'apiKey',
  'apiKeyEnv',
  'model',
] as const;

/** Routing fields a project file set. Used for the untrusted-folder notice. */
export function listProjectRoutingConfigFields(project: ConfigFile): string[] {
  const ignored: string[] = [];
  for (const key of PROJECT_ROUTING_CONFIG_KEYS) {
    if (project[key] !== undefined) ignored.push(key);
  }
  const tiers = project.agent?.modelTiers;
  if (tiers && Object.keys(tiers).length > 0) ignored.push('modelTiers');
  if (project.agent?.maxOutputTokens !== undefined) ignored.push('maxOutputTokens');
  const models = project.agent?.models;
  if (models && Object.keys(models).length > 0) ignored.push('models');
  return ignored;
}

function omitProjectRoutingConfig(project: ConfigFile): ConfigFile {
  const next: ConfigFile = { ...project };
  for (const key of PROJECT_ROUTING_CONFIG_KEYS) delete next[key];
  if (next.agent) {
    // A project cap can force a truncation or reserve most of the context
    // window. An untrusted folder does not get to set either knob. User
    // config, the process environment, and a trusted project still can.
    const { modelTiers: _tiers, maxOutputTokens: _cap, models: _models, ...rest } = next.agent;
    next.agent = Object.keys(rest).length > 0 ? rest : undefined;
  }
  return next;
}

function permissionRuleListLoosens(value: unknown): boolean {
  return (
    Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

const PROFILE_PERMISSIVENESS: Record<CliConfigProfile, number> = {
  cautious: 0,
  balanced: 1,
  autonomous: 2,
};

/**
 * `autonomous` injects exec/apply_patch grants. A higher project profile also
 * replaces a stricter user profile via the project-over-user spread. cautious
 * and balanced only tighten an unset user profile, so those stay.
 */
function projectProfileLoosens(user: ConfigFile, project: ConfigFile): boolean {
  const projectProfile = normalizeConfigProfile(
    typeof project.profile === 'string' ? project.profile : undefined
  );
  if (!projectProfile) return false;
  const userProfile = normalizeConfigProfile(
    typeof user.profile === 'string' ? user.profile : undefined
  );
  if (!userProfile) return projectProfile === 'autonomous';
  return PROFILE_PERMISSIVENESS[projectProfile] > PROFILE_PERMISSIVENESS[userProfile];
}

/**
 * Project fields that grant tools, trust a device, or replace the permission
 * mode. An untrusted folder drops these. `permissions.ask` and
 * `permissions.deny` only tighten, so they are not listed. A project profile
 * is listed only when it is looser than the user's. Device trust is never
 * taken from an untrusted folder, so any set `deviceTrust` or
 * `trustedDevices` list is listed.
 */
function listDroppedProjectPermissionFields(user: ConfigFile, project: ConfigFile): string[] {
  const dropped: string[] = [];
  if (permissionRuleListLoosens(project.permissions?.allow)) dropped.push('permissions.allow');
  if (permissionRuleListLoosens(project.trustedTools)) dropped.push('trustedTools');
  const mode = project.permissions?.defaultMode;
  if (typeof mode === 'string' && mode.trim().length > 0) dropped.push('permissions.defaultMode');
  const deviceTrust = project.permissions?.deviceTrust;
  if (typeof deviceTrust === 'string' && deviceTrust.trim().length > 0) {
    dropped.push('permissions.deviceTrust');
  }
  if (permissionRuleListLoosens(project.permissions?.trustedDevices)) {
    dropped.push('permissions.trustedDevices');
  }
  if (projectProfileLoosens(user, project)) dropped.push('profile');
  return dropped;
}

function omitLooseningProjectPermissions(user: ConfigFile, project: ConfigFile): ConfigFile {
  const next: ConfigFile = { ...project };
  if (permissionRuleListLoosens(next.trustedTools)) delete next.trustedTools;
  if (projectProfileLoosens(user, project)) delete next.profile;
  if (!next.permissions) return next;
  const permissions: PermissionsConfig = { ...next.permissions };
  let changed = false;
  if (permissionRuleListLoosens(permissions.allow)) {
    delete permissions.allow;
    changed = true;
  }
  if (typeof permissions.defaultMode === 'string' && permissions.defaultMode.trim().length > 0) {
    delete permissions.defaultMode;
    changed = true;
  }
  if (typeof permissions.deviceTrust === 'string' && permissions.deviceTrust.trim().length > 0) {
    delete permissions.deviceTrust;
    changed = true;
  }
  if (permissionRuleListLoosens(permissions.trustedDevices)) {
    delete permissions.trustedDevices;
    changed = true;
  }
  if (!changed) return next;
  const remaining = Object.values(permissions).some((value) => value !== undefined);
  next.permissions = remaining ? permissions : undefined;
  return next;
}

function setFieldSource(
  sources: Record<string, 'user' | 'project'>,
  field: string,
  userHas: boolean,
  projectHas: boolean,
  userWins: boolean
): void {
  if (!userHas && !projectHas) return;
  sources[field] = userWins ? (userHas ? 'user' : 'project') : projectHas ? 'project' : 'user';
}

export function fieldSourcesFor(
  user: ConfigFile,
  project: ConfigFile
): Record<string, 'user' | 'project'> {
  const sources: Record<string, 'user' | 'project'> = {};
  const mark = (field: string, userHas: boolean, projectHas: boolean, userWins = false): void =>
    setFieldSource(sources, field, userHas, projectHas, userWins);
  mark('provider', user.provider !== undefined, project.provider !== undefined);
  mark('model', user.model !== undefined, project.model !== undefined);
  mark('baseUrl', user.baseUrl !== undefined, project.baseUrl !== undefined);
  mark(
    'apiKey',
    user.apiKey !== undefined,
    project.apiKey !== undefined || project.apiKeyEnv !== undefined
  );
  mark('profile', user.profile !== undefined, project.profile !== undefined);
  mark('workspace', user.workspace !== undefined, project.workspace !== undefined);
  mark('safetyMode', user.safetyMode !== undefined, project.safetyMode !== undefined, true);
  mark(
    'approvalPolicy',
    user.approvalPolicy !== undefined,
    project.approvalPolicy !== undefined,
    true
  );
  mark('trustedTools', user.trustedTools !== undefined, project.trustedTools !== undefined, true);
  mark('deniedTools', user.deniedTools !== undefined, project.deniedTools !== undefined, true);
  mark('permissions', user.permissions !== undefined, project.permissions !== undefined, true);
  mark(
    'permissions.defaultMode',
    user.permissions?.defaultMode !== undefined,
    project.permissions?.defaultMode !== undefined,
    true
  );
  mark('promptCache', user.promptCache !== undefined, project.promptCache !== undefined, true);
  mark('guardrails', user.guardrails !== undefined, project.guardrails !== undefined, true);
  mark('agent.maxTurns', user.agent?.maxTurns !== undefined, project.agent?.maxTurns !== undefined);
  mark(
    'agent.contextTokens',
    user.agent?.contextTokens !== undefined,
    project.agent?.contextTokens !== undefined
  );
  mark(
    'agent.compaction',
    user.agent?.compaction !== undefined,
    project.agent?.compaction !== undefined
  );
  const userTiers = user.agent?.modelTiers;
  const projectTiers = project.agent?.modelTiers;
  mark(
    'agent.modelTiers',
    userTiers !== undefined && Object.keys(userTiers).length > 0,
    projectTiers !== undefined && Object.keys(projectTiers).length > 0
  );
  return sources;
}

/**
 * True when `name` is the user's own key variable: their `apiKeyEnv`,
 * `MOSS_API_KEY`, or a provider preset key such as `DEEPSEEK_API_KEY`.
 * A project file that names one of these is still the user's key.
 */
function namesUserKeyEnv(name: string, user: ConfigFile): boolean {
  const upper = name.toUpperCase();
  if (typeof user.apiKeyEnv === 'string' && user.apiKeyEnv.trim().toUpperCase() === upper) {
    return true;
  }
  if (upper === 'MOSS_API_KEY') return true;
  return Object.values(PROVIDER_PRESETS).some((preset) =>
    (preset.envKeys ?? []).some((key) => key.toUpperCase() === upper)
  );
}

/**
 * The user's primary key stays on the user's host and on official provider
 * URLs. A project base URL on any other host keeps only a key the project
 * itself supplied.
 */
function guardPrimaryKey(project: ConfigFile, user: ConfigFile, merged: ConfigFile): ConfigFile {
  const provider = typeof merged.provider === 'string' ? merged.provider : undefined;
  const base = (typeof merged.baseUrl === 'string' && merged.baseUrl) || officialBaseUrl(provider);
  const host = endpointHost(base);
  const allowed =
    !host ||
    primaryKeyAllowedForHost(host, {
      ...(typeof user.baseUrl === 'string' ? { baseUrl: user.baseUrl } : {}),
      ...(typeof user.provider === 'string' ? { provider: user.provider } : {}),
    });
  const projectKey = typeof project.apiKey === 'string' ? project.apiKey : undefined;
  const userKey = typeof user.apiKey === 'string' ? user.apiKey : undefined;
  if (!allowed) {
    if (projectKey && projectKey !== userKey) {
      merged.apiKey = projectKey;
      merged._apiKeyEncrypted = project._apiKeyEncrypted;
    } else {
      delete merged.apiKey;
      delete merged._apiKeyEncrypted;
    }
    const projectEnv = typeof project.apiKeyEnv === 'string' ? project.apiKeyEnv.trim() : '';
    if (projectEnv && !namesUserKeyEnv(projectEnv, user)) merged.apiKeyEnv = projectEnv;
    else delete merged.apiKeyEnv;
    return merged;
  }
  if (projectKey) {
    merged.apiKey = projectKey;
    merged._apiKeyEncrypted = project._apiKeyEncrypted;
  } else if (userKey) {
    merged.apiKey = userKey;
    merged._apiKeyEncrypted = user._apiKeyEncrypted;
  }
  return merged;
}

export function mergeConfigFiles(
  projectConfig: ConfigFile,
  userConfig: ConfigFile,
  options?: { allowProjectStatusCommand?: boolean }
): ConfigFile {
  const merged = guardPrimaryKey(projectConfig, userConfig, {
    ...userConfig,
    ...projectConfig,
  });
  return {
    ...merged,
    // Safety-sensitive scalars: the user's config wins over the project's.
    // A cloned repo's .moss/config.json must not silently lower the user's
    // safety stance (e.g. approvalPolicy: 'never', safetyMode: 'full-access').
    // If the user hasn't set a scalar, the project value is still used.
    // trustedTools follows that rule: the user's array wins exactly. A trusted
    // project's list is used only when the user did not set one.
    // loadCliConfigFile removes an untrusted project's trustedTools,
    // permissions.allow, permissions.defaultMode, permissions.deviceTrust,
    // permissions.trustedDevices, and a looser profile before this merge, so
    // those grants cannot widen the user's mode. mergePermissionsConfig also
    // refuses a project deviceTrust of full and any trusted device the user
    // did not list, including in a trusted folder. CLI flags and env vars
    // override both (resolveCliConfig).
    safetyMode: userConfig.safetyMode ?? projectConfig.safetyMode,
    approvalPolicy: userConfig.approvalPolicy ?? projectConfig.approvalPolicy,
    trustedTools: userConfig.trustedTools ?? projectConfig.trustedTools,
    deniedTools: userConfig.deniedTools ?? projectConfig.deniedTools,
    permissions: mergePermissionsConfig(userConfig.permissions, projectConfig.permissions),
    promptCache: mergePromptCacheConfig(userConfig.promptCache, projectConfig.promptCache),
    guardrails: mergeGuardrailsConfig(userConfig.guardrails, projectConfig.guardrails),
    agent: mergeAgentRuntimeConfig(userConfig.agent, projectConfig.agent),
    hooks: mergeHooksConfig(userConfig.hooks, projectConfig.hooks),
    // A cloned project's config must not override an explicit user choice.
    // Merge object fields so a user can pin the executable package while a
    // project merely enables the integration (or vice versa).
    rdkDocs: mergeRdkDocsConfig(userConfig.rdkDocs, projectConfig.rdkDocs),
    pricing: mergePricingConfig(userConfig.pricing, projectConfig.pricing),
    statusLine: mergeStatusLine(
      userConfig.statusLine,
      projectConfig.statusLine,
      options?.allowProjectStatusCommand === true
    ),
    // UI language is a user preference. A cloned project's config cannot set it.
    language: userConfig.language,
  };
}

function mergePricingConfig(
  user: PricingConfig | undefined,
  project: PricingConfig | undefined
): PricingConfig | undefined {
  if (!user && !project) return undefined;
  return { models: { ...project?.models, ...user?.models } };
}

/** A project may enable or disable the builtin. It cannot choose the package. */
function projectRdkDocsWithoutPackage(project: ConfigFile['rdkDocs']): ConfigFile['rdkDocs'] {
  if (project === undefined || typeof project === 'boolean') return project;
  const { package: _package, ...rest } = project;
  return rest;
}

function mergeRdkDocsConfig(
  user: ConfigFile['rdkDocs'],
  project: ConfigFile['rdkDocs']
): ConfigFile['rdkDocs'] {
  const safeProject = projectRdkDocsWithoutPackage(project);
  if (user === undefined) return safeProject;
  if (typeof user === 'boolean') return user;
  if (safeProject === undefined || typeof safeProject === 'boolean') return user;
  return {
    ...safeProject,
    ...user,
    enabled: user.enabled ?? safeProject.enabled,
    ...(user.package !== undefined ? { package: user.package } : {}),
  };
}

/**
 * The user's status line wins outright. A project `command` is shell code, so
 * it is kept only after workspace trust (`allowProjectStatusCommand`).
 */
function mergeStatusLine(
  user: StatusLineConfig | undefined,
  project: StatusLineConfig | undefined,
  allowProjectCommand: boolean
): StatusLineConfig | undefined {
  if (user) return user;
  if (!project) return undefined;
  if (allowProjectCommand || !project.command?.trim()) return project;
  const { command: _command, ...rest } = project;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function unionOptionalStringList(
  user: string[] | undefined,
  project: string[] | undefined
): string[] | undefined {
  if (!user && !project) return undefined;
  return [...new Set([...(user ?? []), ...(project ?? [])])];
}

/**
 * A project `gated` tightens `full`. A project `full` never applies, trusted
 * folder or not. Any other project value is ignored.
 */
function mergePermissionDeviceTrust(
  user: PermissionsConfig['deviceTrust'],
  project: PermissionsConfig['deviceTrust']
): PermissionsConfig['deviceTrust'] | undefined {
  if (typeof project === 'string' && project.trim().toLowerCase() === 'gated') return 'gated';
  if (typeof user === 'string' && user.trim().length > 0) return user;
  return undefined;
}

/**
 * Project ids never add a device the user did not list. When the project sets
 * a list, the result is the intersection; when it does not, the user's list
 * stands. No user list means the project list is ignored.
 */
function mergePermissionTrustedDevices(
  user: readonly string[] | undefined,
  project: readonly string[] | undefined
): string[] | undefined {
  if (!Array.isArray(user)) return undefined;
  if (!Array.isArray(project)) return [...user];
  const projectIds = new Set<string>();
  for (const entry of project) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) projectIds.add(trimmed);
  }
  const seen = new Set<string>();
  const intersection: string[] = [];
  for (const entry of user) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed) || !projectIds.has(trimmed)) continue;
    seen.add(trimmed);
    intersection.push(trimmed);
  }
  return intersection;
}

/**
 * Permission-block merge. Allowlist of PermissionsConfig: the project object
 * is never spread, so unknown project fields are dropped. A project may only
 * tighten the user.
 * - deny / ask union (a project cannot remove the user's rules)
 * - allow unions only what the caller still passes. loadCliConfigFile removes
 *   an untrusted project's allow before this runs
 * - defaultMode keeps the user's value when set, so a project cannot loosen
 *   it. An untrusted project's defaultMode is removed before this runs
 * - deviceTrust: project `gated` over user `full`; never project `full`
 * - trustedDevices: intersection with the user's list, never an addition
 */
function mergePermissionsConfig(
  user: PermissionsConfig | undefined,
  project: PermissionsConfig | undefined
): PermissionsConfig | undefined {
  if (!user && !project) return undefined;
  // Every PermissionsConfig key is required here, so a new field fails the
  // build until the allowlist handles it. Unknown project keys are not copied.
  const fields = {
    defaultMode: user?.defaultMode ?? project?.defaultMode,
    allow: unionOptionalStringList(user?.allow, project?.allow),
    ask: unionOptionalStringList(user?.ask, project?.ask),
    deny: unionOptionalStringList(user?.deny, project?.deny),
    deviceTrust: mergePermissionDeviceTrust(user?.deviceTrust, project?.deviceTrust),
    trustedDevices: mergePermissionTrustedDevices(user?.trustedDevices, project?.trustedDevices),
  } satisfies Record<keyof PermissionsConfig, unknown>;
  const merged: PermissionsConfig = {};
  if (fields.defaultMode !== undefined) merged.defaultMode = fields.defaultMode;
  if (fields.allow !== undefined) merged.allow = fields.allow;
  if (fields.ask !== undefined) merged.ask = fields.ask;
  if (fields.deny !== undefined) merged.deny = fields.deny;
  if (fields.deviceTrust !== undefined) merged.deviceTrust = fields.deviceTrust;
  if (fields.trustedDevices !== undefined) merged.trustedDevices = fields.trustedDevices;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function argvTrustsWorkspace(argv: readonly string[]): boolean {
  return argv.includes('--trust-workspace');
}

function projectRoutingTrusted(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  startDir: string,
  explicit: boolean | undefined
): boolean {
  if (explicit !== undefined) return explicit;
  if (argvTrustsWorkspace(argv)) return true;
  // Project `.env` cannot set this. Only the environment from before dotenv.
  const real = env === process.env || env === envBeforeDotenv ? envBeforeDotenv : env;
  const raw = (real.MOSS_TRUST_WORKSPACE ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  try {
    return isFolderTrusted(resolveConfigDir(env), startDir);
  } catch {
    return false;
  }
}

function blockedProjectBaseUrl(
  project: ConfigFile,
  user: ConfigFile,
  merged: ConfigFile
): string | undefined {
  if (typeof project.baseUrl !== 'string' || !project.baseUrl.trim()) return undefined;
  const host = endpointHost(project.baseUrl);
  if (!host) return undefined;
  const allowed = primaryKeyAllowedForHost(host, {
    ...(typeof user.baseUrl === 'string' ? { baseUrl: user.baseUrl } : {}),
    ...(typeof user.provider === 'string' ? { provider: user.provider } : {}),
  });
  if (allowed) return undefined;
  const projectKey = typeof project.apiKey === 'string' ? project.apiKey : undefined;
  const userKey = typeof user.apiKey === 'string' ? user.apiKey : undefined;
  const ownKey = Boolean(projectKey && projectKey !== userKey);
  const projectEnv = typeof project.apiKeyEnv === 'string' ? project.apiKeyEnv.trim() : '';
  const ownEnv = projectEnv.length > 0 && !namesUserKeyEnv(projectEnv, user);
  if (ownKey || ownEnv) return undefined;
  if (merged.apiKey) return undefined;
  return project.baseUrl;
}

export function loadCliConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  startDir = safeProcessCwd(env),
  options?: { allowProjectStatusCommand?: boolean; trustProjectRouting?: boolean }
): LoadedCliConfigFile {
  const configPath = resolveConfigPath(undefined, env, argv);
  const userConfig = loadConfigFile(configPath);
  const userIdentity = {
    ...(typeof userConfig.apiKey === 'string' ? { userApiKey: userConfig.apiKey } : {}),
    ...(typeof userConfig.baseUrl === 'string' ? { userBaseUrl: userConfig.baseUrl } : {}),
    ...(typeof userConfig.provider === 'string' ? { userProvider: userConfig.provider } : {}),
  };
  if (hasExplicitConfigPath(env, argv)) {
    return {
      config: userConfig,
      configPath,
      userConfig,
      fieldSources: fieldSourcesFor(userConfig, {}),
      ...userIdentity,
    };
  }

  const projectConfigPath = resolveProjectConfigPath(startDir) ?? undefined;
  if (!projectConfigPath) {
    return {
      config: userConfig,
      configPath,
      userConfig,
      fieldSources: fieldSourcesFor(userConfig, {}),
      ...userIdentity,
    };
  }
  // A walk that lands on the user's own `~/.moss/config.json` is the user's
  // file, not a cloned project's. It merges, and it is not a routing source
  // that folder trust has to ignore.
  if (isUserMossConfig(projectConfigPath, env)) {
    const inherited = loadConfigFile(projectConfigPath);
    const merged = mergeConfigFiles(inherited, userConfig, options);
    return {
      config: merged,
      configPath,
      projectConfigPath,
      userConfig,
      fieldSources: {
        ...fieldSourcesFor(userConfig, {}),
        ...fieldSourcesFor(inherited, {}),
      },
      ...userIdentity,
    };
  }
  const rawProject = loadConfigFile(projectConfigPath);
  const trusted = projectRoutingTrusted(env, argv, startDir, options?.trustProjectRouting);
  const ignoredProjectRouting = trusted ? [] : listProjectRoutingConfigFields(rawProject);
  const droppedProjectPermissions = trusted
    ? []
    : listDroppedProjectPermissionFields(userConfig, rawProject);
  const projectConfig = trusted
    ? rawProject
    : omitLooseningProjectPermissions(userConfig, omitProjectRoutingConfig(rawProject));
  const merged = mergeConfigFiles(projectConfig, userConfig, options);
  const sources = fieldSourcesFor(userConfig, projectConfig);
  const keyLayer =
    merged.apiKey && merged.apiKey === userConfig.apiKey
      ? 'user'
      : merged.apiKey && merged.apiKey === projectConfig.apiKey
        ? 'project'
        : undefined;
  if (merged.apiKey && keyLayer) sources.apiKey = keyLayer;
  const blocked = trusted ? blockedProjectBaseUrl(rawProject, userConfig, merged) : undefined;
  return {
    config: merged,
    configPath,
    projectConfigPath,
    userConfig,
    projectConfig,
    fieldSources: sources,
    ...(ignoredProjectRouting.length > 0 ? { ignoredProjectRouting } : {}),
    ...(droppedProjectPermissions.length > 0 ? { droppedProjectPermissions } : {}),
    ...(blocked ? { blockedProjectBaseUrl: blocked } : {}),
    ...userIdentity,
  };
}

function isUserMossConfig(configPath: string, env: NodeJS.ProcessEnv): boolean {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home?.trim()) return false;
  const userMoss = folderPathKey(path.join(home.trim(), '.moss'));
  const file = folderPathKey(configPath);
  return file === path.join(userMoss, 'config.json') || file.startsWith(userMoss + path.sep);
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

function parseModelMaxOutputTokens(
  models: AgentRuntimeConfig['models']
): Record<string, number> | undefined {
  if (!models || typeof models !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [id, spec] of Object.entries(models)) {
    const key = id.trim();
    if (!key || !spec || typeof spec !== 'object') continue;
    const tokens = parsePositiveInteger(
      spec.maxOutputTokens,
      `agent.models.${key}.maxOutputTokens`
    );
    if (tokens !== undefined) out[key] = tokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Moss-specific model env vars stay config-only. Provider keys
 * (OPENAI_API_KEY, DEEPSEEK_API_KEY, …) are offered at setup instead of ignored.
 */
const IGNORED_MODEL_ENV_VARS = [
  'MOSS_PROVIDER',
  'MOSS_MODEL',
  'MOSS_BASE_URL',
  'MOSS_API_KEY',
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
  /** `full` when flag, env, or config opts into destructive device operations. */
  deviceTrust: 'gated' | 'full';
  /** Hosts / device ids allowed to run the destructive tier. */
  trustedDevices: string[];
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
  /** User-file `apiKeyEnv`, when that file names a variable. */
  apiKeyEnv?: string;
  /** The named variable is absent. Do not fall through to a stored or provider key. */
  apiKeyEnvUnset?: boolean;

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
  modelTiersSource?: string;
  /** Max output tokens per LLM response. undefined → runtime derives from contextTokens. */
  maxOutputTokens?: number;
  /** Per-model caps from `agent.models.<id>.maxOutputTokens`. */
  modelMaxOutputTokens?: Record<string, number>;
  compactionSettings: Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>;
  compactionSettingsSource: string;
  configPath: string;
  projectConfigPath?: string;

  apiKeyEncrypted: boolean;
  /**
   * More than one official provider key is set and nothing chose a provider.
   * The CLI exits before a request; it does not pick one.
   */
  envProviderCandidates?: string[];
  /**
   * Printed when a single official env key selected the provider. The choice
   * is not written to config.
   */
  autoEnvNotice?: string;
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

function zhAuditSource(source: string): string {
  return zhConfigSource(source);
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
      message: uiText(
        `auto-approval is enabled via ${config.permissions.source} (${config.approvalPolicySource}); keep deniedTools current for risky tools`,
        `已通过 ${zhAuditSource(config.permissions.source)}（${zhAuditSource(config.approvalPolicySource)}）开启自动审批；请为高风险工具保持 \`deniedTools\``
      ),
    });
    if (config.deniedTools.length === 0) {
      warnings.push({
        code: 'approval.no_denied_tools',
        severity: 'warn',
        source: config.deniedToolsSource,
        message: uiText(
          `auto-approval has no deniedTools guardrail (${config.deniedToolsSource}); add high-risk tools or globs to deniedTools`,
          `自动审批没有 \`deniedTools\` 护栏（${zhAuditSource(config.deniedToolsSource)}）；请把高风险工具或通配加入 \`deniedTools\``
        ),
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
      message: uiText(
        'default full mode has no deny rules; add rules with /permissions (e.g. deny read_file(./.env)) to keep sensitive tools gated',
        '默认完全访问模式没有拒绝规则；用 /permissions 添加（例如 `deny read_file(./.env)`）以继续拦截敏感工具'
      ),
    });
  }

  const conflictingPatterns = findConflictingToolPatterns(config.trustedTools, config.deniedTools);
  if (conflictingPatterns.length > 0) {
    warnings.push({
      code: 'approval.conflicting_tool_patterns',
      severity: 'warn',
      source: `${config.trustedToolsSource}, ${config.deniedToolsSource}`,
      message: uiText(
        `trustedTools also appear in deniedTools: ${conflictingPatterns.join(', ')}; deniedTools takes precedence`,
        `\`trustedTools\` 与 \`deniedTools\` 冲突：${conflictingPatterns.join('、')}；以 \`deniedTools\` 为准`
      ),
    });
  }

  const broadTrustedPatterns = config.trustedTools.filter(isBroadTrustedToolPattern);
  if (broadTrustedPatterns.length > 0) {
    warnings.push({
      code: 'trustedTools.broad_patterns',
      severity: 'warn',
      source: config.trustedToolsSource,
      message: uiText(
        `broad trusted pattern(s): ${broadTrustedPatterns.join(', ')}; prefer exact tool names or narrow server__tool globs`,
        `信任范围过宽：${broadTrustedPatterns.join(', ')}；请改用精确工具名或更窄的 server__tool 通配`
      ),
    });
  }

  return warnings;
}

export function hasTrustedToolWildcard(config: Pick<ResolvedCliConfig, 'trustedTools'>): boolean {
  return config.trustedTools.some(hasToolPatternWildcard);
}

/**
 * Startup notice for factory-default full mode. Shown once per config dir.
 * The marker lives next to the user config (not the workspace). Doctor still
 * reports the same condition on every run.
 */
const FULL_DEFAULT_NOTICE_MARKER = '.full_default_notice_shown';
const shownFullDefaultNotice = new Set<string>();

export function shouldShowFullDefaultNotice(
  config: Pick<ResolvedCliConfig, 'approvalPolicy' | 'deniedTools' | 'permissions'>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const applicable =
    config.approvalPolicy === 'never' &&
    config.deniedTools.length === 0 &&
    config.permissions !== undefined &&
    config.permissions.source === 'default';
  if (!applicable) return false;
  const key = resolveConfigDir(env);
  if (shownFullDefaultNotice.has(key)) return false;
  const marker = path.join(key, FULL_DEFAULT_NOTICE_MARKER);
  try {
    if (fs.existsSync(marker)) {
      shownFullDefaultNotice.add(key);
      return false;
    }
  } catch {
    /* unreadable marker: still show once in this process */
  }
  shownFullDefaultNotice.add(key);
  try {
    fs.mkdirSync(key, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, '', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch {
    /* another process wrote it, or the dir is not writable */
  }
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
          uiText(
            `[config] built-in model gateway file exists but is not readable (${code}): ${candidate}\n` +
              '[config] Fix: sudo chmod 644 <that file> — or reinstall moss and retry.',
            `[config] 内置模型网关文件存在但不可读（${code}）：${candidate}\n` +
              '[config] 修复：sudo chmod 644 <该文件> — 或重新安装 moss 后再试。'
          )
        );
      }
    }
  }
  return null;
}

function hasUserModelConfig(cfg: ConfigFile): boolean {
  const namedEnv = typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv.trim().length > 0;
  return Boolean(cfg.model && (cfg.apiKey || namedEnv) && (cfg.provider || cfg.baseUrl));
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

function projectDeclaresEndpoint(project: ConfigFile | undefined): boolean {
  return project?.provider !== undefined || project?.baseUrl !== undefined;
}

function namedEnvVar(config: ConfigFile | undefined): string {
  const named = typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv.trim() : '';
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(named) ? named : '';
}

function userDeclaresEndpoint(config: ConfigFile | undefined): boolean {
  return config?.provider !== undefined || config?.baseUrl !== undefined;
}

/** Official provider env names. A project host must not receive one of these. */
function isOfficialEnvKeyName(name: string): boolean {
  return Object.values(PROVIDER_PRESETS).some((preset) => preset.envKeys?.includes(name));
}

/**
 * Keys are read from the process env captured before a project `.env`.
 * A caller that passes its own object (tests, an explicit env) is used as-is.
 */
function startupCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (isStartupEnvCaptured() && (env === process.env || env === envBeforeDotenv)) {
    return envBeforeDotenv;
  }
  return env;
}

/**
 * An env key is sent only in these cases:
 * - the user file names `apiKeyEnv` AND a provider or base URL, and the
 *   request host is one `primaryKeyAllowedForHost` allows for that user, or
 * - the request URL is that provider's official preset, or a CLI `--provider`
 *   plus `--base-url` wrote the host, and the matching provider env var is set.
 * A base URL with no provider does not borrow an official key.
 * A named `apiKeyEnv` with neither provider nor base URL is not configured.
 * A project provider, base URL, or `apiKeyEnv` never triggers a read.
 * One official key on a blank config is applied by `resolveCliConfig` before
 * this function runs; several keys are not picked.
 */
function apiKeyFromEnv(
  activeConfig: ConfigFile,
  userConfig: ConfigFile,
  projectConfig: ConfigFile | undefined,
  env: NodeJS.ProcessEnv,
  provider: CliProviderPreset,
  baseUrl: string,
  overrides: CliConfigOverrides
): { apiKey: string; source: string } | undefined {
  if (projectDeclaresEndpoint(projectConfig)) return undefined;
  const creds = startupCredentialEnv(env);
  const writtenBase = overrides.baseUrl || userConfig.baseUrl;
  const writtenProvider = overrides.provider || userConfig.provider;
  const host = endpointHost(baseUrl);
  const hostAllowed =
    host !== null &&
    primaryKeyAllowedForHost(host, {
      ...(writtenBase ? { baseUrl: writtenBase } : {}),
      ...(writtenProvider ? { provider: writtenProvider } : {}),
    });
  const named = namedEnvVar(userConfig);
  if (named && !userDeclaresEndpoint(userConfig)) return undefined;
  if (named) {
    if (!hostAllowed) return undefined;
    const value = (creds[named] ?? '').trim();
    if (value) return { apiKey: value, source: `env:${named}` };
  }
  if ((activeConfig.apiKey ?? '').trim()) return undefined;
  if ((writtenBase ?? '').trim() && !writtenProvider) return undefined;
  const cliHost = Boolean(overrides.provider && (overrides.baseUrl ?? '').trim() && hostAllowed);
  if (!isOfficialPresetBaseUrl(provider, baseUrl) && !cliHost) return undefined;
  if (!hostAllowed) return undefined;
  if (
    !activeConfig.provider &&
    !activeConfig.baseUrl &&
    !overrides.provider &&
    !overrides.baseUrl
  ) {
    return undefined;
  }
  for (const name of PROVIDER_PRESETS[provider].envKeys ?? []) {
    const value = (creds[name] ?? '').trim();
    if (value) return { apiKey: value, source: `env:${name}` };
  }
  return undefined;
}

export function resolveCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  config?: ConfigFile,
  overrides: CliConfigOverrides = {},
  loadedConfig?: Pick<
    LoadedCliConfigFile,
    | 'configPath'
    | 'projectConfigPath'
    | 'fieldSources'
    | 'userApiKey'
    | 'userBaseUrl'
    | 'userProvider'
    | 'userConfig'
    | 'projectConfig'
  >
): ResolvedCliConfig {
  const safeCwd = resolveSafeCwd(env);
  const defaultLoadedConfig = config === undefined ? loadCliConfigFile(env) : undefined;
  let activeConfig: ConfigFile = config ?? defaultLoadedConfig?.config ?? {};
  let usingBundledDefault = false;
  let bundledDefaultKeys = new Set<keyof ConfigFile>();
  let bundledDefaultSuppressedBy: string | undefined;
  const configPaths = loadedConfig ?? defaultLoadedConfig;
  const userLayer = configPaths?.userConfig ?? config ?? {};
  const credEnv = startupCredentialEnv(env);
  const projectEndpoint = projectDeclaresEndpoint(configPaths?.projectConfig);
  const userBlocksAuto =
    userDeclaresEndpoint(userLayer) ||
    Boolean((userLayer.apiKey ?? '').trim()) ||
    namedEnvVar(userLayer).length > 0 ||
    Boolean((userLayer.model ?? '').trim());
  const cliBlocksAuto = Boolean(overrides.provider || overrides.baseUrl || overrides.model);
  const officialOffers =
    userBlocksAuto || cliBlocksAuto || projectEndpoint ? [] : officialEnvOffers(credEnv);
  let envProviderCandidates: string[] | undefined;
  let autoEnvNotice: string | undefined;
  let autoEnvKey: { apiKey: string; source: string } | undefined;
  const autoEnvKeys = new Set<keyof ConfigFile>();
  if (officialOffers.length > 1) {
    envProviderCandidates = officialOffers.map((offer) => offer.keyVar);
  } else if (officialOffers.length === 1) {
    const offer = officialOffers[0];
    if (offer) {
      activeConfig = {
        ...activeConfig,
        provider: offer.provider,
        model: offer.model,
        baseUrl: offer.baseUrl,
      };
      autoEnvKey = { apiKey: offer.apiKey, source: `env:${offer.keyVar}` };
      autoEnvNotice = setupCopy(undefined, '[moss] Using {key} → {provider} @ {baseUrl}', {
        key: offer.keyVar,
        provider: offer.provider,
        baseUrl: offer.baseUrl,
      });
      autoEnvKeys.add('provider');
      autoEnvKeys.add('model');
      autoEnvKeys.add('baseUrl');
    }
  }
  const namedWithoutEndpoint =
    namedEnvVar(userLayer).length > 0 &&
    !userDeclaresEndpoint(userLayer) &&
    !projectDeclaresEndpoint(configPaths?.projectConfig) &&
    !overrides.provider &&
    !overrides.baseUrl;

  if (
    !autoEnvKey &&
    !envProviderCandidates &&
    !hasUserModelConfig(activeConfig) &&
    !namedWithoutEndpoint
  ) {
    const bundled = readBundledZeroConfigDefault(env);
    if (bundled) {
      activeConfig = { ...activeConfig, ...bundled };
      bundledDefaultKeys = new Set(Object.keys(bundled) as Array<keyof ConfigFile>);
      usingBundledDefault = true;
    }
  } else if (
    !autoEnvKey &&
    !envProviderCandidates &&
    !namedWithoutEndpoint &&
    readBundledZeroConfigDefault(env)
  ) {
    bundledDefaultSuppressedBy = 'moss config file';
  }
  const fileLayer = (field: string): string => configPaths?.fieldSources?.[field] ?? 'config';
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
        ? fileLayer('profile')
        : 'default';
  const profileDefaults = CLI_PROFILE_DEFAULTS[profile];

  const ignoredModelEnvVars = listIgnoredModelEnvVars(env);
  const inferredProvider = inferProviderFromBaseUrl(overrides.baseUrl || activeConfig.baseUrl);
  const activeConfigSource = (key: keyof ConfigFile): string =>
    autoEnvKeys.has(key)
      ? 'env'
      : usingBundledDefault && bundledDefaultKeys.has(key)
        ? 'built-in'
        : fileLayer(key);
  const provider =
    overrides.provider || activeConfig.provider
      ? normalizeProvider(overrides.provider || activeConfig.provider)
      : inferredProvider || 'deepseek';
  const preset = PROVIDER_PRESETS[provider];
  const providerSource = namedWithoutEndpoint
    ? 'unconfigured'
    : overrides.provider
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
    modeSource = fileLayer('permissions.defaultMode');
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
        ? fileLayer('trustedTools')
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
        ? fileLayer('deniedTools')
        : 'default';

  const permissionsAllow = [
    ...new Set([...(permissionsBlock?.allow ?? []), ...legacyMigration.allowRules]),
  ];
  const permissionsAsk = [...new Set([...(permissionsBlock?.ask ?? [])])];
  const permissionsDeny = [
    ...new Set([...(permissionsBlock?.deny ?? []), ...legacyMigration.denyRules]),
  ];
  const configTrustedDevices = Array.isArray(permissionsBlock?.trustedDevices)
    ? permissionsBlock.trustedDevices
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const trustedDevices = [
    ...new Set([...configTrustedDevices, ...parseDeviceTrustList(env.MOSS_DEVICE_TRUST_DEVICES)]),
  ];
  const deviceTrust: 'gated' | 'full' =
    overrides.deviceTrust === 'full' ||
    isDeviceTrustEnv(env) ||
    permissionsBlock?.deviceTrust === 'full'
      ? 'full'
      : 'gated';
  const permissionsView: ResolvedPermissionsView = {
    defaultMode,
    readOnlyCeiling,
    allow: permissionsAllow,
    ask: permissionsAsk,
    deny: permissionsDeny,
    deviceTrust,
    trustedDevices,
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
          ? fileLayer('promptCache')
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
          ? fileLayer('promptCache')
          : `profile:${profile}`;
  const guardrails = normalizeGuardrailsConfig(activeConfig.guardrails);
  const guardrailsSource = hasGuardrails(guardrails) ? fileLayer('guardrails') : 'default';
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
          ? fileLayer('agent.maxTurns')
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
          ? fileLayer('agent.contextTokens')
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
  const modelMaxOutputTokens = parseModelMaxOutputTokens(activeConfig.agent?.models);
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
      ? fileLayer('agent.compaction')
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
  const hasFileTiers = Boolean(
    activeConfig.agent?.modelTiers && Object.keys(activeConfig.agent.modelTiers).length > 0
  );
  const hasEnvTiers = Boolean(
    envModelTier('MOSS_MODEL_CHEAP') ||
    envModelTier('MOSS_MODEL_BALANCED') ||
    envModelTier('MOSS_MODEL_STRONG')
  );
  const modelTiersSource = hasFileTiers
    ? fileLayer('agent.modelTiers')
    : hasEnvTiers
      ? 'env'
      : 'default';
  const apiKeyEnvName = activeConfig.apiKeyEnv?.trim();
  let resolvedApiKey = activeConfig.apiKey || '';
  let apiKeyFromProjectEnv = false;
  if (!resolvedApiKey && apiKeyEnvName) {
    const fromEnv = (env[apiKeyEnvName] ?? '').trim();
    const userKey = configPaths?.userApiKey ?? '';
    const host = endpointHost(
      overrides.baseUrl || activeConfig.baseUrl || officialBaseUrl(String(provider))
    );
    const allowed =
      !host ||
      primaryKeyAllowedForHost(host, {
        ...(configPaths?.userBaseUrl ? { baseUrl: configPaths.userBaseUrl } : {}),
        ...(configPaths?.userProvider ? { provider: configPaths.userProvider } : {}),
      });
    const officialShellKey = isOfficialEnvKeyName(apiKeyEnvName);
    if (fromEnv && (allowed || (fromEnv !== userKey && !officialShellKey))) {
      resolvedApiKey = fromEnv;
      apiKeyFromProjectEnv = true;
    }
  }
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
  const baseUrl = namedWithoutEndpoint
    ? ''
    : overrides.baseUrl || activeConfig.baseUrl || preset.defaultBaseUrl;
  const userNamed = namedEnvVar(userLayer);
  const namedMissing =
    userNamed.length > 0 &&
    !projectEndpoint &&
    !(startupCredentialEnv(env)[userNamed] ?? '').trim();
  const blockAutoKey = namedWithoutEndpoint || namedMissing || Boolean(envProviderCandidates);
  const envKey = blockAutoKey
    ? undefined
    : (autoEnvKey ??
      apiKeyFromEnv(
        activeConfig,
        userLayer,
        configPaths?.projectConfig,
        env,
        provider,
        baseUrl,
        overrides
      ));
  return {
    profile,
    profileSource,
    provider,
    providerSource,
    apiKey: blockAutoKey ? '' : envKey?.apiKey || resolvedApiKey,
    apiKeySource: blockAutoKey
      ? 'missing'
      : envKey
        ? envKey.source
        : resolvedApiKey
          ? apiKeyFromProjectEnv
            ? fileLayer('apiKey')
            : activeConfigSource('apiKey')
          : 'missing',
    ...(userNamed && !projectEndpoint ? { apiKeyEnv: userNamed } : {}),
    ...(namedMissing ? { apiKeyEnvUnset: true } : {}),
    usingBundledDefault,
    ...(bundledDefaultSuppressedBy ? { bundledDefaultSuppressedBy } : {}),
    ignoredModelEnvVars,
    model: namedWithoutEndpoint
      ? overrides.model || activeConfig.model || ''
      : overrides.model || activeConfig.model || preset.defaultModel,

    modelSource:
      namedWithoutEndpoint && !overrides.model && !activeConfig.model
        ? 'unconfigured'
        : overrides.model
          ? 'cli'
          : activeConfig.model
            ? activeConfigSource('model')
            : preset.defaultModel
              ? 'provider default'
              : 'missing',
    baseUrl,
    baseUrlSource: namedWithoutEndpoint
      ? 'unconfigured'
      : overrides.baseUrl
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
          ? fileLayer('workspace')
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
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
    compactionSettings,
    ...(runBudget ? { budget: runBudget } : {}),
    ...(bestOfN !== undefined ? { bestOfN } : {}),
    ...(reasoningBudget ? { reasoningBudget } : {}),
    ...(hasModelTiers ? { modelTiers, modelTiersSource } : { modelTiersSource }),
    compactionSettingsSource,
    configPath: configPaths?.configPath ?? resolveConfigPath(undefined, env),
    projectConfigPath: configPaths?.projectConfigPath,
    apiKeyEncrypted: envKey ? false : activeConfig._apiKeyEncrypted || false,
    ...(envProviderCandidates ? { envProviderCandidates } : {}),
    ...(autoEnvNotice ? { autoEnvNotice } : {}),
  };
}

/**
 * These decide which directory is the user's, which directory is the
 * workspace, or which rdk-docs package runs. A project `.env` must not set
 * them. `MOSS_TRUST_WORKSPACE` is refused with the other safety controls.
 * Interpreter and loader variables are refused by `isDotenvDeniedEnvKey`
 * (shared with child spawns). The process environment captured in
 * `envBeforeDotenv`, plus CLI flags, are the only sources for the keys in
 * this set. Matching is case-insensitive, because Windows environment names are.
 */
const ENV_FILE_IGNORED_KEYS = new Set(
  [
    'MOSS_WORKSPACE',
    'MOSS_CONFIG_DIR',
    'MOSS_CONFIG_FILE',
    'MOSS_CONFIG_PATH',
    'MOSS_RDK_DOCS_PACKAGE',
    'MOSS_LANG',
    'XDG_CONFIG_HOME',
    'HOME',
    'APPDATA',
    'USERPROFILE',
  ].map((key) => key.toUpperCase())
);

interface DeferredRoutingAssignment {
  key: string;
  value: string;
  envFile: string;
}

const deferredRoutingEnv: DeferredRoutingAssignment[] = [];

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
    // Safety controls never come from a project or ancestor .env, trusted or not.
    if (isDotenvSafetyEnvKey(key)) {
      noteDotenvSafetyEnvKey(envPath, key);
      continue;
    }
    if (!key || ENV_FILE_IGNORED_KEYS.has(key.toUpperCase()) || isDotenvDeniedEnvKey(key)) continue;
    if (process.env[key] !== undefined) continue;
    if (isProjectRoutingEnvKey(key)) {
      deferredRoutingEnv.push({ key, value, envFile: envPath });
      continue;
    }
    process.env[key] = value;
    recordDotenvOrigin(key, envPath, isUserRoutingEnvFile(envPath, homeBeforeDotenv));
  }
}

function pathIsInside(root: string, target: string): boolean {
  const base = folderPathKey(root);
  const child = folderPathKey(target);
  return child === base || child.startsWith(base + path.sep);
}

/**
 * `~/.env` and the Moss install directory's own `.env` are the user's.
 * A `.env` next to a parent of the install, or above the folder being
 * launched, is not.
 */
function isUserRoutingEnvFile(envFile: string, homeDir: string): boolean {
  const file = folderPathKey(envFile);
  const home = homeDir.trim();
  if (home && file === folderPathKey(path.join(home, '.env'))) return true;
  const installEnv = path.join(path.dirname(getPackageJsonPath()), '.env');
  return file === folderPathKey(installEnv);
}

/**
 * Apply routing variables captured from `.env` files. The closest file wins.
 *
 * User sources (`~/.env`, the install directory's `.env`) always apply. Any
 * other file applies only when the directory that contains it is trusted, or
 * when this process trusted `folderKey` and the file sits inside that folder
 * (`--trust-workspace` counts before the store is written). Trusting a child
 * does not apply a parent directory's `.env`. Returns the keys left unset and
 * the directories that contained them.
 */
export interface IgnoredProjectRoutingEnv {
  keys: string[];
  directories: string[];
}

export function commitProjectRoutingEnv(input: {
  trusted: boolean;
  folderKey: string;
  homeDir?: string;
  configDir?: string;
}): IgnoredProjectRoutingEnv {
  const homeDir = input.homeDir ?? homeBeforeDotenv;
  const configDir = input.configDir ?? resolveConfigDir();
  const ignored: Array<{ key: string; dir: string }> = [];
  const claimed = new Set<string>();
  for (const item of deferredRoutingEnv) {
    if (claimed.has(item.key) || process.env[item.key] !== undefined) {
      claimed.add(item.key);
      continue;
    }
    const allowed =
      isUserRoutingEnvFile(item.envFile, homeDir) ||
      (input.trusted && pathIsInside(input.folderKey, item.envFile)) ||
      isFolderTrusted(configDir, path.dirname(item.envFile));
    if (!allowed) {
      ignored.push({ key: item.key, dir: folderPathKey(path.dirname(item.envFile)) });
      continue;
    }
    process.env[item.key] = item.value;
    recordDotenvOrigin(item.key, item.envFile, isUserRoutingEnvFile(item.envFile, homeDir));
    claimed.add(item.key);
  }
  deferredRoutingEnv.length = 0;
  const keys = [...new Set(ignored.map((item) => item.key))].filter(
    (key) => process.env[key] === undefined
  );
  const pending = new Set(keys);
  const directories = [
    ...new Set(ignored.filter((item) => pending.has(item.key)).map((item) => item.dir)),
  ];
  return { keys, directories };
}

/** Test hook: drop routing assignments captured while importing config. */
export function resetDeferredRoutingEnvForTests(): void {
  deferredRoutingEnv.length = 0;
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

captureEnvBeforeDotenv(process.env);
homeBeforeDotenv = os.homedir();
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
