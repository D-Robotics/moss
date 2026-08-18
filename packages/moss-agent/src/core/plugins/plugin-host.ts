import { ErrorCode, MossError, wrapAsMoss } from '../../errors.js';
import type { SkillMeta } from '../../skills/types.js';
import type { AgentRoleDefinition } from '../../orchestration/agent-role-types.js';
import { CordisEffectScope } from '../../vendor/cordis/effect-scope.js';
import type { LLMProvider } from '../llm/llm-provider.js';
import type { SubagentExpertDefinition } from '../subagent/expert-registry.js';
import type { Tool } from '../tools/tool-types.js';
import {
  createStagedPlugin,
  validatePluginId,
  validateStagedContributions,
} from './plugin-host-validation.js';

/** Lifecycle state exposed by the deterministic plugin inspector. @beta */
export type MossPluginState = 'loading' | 'active' | 'unloading' | 'failed' | 'disposed';

/** Whether a plugin generation accepts calls, drains leases, or is disposed. @beta */
export type MossPluginCallState = 'accepting' | 'draining' | 'disposed';

/** Cleanup callback owned by a plugin lifecycle scope. @beta */
export type MossPluginDisposer = () => void | Promise<void>;

/** A redacted description of one installed plugin. @beta */
export interface MossPluginSnapshot {
  readonly id: string;
  readonly state: MossPluginState;
  readonly callState: MossPluginCallState;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly experts: readonly string[];
  readonly agentRoles: readonly string[];
  readonly commands: readonly string[];
  readonly providers: readonly string[];
  readonly mcpPresets: readonly string[];
  readonly promptLayerCount: number;
  readonly effectLabels: readonly string[];
  readonly webContributions: readonly string[];
}

/** Prompt-expanding command contributed by one trusted plugin. @beta */
export interface MossPluginCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  expand(args: string): string | Promise<string>;
}

/** LLM provider factory contributed by one trusted plugin. @beta */
export interface MossPluginProvider {
  readonly id: string;
  readonly displayName: string;
  create(config: Readonly<Record<string, unknown>>): LLMProvider | Promise<LLMProvider>;
}

/** Data-only MCP server preset contributed by one trusted plugin. @beta */
export interface MossPluginMcpPreset {
  readonly id: string;
  readonly displayName: string;
  readonly server: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly requestTimeoutMs?: number;
  };
}

/** Stable browser extension slots available to trusted runtime plugins. @beta */
export const MOSS_WEB_SLOTS = [
  'navigation.primary',
  'navigation.session',
  'navigation.footer',
  'conversation.header',
  'conversation.message',
  'conversation.composer',
  'conversation.details',
  'tool.inline',
  'tool.details',
  'settings.section',
  'settings.plugin',
] as const;

/** Stable browser extension slot available to trusted runtime plugins. @beta */
export type MossWebSlot = (typeof MOSS_WEB_SLOTS)[number];

/** Declarative browser contribution owned by one trusted runtime plugin. @beta */
export interface MossWebContribution {
  readonly id: string;
  readonly slot: MossWebSlot;
  readonly module: string;
}

/** Redacted, deterministic plugin composition state. @beta */
export interface MossPluginCompositionSnapshot {
  /** Monotonic last-good composition generation. Failed activation does not advance it. */
  readonly generation: number;
  readonly plugins: readonly MossPluginSnapshot[];
}

/** Quiescence policy for unloading one plugin generation. @beta */
export interface MossPluginUnloadOptions {
  /** Maximum time to wait for active plugin calls before retaining the old generation. */
  readonly timeoutMs?: number;
}

/** Handle returned after a plugin is installed successfully. @beta */
export interface MossPluginHandle {
  readonly id: string;
  readonly state: MossPluginState;
  dispose(options?: MossPluginUnloadOptions): Promise<void>;
}

