import { ErrorCode, MossError } from '../../errors.js';

import type { MossWebSlot, StagedPlugin } from './plugin-host.js';

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/;

/** Read-only registry view used while validating a staged plugin generation. @internal */
export interface PluginContributionRegistryView {
  readonly hasTool: (id: string) => boolean;
  readonly hasSkill: (id: string) => boolean;
  readonly hasExpert: (id: string) => boolean;
  readonly hasCommand: (id: string) => boolean;
  readonly hasProvider: (id: string) => boolean;
  readonly hasMcpPreset: (id: string) => boolean;
  readonly hasWebContribution: (id: string) => boolean;
}

/** Create an empty contribution batch for one atomic activation. @internal */
export function createStagedPlugin(): StagedPlugin {
  return {
    tools: [],
    skills: [],
    experts: [],
    commands: [],
    providers: [],
    mcpPresets: [],
    promptLayers: [],
    webContributions: [],
    effects: [],
  };
}

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function validateContributionId(id: string, kind: string): void {
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`plugin ${kind} id is invalid: ${id}`);
}

/** Validate the stable identifier of one trusted runtime plugin. @internal */
export function validatePluginId(id: string): void {
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message: `plugin id must be lowercase and path-like: ${id}`,
    });
  }
}

/** Validate a complete contribution batch before the host publishes it. @internal */
export function validateStagedContributions(
  pluginId: string,
  staged: StagedPlugin,
  registry: PluginContributionRegistryView,
  supportedWebSlots: readonly MossWebSlot[]
): void {
  const conflict =
    duplicate(staged.tools.map(({ name }) => name)) ??
    duplicate(staged.skills.map((skill) => skill.stableId ?? skill.name)) ??
    duplicate(staged.experts.map(({ id }) => id)) ??
    duplicate(staged.commands.map(({ id }) => id)) ??
    duplicate(staged.providers.map(({ id }) => id)) ??
    duplicate(staged.mcpPresets.map(({ id }) => id)) ??
    duplicate(staged.webContributions.map(({ id }) => id));
  if (conflict) throw new Error(`plugin ${pluginId} contains duplicate contribution: ${conflict}`);

  for (const tool of staged.tools) {
    if (!tool.metadata?.sideEffectClass)
      throw new Error(`plugin tool ${tool.name} requires side-effect metadata`);
    if (registry.hasTool(tool.name))
      throw new Error(`plugin tool already registered: ${tool.name}`);
  }
  for (const skill of staged.skills) {
    const id = skill.stableId ?? skill.name;
    if (registry.hasSkill(id)) throw new Error(`plugin skill already registered: ${id}`);
  }
  for (const expert of staged.experts) {
    if (registry.hasExpert(expert.id))
      throw new Error(`plugin expert already registered: ${expert.id}`);
  }
  for (const command of staged.commands) {
    validateContributionId(command.id, 'command');
    if (!command.title.trim() || typeof command.expand !== 'function') {
      throw new Error(`plugin command is invalid: ${command.id}`);
    }
    if (registry.hasCommand(command.id)) {
      throw new Error(`plugin command already registered: ${command.id}`);
    }
  }
  for (const provider of staged.providers) {
    validateContributionId(provider.id, 'provider');
    if (!provider.displayName.trim() || typeof provider.create !== 'function') {
      throw new Error(`plugin provider is invalid: ${provider.id}`);
    }
    if (registry.hasProvider(provider.id)) {
      throw new Error(`plugin provider already registered: ${provider.id}`);
    }
  }
  for (const preset of staged.mcpPresets) {
    validateContributionId(preset.id, 'MCP preset');
    if (!preset.displayName.trim() || !preset.server.command.trim()) {
      throw new Error(`plugin MCP preset is invalid: ${preset.id}`);
    }
    if (registry.hasMcpPreset(preset.id)) {
      throw new Error(`plugin MCP preset already registered: ${preset.id}`);
    }
  }
  for (const layer of staged.promptLayers) {
    if (!layer.trim()) throw new Error(`plugin ${pluginId} contains an empty prompt layer`);
  }
  for (const contribution of staged.webContributions) {
    if (!PLUGIN_ID_PATTERN.test(contribution.id))
      throw new Error(`plugin ${pluginId} contains an invalid web contribution id`);
    if (!supportedWebSlots.includes(contribution.slot))
      throw new Error(`plugin ${pluginId} contains an unsupported web contribution slot`);
    if (!contribution.module.startsWith('./') || contribution.module.includes('..'))
      throw new Error(`plugin ${pluginId} web contribution module must be package-relative`);
    if (registry.hasWebContribution(`${pluginId}:${contribution.id}`)) {
      throw new Error(`plugin web contribution already registered: ${pluginId}:${contribution.id}`);
    }
  }
}
