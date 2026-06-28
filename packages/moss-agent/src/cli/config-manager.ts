/**
 * ConfigManager — class-based wrapper around the CLI config functions.
 *
 * Provides a single object that encapsulates config directory resolution,
 * file loading/saving, provider preset management, normalization, auditing,
 * and env loading. The underlying implementations live in `config.ts`;
 * this class delegates to them, giving callers a clean interface boundary
 * instead of importing 59+ standalone functions.
 *
 * @public
 */
import {
  resolveConfigDir,
  resolveConfigPath,
  resolveProjectConfigPath,
  loadConfigFile,
  loadCliConfigFile,
  mergeConfigFiles,
  saveConfigFile,
  saveConfigFileAtPath,
  resolveCliConfig,
  parseProviderPreset,
  normalizeProvider,
  normalizeConfigProfile,
  normalizeSafetyModeConfig,
  normalizeApprovalPolicyConfig,
  normalizeGuardrailsConfig,
  parseTrustedTools,
  auditResolvedCliConfig,
  hasTrustedToolWildcard,
  isBroadTrustedToolPattern,
  maybeEncryptApiKeyInConfig,
  maybeDecryptApiKeyInConfig,
  loadEnvFile,
  loadEnvFromAncestors,
  resolveModelContextWindow,
  type ConfigFile,
  type LoadedCliConfigFile,
  type CliConfigOverrides,
  type ResolvedCliConfig,
  type CliProviderPreset,
  type CliConfigProfile,
  type CliSafetyModeConfig,
  type ConfigApprovalPolicy,
  type ResolvedGuardrailsConfig,
  type CliConfigAuditWarning,
} from './config.js';

export class ConfigManager {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  // ── Path resolution ──────────────────────────────────────────────────

  resolveConfigDir(): string {
    return resolveConfigDir(this.env);
  }

  resolveConfigPath(): string {
    return resolveConfigPath(undefined, this.env);
  }

  resolveProjectConfigPath(startDir?: string): string | null {
    return resolveProjectConfigPath(startDir);
  }

  // ── File loading / saving ────────────────────────────────────────────

  loadConfigFile(configPath?: string): ConfigFile {
    return loadConfigFile(configPath ?? this.resolveConfigPath());
  }

  loadCliConfigFile(
    argv: string[] = [],
    startDir?: string,
  ): LoadedCliConfigFile {
    return loadCliConfigFile(this.env, argv, startDir);
  }

  mergeConfigFiles(projectConfig: ConfigFile, userConfig: ConfigFile): ConfigFile {
    return mergeConfigFiles(projectConfig, userConfig);
  }

  saveConfigFile(config: ConfigFile, configDir?: string): void {
    saveConfigFile(config, configDir);
  }

  saveConfigFileAtPath(config: ConfigFile, configPath: string): void {
    saveConfigFileAtPath(config, configPath);
  }

  // ── Config resolution (main entry point) ─────────────────────────────

  resolveCliConfig(
    overrides: CliConfigOverrides = {},
    config?: ConfigFile,
    loadedConfig?: Pick<LoadedCliConfigFile, 'configPath' | 'projectConfigPath'>,
  ): ResolvedCliConfig {
    return resolveCliConfig(this.env, config, overrides, loadedConfig);
  }

  // ── Provider preset management ───────────────────────────────────────

  parseProviderPreset(value: string | undefined): CliProviderPreset | null {
    return parseProviderPreset(value);
  }

  normalizeProvider(value: string | undefined): CliProviderPreset {
    return normalizeProvider(value);
  }

  // ── Normalization ────────────────────────────────────────────────────

  normalizeConfigProfile(value: string | undefined): CliConfigProfile | null {
    return normalizeConfigProfile(value);
  }

  normalizeSafetyModeConfig(value: string | undefined): CliSafetyModeConfig | null {
    return normalizeSafetyModeConfig(value);
  }

  normalizeApprovalPolicyConfig(value: string | undefined): ConfigApprovalPolicy | null {
    return normalizeApprovalPolicyConfig(value);
  }

  normalizeGuardrailsConfig(raw: ConfigFile['guardrails']): ResolvedGuardrailsConfig {
    return normalizeGuardrailsConfig(raw);
  }

  parseTrustedTools(value: string | string[] | undefined): string[] | undefined {
    return parseTrustedTools(value);
  }

  // ── Audit ────────────────────────────────────────────────────────────

  auditResolvedCliConfig(config: ResolvedCliConfig): CliConfigAuditWarning[] {
    return auditResolvedCliConfig(config);
  }

  hasTrustedToolWildcard(config: Pick<ResolvedCliConfig, 'trustedTools'>): boolean {
    return hasTrustedToolWildcard(config);
  }

  isBroadTrustedToolPattern(pattern: string): boolean {
    return isBroadTrustedToolPattern(pattern);
  }

  // ── Encryption ───────────────────────────────────────────────────────

  maybeEncryptApiKeyInConfig(config: ConfigFile, configDir: string): ConfigFile {
    return maybeEncryptApiKeyInConfig(config, configDir);
  }

  maybeDecryptApiKeyInConfig(config: ConfigFile, configDir: string): ConfigFile {
    return maybeDecryptApiKeyInConfig(config, configDir);
  }

  // ── Env loading ──────────────────────────────────────────────────────

  loadEnvFile(envPath: string): void {
    loadEnvFile(envPath);
  }

  loadEnvFromAncestors(startDir: string): void {
    loadEnvFromAncestors(startDir);
  }

  // ── Model context window ─────────────────────────────────────────────

  resolveModelContextWindow(model: string | undefined): number {
    return resolveModelContextWindow(model);
  }
}
