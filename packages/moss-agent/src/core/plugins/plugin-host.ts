import { ErrorCode, MossError, wrapAsMoss } from '../../errors.js';
import type { SkillMeta } from '../../skills/types.js';
import { CordisEffectScope } from '../../vendor/cordis/effect-scope.js';
import type { SubagentExpertDefinition } from '../subagent/expert-registry.js';
import type { Tool } from '../tools/tool-types.js';

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/;

/** Lifecycle state exposed by the deterministic plugin inspector. @beta */
export type MossPluginState = 'loading' | 'active' | 'unloading' | 'failed' | 'disposed';

/** Cleanup callback owned by a plugin lifecycle scope. @beta */
export type MossPluginDisposer = () => void | Promise<void>;

/** A redacted description of one installed plugin. @beta */
export interface MossPluginSnapshot {
  readonly id: string;
  readonly state: MossPluginState;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly experts: readonly string[];
  readonly promptLayerCount: number;
  readonly effectLabels: readonly string[];
}

/** Redacted, deterministic plugin composition state. @beta */
export interface MossPluginCompositionSnapshot {
  readonly plugins: readonly MossPluginSnapshot[];
}

/** Handle returned after a plugin is installed successfully. @beta */
export interface MossPluginHandle {
  readonly id: string;
  readonly state: MossPluginState;
  dispose(): Promise<void>;
}

/** Context used by host-trusted plugins to stage owned contributions. @beta */
export interface MossPluginContext {
  registerTool(tool: Tool): void;
  registerSkill(skill: SkillMeta): void;
  registerExpert(expert: SubagentExpertDefinition): void;
  addPromptLayer(layer: string): void;
  effect(setup: () => MossPluginDisposer | Promise<MossPluginDisposer>, label?: string): void;
}

/** Host-trusted runtime plugin. Workspace/model text cannot create one. @beta */
export interface MossPlugin {
  readonly id: string;
  setup(context: MossPluginContext): void | MossPluginDisposer | Promise<void | MossPluginDisposer>;
}

/** Instance-local lifecycle and inspection surface for host-trusted plugins. @beta */
export interface MossPluginHost {
  install(plugin: MossPlugin): Promise<MossPluginHandle>;
  unload(id: string): Promise<void>;
  inspect(): MossPluginCompositionSnapshot;
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
}

