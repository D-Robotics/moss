import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
import {
  type CliProviderPreset,
  type ProviderPreset,
  PROVIDER_PRESETS,
  parseProviderPreset,
  normalizeProvider,
  inferProviderFromBaseUrl,
} from '../provider/provider-presets.js';

export {
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
  const modern = path.join(base, 'moss');
  
  
  
  if (!fs.existsSync(modern)) {
    const legacy = path.join(base, 'dmoss');
    if (fs.existsSync(legacy)) return legacy;
  }
  return modern;
}


const APIKEY_CIPHER_PREFIX = 'enc:';

function deriveEncryptionKey(configDir: string): Buffer {
  const keyPath = path.join(configDir, '.apikey-key');
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function encryptApiKey(apiKey: string, configDir: string): string {
  const key = deriveEncryptionKey(configDir);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');
  return `${APIKEY_CIPHER_PREFIX}${payload}`;
}

function decryptApiKey(encryptedApiKey: string, configDir: string): string | null {
  if (!encryptedApiKey.startsWith(APIKEY_CIPHER_PREFIX)) {
    return null;
  }
  try {
    const payload = Buffer.from(encryptedApiKey.slice(APIKEY_CIPHER_PREFIX.length), 'base64');
    const iv = payload.subarray(0, 16);
    const authTag = payload.subarray(16, 32);
    const ciphertext = payload.subarray(32);
    const key = deriveEncryptionKey(configDir);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

export function maybeEncryptApiKeyInConfig(config: ConfigFile, configDir: string): ConfigFile {
  if (!config.apiKey || config.apiKey.startsWith(APIKEY_CIPHER_PREFIX)) {
    return config;
  }
  return { ...config, apiKey: encryptApiKey(config.apiKey, configDir) };
}

export function maybeDecryptApiKeyInConfig(config: ConfigFile, configDir: string): ConfigFile {
  if (!config.apiKey || !config.apiKey.startsWith(APIKEY_CIPHER_PREFIX)) {
    return config;
  }
  const decrypted = decryptApiKey(config.apiKey, configDir);
  if (decrypted === null) {
    return config;
  }
  return { ...config, apiKey: decrypted, _apiKeyEncrypted: true };
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
  promptCache?: PromptCacheConfig | boolean;
  guardrails?: GuardrailsConfig;
  agent?: AgentRuntimeConfig;
  mcp?: McpCliConfig;
  skills?: SkillsCliConfig;
  hooks?: HooksConfig;
  _examples?: Record<string, unknown>;
}

export interface LoadedCliConfigFile {
  config: ConfigFile;
  configPath: string;
  projectConfigPath?: string;
}

export class CliConfigFileError extends Error {
  readonly configPath: string;

  constructor(configPath: string, reason: string) {
    super(`Invalid moss config at ${configPath}: ${reason}`);
    this.name = 'CliConfigFileError';
    this.configPath = configPath;
  }
}








export class CliConfigWriteError extends Error {
  readonly configPath: string;

  constructor(configPath: string, reason: string) {
    super(`cannot write config to ${configPath}: ${reason}`);
    this.name = 'CliConfigWriteError';
    this.configPath = configPath;
  }
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
  /** Max output tokens per LLM response. If unset, moss derives a default from
   * the probed context window (contextTokens/4, capped to 32k) — NOT a hardcoded
   * 4096, which truncated long answers on modern large-output models. */
  maxOutputTokens?: number;
  compaction?: Partial<Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>>;
}


export interface SkillsCliConfig {
  





  extraRoots?: string[];
}

export interface McpCliConfig {
  enabled?: boolean;
  configPath?: string;
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
  balanced: {
    safetyMode: 'workspace-write',
    approvalPolicy: 'prompt',
    trustedTools: [],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
  autonomous: {
    safetyMode: 'workspace-write',
    approvalPolicy: 'never',
    trustedTools: ['exec', 'apply_patch'],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
};

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
    if (fs.existsSync(paths.legacyProjectConfigPath)) return paths.legacyProjectConfigPath;
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
  return maybeDecryptApiKeyInConfig(config, configDir);
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

function mergeMcpConfig(
  userMcp: ConfigFile['mcp'],
  projectMcp: ConfigFile['mcp']
): ConfigFile['mcp'] {
  if (!projectMcp && !userMcp) return undefined;
  return {
    ...userMcp,
    ...projectMcp,
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
  return {
    ...userConfig,
    ...projectConfig,
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
    promptCache: mergePromptCacheConfig(userConfig.promptCache, projectConfig.promptCache),
    guardrails: mergeGuardrailsConfig(userConfig.guardrails, projectConfig.guardrails),
    agent: mergeAgentRuntimeConfig(userConfig.agent, projectConfig.agent),
    mcp: mergeMcpConfig(userConfig.mcp, projectConfig.mcp),
    hooks: mergeHooksConfig(userConfig.hooks, projectConfig.hooks),
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
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    
    const { _apiKeyEncrypted: _, ...stripped } = config as ConfigFile & {
      _apiKeyEncrypted?: boolean;
    };
    const configToSave = maybeEncryptApiKeyInConfig(stripped, dir);
    
    
    
    const tmpPath = path.join(dir, `.tmp-${path.basename(configPath)}-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, `${JSON.stringify(configToSave, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    
    
    
    const reason = errorMessage(err);
    throw new CliConfigWriteError(configPath, reason);
  }
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    
  }
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

function resolveMcpConfigPath(
  mcpPath: string | undefined,
  source: 'env' | 'config' | 'default',
  configPaths: Pick<LoadedCliConfigFile, 'configPath' | 'projectConfigPath'> | undefined,
  env: NodeJS.ProcessEnv
): string {
  if (mcpPath && path.isAbsolute(mcpPath)) return mcpPath;
  if (source === 'env' && mcpPath) return resolvePathFromSafeCwd(mcpPath, env);

  const configPath = configPaths?.configPath ?? resolveConfigPath(undefined, env);
  if (source === 'config' && mcpPath) {
    const baseDir = configPaths?.projectConfigPath
      ? path.dirname(path.dirname(configPaths.projectConfigPath))
      : path.dirname(configPath);
    return path.resolve(baseDir, mcpPath);
  }

  return path.join(path.dirname(configPath), 'mcp.json');
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
  safetyMode: CliSafetyModeConfig;
  safetyModeSource: string;
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
  /** Max output tokens per LLM response. undefined → runtime derives from contextTokens. */
  maxOutputTokens?: number;
  compactionSettings: Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>;
  compactionSettingsSource: string;
  mcpEnabled: boolean;
  mcpEnabledSource: string;
  mcpConfigPath: string;
  mcpConfigPathSource: string;
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
  >
): CliConfigAuditWarning[] {
  const warnings: CliConfigAuditWarning[] = [];
  if (config.approvalPolicy === 'never') {
    warnings.push({
      code: 'approval.auto_approval',
      severity: 'warn',
      source: config.approvalPolicySource,
      message: `auto-approval is enabled via ${config.approvalPolicySource}; keep deniedTools current for risky tools`,
    });
    if (config.deniedTools.length === 0) {
      warnings.push({
        code: 'approval.no_denied_tools',
        severity: 'warn',
        source: config.deniedToolsSource,
        message: `auto-approval has no deniedTools guardrail (${config.deniedToolsSource}); add high-risk tools or globs to deniedTools`,
      });
    }
  }

  if (config.safetyMode === 'full-access' && config.approvalPolicy === 'never') {
    warnings.push({
      code: 'approval.full_access_auto_approval',
      severity: 'warn',
      source: `${config.safetyModeSource}, ${config.approvalPolicySource}`,
      message: `full-access safety and auto-approval are both enabled; prefer workspace-write or prompt approval unless the workspace is fully trusted`,
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
    } catch {
      
    }
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
            '[config] Fix: sudo chmod 644 <that file>  — or reinstall: npm i -g @rdk-moss/agent@latest'
        );
      }
    }
  }
  return null;
}






function hasUserModelConfig(cfg: ConfigFile): boolean {
  return Boolean(cfg.provider || cfg.model || cfg.baseUrl || cfg.apiKey);
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
export const CONSERVATIVE_DEFAULT_UNPROBED = 32_000;

/**
 * @deprecated This function maps model name fragments to hardcoded context-
 * window sizes. Those numbers go stale as models are updated (e.g.
 * deepseek-v4-flash is 1M, not 64k as the previous table claimed).
 *
 * Prefer `resolveContextTokensForModel` from `./model-catalog.js`, which
 * probes the provider API first. If you need a synchronous fallback, use
 * `CONSERVATIVE_DEFAULT_UNPROBED` — it is honest about not knowing the real
 * size, unlike the number this function returns.
 *
 * The function is kept exported for backward compatibility with downstream
 * hosts that may call it. It will be removed in a future minor release.
 */
export function resolveModelContextWindow(model: string | undefined): number {
  const id = (model ?? '').toLowerCase();
  
  if (id.includes('gpt')) return 128_000;
  
  if (id.includes('claude')) return 200_000;
  
  if (id.includes('llama')) return 128_000;
  
  if (id.includes('mistral') || id.includes('mixtral')) return 32_000;
  
  if (id.includes('gemma')) return 8_000;
  
  if (id.includes('command-r')) return 128_000;
  
  if (id.includes('phi')) return 4_000;
  
  if (id.includes('yi-')) return 32_000;

  if (id.includes('glm')) {
    const m = id.match(/glm-(\d+)(?:\.(\d+))?/);
    if (m) {
      const major = Number(m[1]);
      const minor = m[2] ? Number(m[2]) : 0;
      if (major >= 6) return 1_000_000;
      if (major === 5) return minor >= 1 ? 1_000_000 : 200_000;
      if (major === 4) return minor >= 6 ? 200_000 : 128_000;
    }
    return 128_000; // unrecognized GLM variant — conservative default
  }
  
  if (id.includes('deepseek')) return 64_000;
  
  
  if (id.includes('qwen')) return 32_000;
  
  return 1_000_000;
}

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
  
  
  
  
  const profile = overrides.profile ?? envProfile ?? configProfile ?? 'autonomous';
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
  const safetyModeEnv = env.MOSS_SAFETY_MODE || env.MOSS_CLI_SAFETY_MODE;
  const configSafetyMode = normalizeSafetyModeConfig(
    typeof activeConfig.safetyMode === 'string' ? activeConfig.safetyMode : undefined
  );
  const envSafetyMode = normalizeSafetyModeConfig(safetyModeEnv);
  const safetyMode =
    overrides.safetyMode || envSafetyMode || configSafetyMode || profileDefaults.safetyMode;
  const safetyModeSource = overrides.safetyMode
    ? 'cli'
    : envSafetyMode
      ? env.MOSS_SAFETY_MODE
        ? 'MOSS_SAFETY_MODE'
        : 'MOSS_CLI_SAFETY_MODE'
      : configSafetyMode
        ? 'config'
        : `profile:${profile}`;

  const approvalEnv =
    env.MOSS_CLI_AUTO_APPROVE === '1' || env.MOSS_AUTO_APPROVE === '1'
      ? 'never'
      : env.MOSS_APPROVAL_POLICY || env.MOSS_ASK_FOR_APPROVAL;
  const configApproval = normalizeApprovalPolicyConfig(
    typeof activeConfig.approvalPolicy === 'string' ? activeConfig.approvalPolicy : undefined
  );
  const envApproval = normalizeApprovalPolicyConfig(approvalEnv);
  const approvalPolicy =
    overrides.approvalPolicy || envApproval || configApproval || profileDefaults.approvalPolicy;
  const approvalPolicySource = overrides.approvalPolicy
    ? 'cli'
    : envApproval
      ? env.MOSS_CLI_AUTO_APPROVE === '1'
        ? 'MOSS_CLI_AUTO_APPROVE'
        : env.MOSS_AUTO_APPROVE === '1'
          ? 'MOSS_AUTO_APPROVE'
          : env.MOSS_APPROVAL_POLICY
            ? 'MOSS_APPROVAL_POLICY'
            : 'MOSS_ASK_FOR_APPROVAL'
      : configApproval
        ? 'config'
        : `profile:${profile}`;

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
    overrides.contextTokens ?? envContextTokens ?? configContextTokens ?? CONSERVATIVE_DEFAULT_UNPROBED;
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
  const mcpEnabledEnv = parseConfigBoolean(env.MOSS_MCP_ENABLED);
  const configMcpEnabled =
    activeConfig.mcp &&
    typeof activeConfig.mcp === 'object' &&
    typeof activeConfig.mcp.enabled === 'boolean'
      ? activeConfig.mcp.enabled
      : undefined;
  const mcpEnabled = mcpEnabledEnv ?? configMcpEnabled ?? false;
  const mcpEnabledSource =
    mcpEnabledEnv !== null
      ? 'MOSS_MCP_ENABLED'
      : configMcpEnabled !== undefined
        ? 'config'
        : 'default';
  const configMcpPath =
    activeConfig.mcp &&
    typeof activeConfig.mcp === 'object' &&
    typeof activeConfig.mcp.configPath === 'string'
      ? activeConfig.mcp.configPath
      : undefined;
  const envMcpPath = env.MOSS_MCP_CONFIG || env.MOSS_MCP_CONFIG_FILE;
  const mcpConfigPathSource = envMcpPath
    ? env.MOSS_MCP_CONFIG
      ? 'MOSS_MCP_CONFIG'
      : 'MOSS_MCP_CONFIG_FILE'
    : configMcpPath
      ? 'config'
      : 'default';
  const mcpConfigPath = resolveMcpConfigPath(
    envMcpPath || configMcpPath,
    envMcpPath ? 'env' : configMcpPath ? 'config' : 'default',
    configPaths,
    env
  );
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
    compactionSettingsSource,
    mcpEnabled,
    mcpEnabledSource,
    mcpConfigPath,
    mcpConfigPathSource,
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

export const PROVIDER = resolvedConfig.provider;
export const API_KEY = resolvedConfig.apiKey;
export const MODEL = resolvedConfig.model;
export const BASE_URL = resolvedConfig.baseUrl;
export const WORKSPACE = resolvedConfig.workspace;
export const CONFIG_PATH = resolvedConfig.configPath;
export const CONFIG_SOURCE = resolvedConfig;
