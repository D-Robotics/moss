/**
 * CliServices — service facade for the CLI layer.
 *
 * Coordinates ConfigManager, ModelCatalog, and the setup/approval
 * workflows into a single entry point. Entry points (main.ts, repl.ts)
 * can use CliServices instead of importing from 5+ separate modules.
 *
 * @public
 */
import { ConfigManager } from './config-manager.js';
import { ModelCatalog } from './model-catalog-manager.js';
import {
  runConfigShow,
  runConfigValidate,
  runConfigInit,
  runConfigSet,
  runConfigUnset,
  runSetupWizard,
  offerSetupForInteractiveMissingConfig,
  printMissingConfigGuidance,
} from './setup.js';
import type { ResolvedCliConfig, CliConfigOverrides } from './config.js';
import { resolveCliSafetyMode, type CliSafetyMode } from './approval.js';

export class CliServices {
  readonly config: ConfigManager;
  readonly models: ModelCatalog;

  constructor(config?: ConfigManager, models?: ModelCatalog) {
    this.config = config ?? new ConfigManager();
    this.models = models ?? new ModelCatalog();
  }

  // ── Config resolution ────────────────────────────────────────────────

  resolveConfig(overrides?: CliConfigOverrides): ResolvedCliConfig {
    return this.config.resolveCliConfig(overrides);
  }

  // ── Model selection ──────────────────────────────────────────────────

  async selectModel(params: {
    config?: Partial<ResolvedCliConfig>;
    currentModel?: string;
    fallbackProvider?: string;
  }) {
    const choices = await this.models.loadModelChoicesForRuntime(
      params.config,
      params.currentModel ?? '',
      { fallbackProvider: params.fallbackProvider }
    );
    return choices;
  }

  // ── Approval workflow ────────────────────────────────────────────────

  resolveSafetyMode(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): CliSafetyMode {
    return resolveCliSafetyMode(argv, env);
  }

  // ── Config commands (delegate to setup.ts) ───────────────────────────

  runConfigShow(): void {
    runConfigShow();
  }

  runConfigValidate(args: string[], startDir?: string): void {
    runConfigValidate(args, startDir);
  }

  runConfigInit(args: string[], startDir?: string): void {
    runConfigInit(args, startDir);
  }

  runConfigSet(args: string[], startDir?: string): void {
    runConfigSet(args, startDir);
  }

  runConfigUnset(args: string[], startDir?: string): void {
    runConfigUnset(args, startDir);
  }

  // ── Setup wizard (delegate to setup.ts) ──────────────────────────────

  async runSetupWizard(): Promise<void> {
    await runSetupWizard();
  }

  async offerSetupForInteractiveMissingConfig(): Promise<void> {
    await offerSetupForInteractiveMissingConfig();
  }

  printMissingConfigGuidance(
    interactive: boolean,
    options: { bundledDefaultSuppressedBy?: string } = {}
  ): void {
    printMissingConfigGuidance(interactive, options);
  }
}