interface StagedPlugin {
  readonly tools: Tool[];
  readonly skills: SkillMeta[];
  readonly experts: SubagentExpertDefinition[];
  readonly promptLayers: string[];
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
  disposePromise?: Promise<void>;
}

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function validatePluginId(id: string): void {
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message: `plugin id must be lowercase and path-like: ${id}`,
    });
  }
}

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
  private readonly installOrder: string[] = [];
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

    const staged: StagedPlugin = {
      tools: [],
      skills: [],
      experts: [],
      promptLayers: [],
      effects: [],
    };
    const record: PluginRecord = {
      id: plugin.id,
      state: 'loading',
      scope: new CordisEffectScope(),
      staged,
    };
    this.records.set(plugin.id, record);

    try {
      const returned = await plugin.setup(this.createContext(staged));
      if (typeof returned === 'function') record.scope.add(returned, 'plugin setup');
      this.validateStaged(plugin.id, staged);
      await this.commit(record);
      record.state = 'active';
      this.installOrder.push(plugin.id);
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

  inspect(): MossPluginCompositionSnapshot {
    const plugins = [...this.records.values()]
      .map((record) => ({
        id: record.id,
        state: record.state,
        tools: Object.freeze(record.staged.tools.map(({ name }) => name).sort()),
        skills: Object.freeze(
          record.staged.skills.map((skill) => skill.stableId ?? skill.name).sort()
        ),
        experts: Object.freeze(record.staged.experts.map(({ id }) => id).sort()),
        promptLayerCount: record.staged.promptLayers.length,
        effectLabels: Object.freeze([...record.scope.labels()].sort()),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({ plugins: Object.freeze(plugins) });
  }

  unload(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.state === 'disposed') return Promise.resolve();
    if (record.disposePromise) return record.disposePromise;
    record.state = 'unloading';
    record.disposePromise = record.scope
      .dispose()
      .catch((error: unknown) => {
        throw wrapAsMoss(error, ErrorCode.TOOL_EXECUTION_FAILED, {
          message: `failed to unload plugin ${id}`,
          context: { pluginId: id },
        });
      })
      .finally(() => {
        record.state = 'disposed';
        this.promptLayers.delete(id);
        this.records.delete(id);
        const index = this.installOrder.indexOf(id);
        if (index >= 0) this.installOrder.splice(index, 1);
      });
    return record.disposePromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      for (const id of [...this.installOrder].reverse()) {
        try {
          await this.unload(id);
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
      staged: { tools: [], skills: [], experts: [], promptLayers: [], effects: [] },
    };
    record.scope.add(dispose, label);
    this.records.set(record.id, record);
    this.installOrder.push(record.id);
  }

  private createContext(staged: StagedPlugin): MossPluginContext {
    return {
      registerTool: (tool) => staged.tools.push(tool),
      registerSkill: (skill) => staged.skills.push(skill),
      registerExpert: (expert) => staged.experts.push(expert),
      addPromptLayer: (layer) => staged.promptLayers.push(layer),
      effect: (setup, label = 'plugin effect') => staged.effects.push({ setup, label }),
    };
  }

  private validateStaged(pluginId: string, staged: StagedPlugin): void {
    const duplicateTool = duplicate(staged.tools.map(({ name }) => name));
    const duplicateSkill = duplicate(staged.skills.map((skill) => skill.stableId ?? skill.name));
    const duplicateExpert = duplicate(staged.experts.map(({ id }) => id));
    const conflict = duplicateTool ?? duplicateSkill ?? duplicateExpert;
    if (conflict)
      throw new Error(`plugin ${pluginId} contains duplicate contribution: ${conflict}`);
    for (const tool of staged.tools) {
      if (!tool.metadata?.sideEffectClass)
        throw new Error(`plugin tool ${tool.name} requires side-effect metadata`);
      if (this.adapters.hasTool(tool.name))
        throw new Error(`plugin tool already registered: ${tool.name}`);
    }
    for (const skill of staged.skills) {
      const id = skill.stableId ?? skill.name;
      if (this.adapters.hasSkill(id)) throw new Error(`plugin skill already registered: ${id}`);
    }
    for (const expert of staged.experts) {
      if (this.adapters.hasExpert(expert.id))
        throw new Error(`plugin expert already registered: ${expert.id}`);
    }
    for (const layer of staged.promptLayers) {
      if (!layer.trim()) throw new Error(`plugin ${pluginId} contains an empty prompt layer`);
    }
  }

  private async commit(record: PluginRecord): Promise<void> {
    for (const tool of record.staged.tools) {
      record.scope.add(this.adapters.registerTool(tool, record.id), `tool:${tool.name}`);
    }
    for (const skill of record.staged.skills) {
      const id = skill.stableId ?? skill.name;
      record.scope.add(this.adapters.registerSkill(skill, record.id), `skill:${id}`);
    }
    for (const expert of record.staged.experts) {
      record.scope.add(this.adapters.registerExpert(expert), `expert:${expert.id}`);
    }
    if (record.staged.promptLayers.length > 0) {
      this.promptLayers.set(record.id, Object.freeze([...record.staged.promptLayers]));
      record.scope.add(() => {
        this.promptLayers.delete(record.id);
      }, 'prompt layers');
    }
    for (const effect of record.staged.effects) {
      record.scope.add(await effect.setup(), effect.label);
    }
  }

  private createHandle(record: PluginRecord): MossPluginHandle {
    return {
      id: record.id,
      get state() {
        return record.state;
      },
      dispose: () => this.unload(record.id),
    };
  }
}

/** Create the default Cordis-backed plugin lifecycle host. @internal */
export function createMossPluginHost(adapters: MossPluginHostAdapters): MossPluginHost {
  return new MossPluginHostImpl(adapters);
}