/** Context used by host-trusted plugins to stage owned contributions. @beta */
export interface MossPluginContext {
  /** Validated configuration for this activated plugin generation. */
  readonly config: Readonly<Record<string, unknown>>;
  registerTool(tool: Tool): void;
  registerSkill(skill: SkillMeta): void;
  registerExpert(expert: SubagentExpertDefinition): void;
  registerAgentRole(role: AgentRoleDefinition): void;
  registerCommand(command: MossPluginCommand): void;
  registerProvider(provider: MossPluginProvider): void;
  registerMcpPreset(preset: MossPluginMcpPreset): void;
  addPromptLayer(layer: string): void;
  registerWebContribution(contribution: MossWebContribution): void;
  effect(setup: () => MossPluginDisposer | Promise<MossPluginDisposer>, label?: string): void;
}

/** Host-trusted runtime plugin. Workspace/model text cannot create one. @beta */
export interface MossPlugin {
  readonly id: string;
  /** Validated configuration captured for this immutable activation candidate. @internal */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Dispose an isolated candidate that was prepared but never installed. @internal */
  readonly disposeCandidate?: MossPluginDisposer;
  setup(context: MossPluginContext): void | MossPluginDisposer | Promise<void | MossPluginDisposer>;
}

/** Instance-local lifecycle and inspection surface for host-trusted plugins. @beta */
export interface MossPluginHost {
  install(plugin: MossPlugin): Promise<MossPluginHandle>;
  unload(id: string, options?: MossPluginUnloadOptions): Promise<void>;
  inspect(): MossPluginCompositionSnapshot;
  getCommand(id: string): MossPluginCommand | undefined;
  listCommands(): readonly MossPluginCommand[];
  expandCommand(id: string, args: string): Promise<string | undefined>;
  getProvider(id: string): MossPluginProvider | undefined;
  listProviders(): readonly MossPluginProvider[];
  createProvider(
    id: string,
    config: Readonly<Record<string, unknown>>
  ): Promise<LLMProvider | undefined>;
  getMcpPreset(id: string): MossPluginMcpPreset | undefined;
  listMcpPresets(): readonly MossPluginMcpPreset[];
  /** Activate and own a resource derived from an MCP preset under its plugin lease. @internal */
  activateMcpPreset<T>(
    id: string,
    setup: (preset: MossPluginMcpPreset) => Promise<{
      readonly value: T;
      readonly dispose: MossPluginDisposer;
    }>
  ): Promise<T | undefined>;
  getWebContributions(): readonly MossWebContribution[];
  subscribe(listener: (snapshot: MossPluginCompositionSnapshot) => void): MossPluginDisposer;
  close(): Promise<void>;
  /** @internal */
  getPromptLayers(): readonly string[];
  /** @internal */
  own(dispose: MossPluginDisposer, label: string): void;
}

/** @internal */
export interface MossPluginHostAdapters {
  hasTool(name: string): boolean;
  registerTool(tool: Tool, owner: string): MossPluginDisposer;
  hasSkill(id: string): boolean;
  registerSkill(skill: SkillMeta, owner: string): MossPluginDisposer;
  hasExpert(id: string): boolean;
  registerExpert(expert: SubagentExpertDefinition): MossPluginDisposer;
  hasAgentRole?: (id: string) => boolean;
  registerAgentRole?: (role: AgentRoleDefinition) => MossPluginDisposer;
}

/** Contribution batch staged before an atomic plugin activation. @internal */
export interface StagedPlugin {
  readonly tools: Tool[];
  readonly skills: SkillMeta[];
  readonly experts: SubagentExpertDefinition[];
  readonly agentRoles: AgentRoleDefinition[];
  readonly commands: MossPluginCommand[];
  readonly providers: MossPluginProvider[];
  readonly mcpPresets: MossPluginMcpPreset[];
  readonly promptLayers: string[];
  readonly webContributions: MossWebContribution[];
  readonly effects: Array<{
    readonly label: string;
    readonly setup: () => MossPluginDisposer | Promise<MossPluginDisposer>;
  }>;
}

interface PluginRecord {
  readonly id: string;
  readonly scope: CordisEffectScope;
  readonly staged: StagedPlugin;
  state: MossPluginState;
  activated: boolean;
  activeCalls: number;
  readonly quiescenceWaiters: Set<() => void>;
  disposePromise?: Promise<void>;
}

const DEFAULT_QUIESCENCE_TIMEOUT_MS = 30_000;

