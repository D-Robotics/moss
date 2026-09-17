/**
 * ModelCatalog — class-based wrapper around the model selection functions.
 *
 * Encapsulates model choice listing, runtime model discovery, gateway
 * auto-selection, model selection resolution, formatting, custom model
 * config parsing, and context-window resolution. The underlying
 * implementations live in `model-catalog.ts`; this class delegates to them,
 * giving callers a clean interface boundary.
 *
 * @public
 */
import {
  commonModelChoices,
  loadModelChoicesForRuntime,
  autoSelectGatewayModel,
  resolveModelSelection,
  formatModelChoices,
  describeModelListSource,
  parseCustomModelConfigInput,
  formatCustomModelConfigInstructions,
  resolveModelContextWindowFromApi,
  resolveContextTokensForModel,
  type ModelChoice,
  type ModelChoiceList,
  type CustomModelConfigParseResult,
} from './model-catalog.js';
import type { CliProviderPreset, ResolvedCliConfig } from './config.js';

export class ModelCatalog {
  // ── Model choices ────────────────────────────────────────────────────

  commonModelChoices(
    provider: CliProviderPreset,
    currentModel = '',
    options: { usingBundledDefault?: boolean; configModel?: string } = {}
  ): ModelChoice[] {
    return commonModelChoices(provider, currentModel, options);
  }

  async loadModelChoicesForRuntime(
    config?: Partial<ResolvedCliConfig>,
    currentModel = '',
    options: { fallbackProvider?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}
  ): Promise<ModelChoiceList> {
    return loadModelChoicesForRuntime(config, currentModel, options);
  }

  async autoSelectGatewayModel(
    config: Partial<ResolvedCliConfig>,
    options: { timeoutMs?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
  ): Promise<string> {
    return autoSelectGatewayModel(config, options);
  }

  resolveModelSelection(input: string, choices: readonly ModelChoice[]): ModelChoice | null {
    return resolveModelSelection(input, choices);
  }

  formatModelChoices(list: ModelChoiceList): string {
    return formatModelChoices(list);
  }

  describeModelListSource(list: ModelChoiceList): string {
    return describeModelListSource(list);
  }

  // ── Custom model config ──────────────────────────────────────────────

  parseCustomModelConfigInput(input: string): CustomModelConfigParseResult {
    return parseCustomModelConfigInput(input);
  }

  formatCustomModelConfigInstructions(configPath?: string): string {
    return formatCustomModelConfigInstructions(configPath);
  }

  // ── Context window resolution ────────────────────────────────────────

  async resolveModelContextWindowFromApi(params: {
    baseUrl?: string;
    apiKey?: string;
    model: string;
    provider?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }): Promise<number | undefined> {
    return resolveModelContextWindowFromApi(params);
  }

  async resolveContextTokensForModel(params: {
    model: string;
    baseUrl?: string;
    apiKey?: string;
    provider?: string;
    explicitOverride?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }): Promise<{ contextTokens: number; source: string }> {
    return resolveContextTokensForModel(params);
  }
}