/**
 * Instance-local plugin lifecycle host backed by a vendored Cordis effect scope.
 *
 * Plugins stage contributions during `setup`; the host validates the complete
 * batch before publishing it. Every published contribution and custom effect is
 * then owned by one reverse-order, awaited scope.
 *
 * @beta
 */
class MossPluginHostImpl implements MossPluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly promptLayers = new Map<string, readonly string[]>();
  private readonly commands = new Map<string, MossPluginCommand>();
  private readonly providers = new Map<string, MossPluginProvider>();
  private readonly mcpPresets = new Map<string, MossPluginMcpPreset>();
  private readonly webContributions = new Map<string, MossWebContribution>();
  private readonly installOrder: string[] = [];
  private readonly listeners = new Set<(snapshot: MossPluginCompositionSnapshot) => void>();
  private generation = 0;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly adapters: MossPluginHostAdapters) {}

  async install(plugin: MossPlugin): Promise<MossPluginHandle> {
    validatePluginId(plugin.id);
    if (this.closePromise) {
      throw new MossError({
        code: ErrorCode.AGENT_DISPOSED,
        message: 'cannot install a plugin after the plugin host starts closing',
      });
    }
    if (this.records.has(plugin.id)) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `plugin already installed: ${plugin.id}`,
      });
    }

    const staged = createStagedPlugin();
    const record: PluginRecord = {
      id: plugin.id,
      state: 'loading',
      scope: new CordisEffectScope(),
      staged,
      activated: false,
      activeCalls: 0,
      quiescenceWaiters: new Set(),
    };
    this.records.set(plugin.id, record);

    try {
      const returned = await plugin.setup(this.createContext(staged, plugin.config ?? {}));
      if (typeof returned === 'function') await this.addOwned(record, returned, 'plugin setup');
      validateStagedContributions(
        plugin.id,
        staged,
        {
          hasTool: this.adapters.hasTool,
          hasSkill: this.adapters.hasSkill,
          hasExpert: this.adapters.hasExpert,
          hasAgentRole: (id) => this.adapters.hasAgentRole?.(id) ?? false,
          hasCommand: (id) => this.commands.has(id),
          hasProvider: (id) => this.providers.has(id),
          hasMcpPreset: (id) => this.mcpPresets.has(id),
          hasWebContribution: (id) => this.webContributions.has(id),
        },
        MOSS_WEB_SLOTS
      );
      await this.commit(record);
      record.state = 'active';
      record.activated = true;
      this.installOrder.push(plugin.id);
      this.generation += 1;
      this.emitComposition();
      return this.createHandle(record);
    } catch (error) {
      record.state = 'failed';
      await record.scope.dispose().catch(() => {});
      this.promptLayers.delete(plugin.id);
      this.records.delete(plugin.id);
      throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
        message: `failed to install plugin ${plugin.id}`,
        context: { pluginId: plugin.id },
      });
    }
  }

  getPromptLayers(): readonly string[] {
    return Object.freeze([...this.promptLayers.values()].flat());
  }

  getCommand(id: string): MossPluginCommand | undefined {
    return this.commands.get(id);
  }

  listCommands(): readonly MossPluginCommand[] {
    return Object.freeze(
      [...this.commands.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  async expandCommand(id: string, args: string): Promise<string | undefined> {
    const command = this.commands.get(id);
    if (!command) return undefined;
    const record = this.ownerOf('commands', id);
    if (!record) return command.expand(args);
    const release = this.acquireCall(record);
    try {
      return await command.expand(args);
    } finally {
      await release();
    }
  }

  getProvider(id: string): MossPluginProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(): readonly MossPluginProvider[] {
    return Object.freeze(
      [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  async createProvider(
    id: string,
    config: Readonly<Record<string, unknown>>
  ): Promise<LLMProvider | undefined> {
    const contribution = this.providers.get(id);
    if (!contribution) return undefined;
    const record = this.ownerOf('providers', id);
    if (!record) return contribution.create(config);
    const release = this.acquireCall(record);
    try {
      const provider = await contribution.create(config);
      return this.wrapProviderWithLease(record, provider);
    } finally {
      await release();
    }
  }

  getMcpPreset(id: string): MossPluginMcpPreset | undefined {
    return this.mcpPresets.get(id);
  }

  listMcpPresets(): readonly MossPluginMcpPreset[] {
    return Object.freeze(
      [...this.mcpPresets.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  async activateMcpPreset<T>(
    id: string,
    setup: (preset: MossPluginMcpPreset) => Promise<{
      readonly value: T;
      readonly dispose: MossPluginDisposer;
    }>
  ): Promise<T | undefined> {
    const preset = this.mcpPresets.get(id);
    if (!preset) return undefined;
    const record = this.ownerOf('mcpPresets', id);
    if (!record) {
      throw new MossError({
        code: ErrorCode.INTERNAL_INVARIANT_VIOLATED,
        message: `plugin MCP preset has no lifecycle owner: ${id}`,
      });
    }
    const release = this.acquireCall(record);
    try {
      const activated = await setup(preset);
      if (record.state !== 'active') {
        await activated.dispose();
        throw new MossError({
          code: ErrorCode.AGENT_DISPOSED,
          message: `plugin is draining: ${record.id}`,
          context: { pluginId: record.id },
        });
      }
      record.scope.add(activated.dispose, `mcp-activation:${id}`);
      return activated.value;
    } finally {
      await release();
    }
  }

  getWebContributions(): readonly MossWebContribution[] {
    return Object.freeze(
      [...this.webContributions.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  subscribe(listener: (snapshot: MossPluginCompositionSnapshot) => void): MossPluginDisposer {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  inspect(): MossPluginCompositionSnapshot {
    const plugins = [...this.records.values()]
      .map((record) => ({
        id: record.id,
        state: record.state,
        callState:
          record.state === 'active'
            ? ('accepting' as const)
            : record.state === 'disposed'
              ? ('disposed' as const)
              : ('draining' as const),
        tools: Object.freeze(record.staged.tools.map(({ name }) => name).sort()),
        skills: Object.freeze(
          record.staged.skills.map((skill) => skill.stableId ?? skill.name).sort()
        ),
        experts: Object.freeze(record.staged.experts.map(({ id }) => id).sort()),
        agentRoles: Object.freeze(record.staged.agentRoles.map(({ id }) => id).sort()),
        commands: Object.freeze(record.staged.commands.map(({ id }) => id).sort()),
        providers: Object.freeze(record.staged.providers.map(({ id }) => id).sort()),
        mcpPresets: Object.freeze(record.staged.mcpPresets.map(({ id }) => id).sort()),
        promptLayerCount: record.staged.promptLayers.length,
        effectLabels: Object.freeze([...record.scope.labels()].sort()),
        webContributions: Object.freeze(record.staged.webContributions.map(({ id }) => id).sort()),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({ generation: this.generation, plugins: Object.freeze(plugins) });
  }

  unload(id: string, options?: MossPluginUnloadOptions): Promise<void> {
    const record = this.records.get(id);
    if (!record) return Promise.resolve();
    return this.unloadRecord(record, options);
  }

  private unloadRecord(record: PluginRecord, options: MossPluginUnloadOptions = {}): Promise<void> {
    if (record.state === 'disposed') return Promise.resolve();
    if (record.disposePromise) return record.disposePromise;
    record.state = 'unloading';
    const operation = (async () => {
      try {
        try {
          await this.waitForQuiescence(record, options.timeoutMs ?? DEFAULT_QUIESCENCE_TIMEOUT_MS);
        } catch (error) {
          record.state = 'active';
          throw error;
        }
        let disposalError: unknown;
        let disposalFailed = false;
        try {
          await record.scope.dispose();
        } catch (error) {
          disposalError = error;
          disposalFailed = true;
        }
        record.state = 'disposed';
        this.promptLayers.delete(record.id);
        if (this.records.get(record.id) === record) this.records.delete(record.id);
        const index = this.installOrder.indexOf(record.id);
        if (index >= 0) this.installOrder.splice(index, 1);
        if (record.activated && record.id !== 'moss/compatibility') {
          this.generation += 1;
          this.emitComposition();
        }
        if (disposalFailed) {
          throw wrapAsMoss(disposalError, ErrorCode.TOOL_EXECUTION_FAILED, {
            message: `failed to unload plugin ${record.id}`,
            context: { pluginId: record.id },
          });
        }
      } finally {
        record.disposePromise = undefined;
      }
    })();
    record.disposePromise = operation;
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      const records = [...this.records.values()].reverse();
      for (const record of records) {
        if (record.state !== 'disposed') record.state = 'unloading';
      }
      for (const record of records) {
        try {
          await this.unloadRecord(record);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: 'one or more plugins failed to close',
          cause: new AggregateError(failures),
        });
      }
    })();
    return this.closePromise;
  }

  /** Own a compatibility contribution in the root lifecycle. @internal */
  own(dispose: MossPluginDisposer, label: string): void {
    const root = this.records.get('moss/compatibility');
    if (root) {
      root.scope.add(dispose, label);
      return;
    }
    const record: PluginRecord = {
      id: 'moss/compatibility',
      state: 'active',
      scope: new CordisEffectScope(),
      staged: createStagedPlugin(),
      activated: true,
      activeCalls: 0,
      quiescenceWaiters: new Set(),
    };
    record.scope.add(dispose, label);
    this.records.set(record.id, record);
    this.installOrder.push(record.id);
  }

  private createContext(
    staged: StagedPlugin,
    config: Readonly<Record<string, unknown>>
  ): MossPluginContext {
    return {
      config,
      registerTool: (tool) => staged.tools.push(tool),
      registerSkill: (skill) => staged.skills.push(skill),
      registerExpert: (expert) => staged.experts.push(expert),
      registerAgentRole: (role) => staged.agentRoles.push(role),
      registerCommand: (command) => staged.commands.push(command),
      registerProvider: (provider) => staged.providers.push(provider),
      registerMcpPreset: (preset) => staged.mcpPresets.push(preset),
      addPromptLayer: (layer) => staged.promptLayers.push(layer),
      registerWebContribution: (contribution) => staged.webContributions.push(contribution),
      effect: (setup, label = 'plugin effect') => staged.effects.push({ setup, label }),
    };
  }

  private async commit(record: PluginRecord): Promise<void> {
    this.assertLoading(record);
    for (const tool of record.staged.tools) {
      const leasedTool = this.wrapToolWithLease(record, tool);
      await this.addOwned(
        record,
        this.adapters.registerTool(leasedTool, record.id),
        `tool:${tool.name}`
      );
    }
    for (const skill of record.staged.skills) {
      const id = skill.stableId ?? skill.name;
      await this.addOwned(record, this.adapters.registerSkill(skill, record.id), `skill:${id}`);
    }
    for (const expert of record.staged.experts) {
      await this.addOwned(record, this.adapters.registerExpert(expert), `expert:${expert.id}`);
    }
    for (const role of record.staged.agentRoles) {
      if (!this.adapters.registerAgentRole) {
        throw new Error(`plugin agent role registration is unavailable: ${role.id}`);
      }
      await this.addOwned(record, this.adapters.registerAgentRole(role), `agent-role:${role.id}`);
    }
    for (const command of record.staged.commands) {
      await this.addOwned(
        record,
        this.registerOwned(this.commands, command),
        `command:${command.id}`
      );
    }
    for (const provider of record.staged.providers) {
      await this.addOwned(
        record,
        this.registerOwned(this.providers, provider),
        `provider:${provider.id}`
      );
    }
    for (const preset of record.staged.mcpPresets) {
      await this.addOwned(
        record,
        this.registerOwned(this.mcpPresets, preset),
        `mcp-preset:${preset.id}`
      );
    }
    for (const contribution of record.staged.webContributions) {
      await this.addOwned(
        record,
        this.registerOwned(this.webContributions, contribution, `${record.id}:${contribution.id}`),
        `web:${contribution.id}`
      );
    }
    if (record.staged.promptLayers.length > 0) {
      this.promptLayers.set(record.id, Object.freeze([...record.staged.promptLayers]));
      record.scope.add(() => {
        this.promptLayers.delete(record.id);
      }, 'prompt layers');
    }
    for (const effect of record.staged.effects) {
      await this.addOwned(record, await effect.setup(), effect.label);
    }
  }

  private assertLoading(record: PluginRecord): void {
    if (record.state !== 'loading' || this.closePromise) {
      throw new MossError({
        code: ErrorCode.AGENT_DISPOSED,
        message: `plugin installation was cancelled: ${record.id}`,
      });
    }
  }

  private registerOwned<T extends { readonly id: string }>(
    registry: Map<string, T>,
    contribution: T,
    key = contribution.id
  ): MossPluginDisposer {
    registry.set(key, contribution);
    return () => {
      if (registry.get(key) === contribution) registry.delete(key);
    };
  }

  private acquireCall(record: PluginRecord): MossPluginDisposer {
    if (record.state !== 'active') {
      throw new MossError({
        code: ErrorCode.AGENT_DISPOSED,
        message: `plugin is draining: ${record.id}`,
        context: { pluginId: record.id },
      });
    }
    record.activeCalls += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.activeCalls -= 1;
      if (record.activeCalls === 0) {
        for (const resolve of record.quiescenceWaiters) resolve();
        record.quiescenceWaiters.clear();
      }
    };
  }

  private wrapToolWithLease(record: PluginRecord, tool: Tool): Tool {
    const execute = tool.execute.bind(tool);
    const executeStructured = tool.executeStructured?.bind(tool);
    return {
      ...tool,
      execute: async (input, context) => {
        const release = this.acquireCall(record);
        try {
          return await execute(input, context);
        } finally {
          await release();
        }
      },
      ...(executeStructured
        ? {
            executeStructured: async (input, context) => {
              const release = this.acquireCall(record);
              try {
                return await executeStructured(input, context);
              } finally {
                await release();
              }
            },
          }
        : {}),
    };
  }

  private wrapProviderWithLease(record: PluginRecord, provider: LLMProvider): LLMProvider {
    return {
      id: provider.id,
      displayName: provider.displayName,
      ...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
      complete: async (options) => {
        const release = this.acquireCall(record);
        try {
          return await provider.complete(options);
        } finally {
          await release();
        }
      },
      stream: async (options, onEvent) => {
        const release = this.acquireCall(record);
        try {
          return await provider.stream(options, onEvent);
        } finally {
          await release();
        }
      },
      ...(provider.countTokens
        ? {
            countTokens: async (value: string) => {
              const release = this.acquireCall(record);
              try {
                return await provider.countTokens!(value);
              } finally {
                await release();
              }
            },
          }
        : {}),
    };
  }

  private ownerOf(
    kind: 'commands' | 'providers' | 'mcpPresets',
    id: string
  ): PluginRecord | undefined {
    return [...this.records.values()].find((record) =>
      record.staged[kind].some((item) => item.id === id)
    );
  }

  private emitComposition(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.inspect();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers are diagnostics/UI adapters and cannot invalidate an activated generation.
      }
    }
  }

  private async waitForQuiescence(record: PluginRecord, timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: 'plugin unload timeout must be a non-negative finite number',
      });
    }
    if (record.activeCalls === 0) return;
    let resolveWaiter: (() => void) | undefined;
    const quiescent = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
      record.quiescenceWaiters.add(resolve);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        quiescent,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new MossError({
                code: ErrorCode.TOOL_EXECUTION_FAILED,
                message: `plugin did not become quiescent: ${record.id}`,
                context: { pluginId: record.id, activeCalls: record.activeCalls, timeoutMs },
              })
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (resolveWaiter) record.quiescenceWaiters.delete(resolveWaiter);
    }
  }

  private async addOwned(
    record: PluginRecord,
    dispose: MossPluginDisposer,
    label: string
  ): Promise<void> {
    if (record.state !== 'loading' || this.closePromise) {
      await dispose();
      this.assertLoading(record);
    }
    record.scope.add(dispose, label);
  }

  private createHandle(record: PluginRecord): MossPluginHandle {
    return {
      id: record.id,
      get state() {
        return record.state;
      },
      dispose: (options) => this.unloadRecord(record, options),
    };
  }
}

/** Create the default Cordis-backed plugin lifecycle host. @internal */
export function createMossPluginHost(adapters: MossPluginHostAdapters): MossPluginHost {
  return new MossPluginHostImpl(adapters);
}
