import type { MossAgent } from '../core/agent/moss-agent.js';
import type { InstalledPluginRegistry } from '../plugins/installed-plugin-registry.js';
import type { CliServices } from '../cli/cli-services.js';
import type { ConfigFile } from '../cli/config.js';
import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';

export type MossWebSettingsSection =
  | 'general'
  | 'models'
  | 'permissions'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'runtime';

export interface MossWebSettingsServiceOptions {
  readonly configPath?: string;
  readonly pluginRegistry?: InstalledPluginRegistry;
}

interface ValidationResult {
  readonly valid: boolean;
  readonly dirty: boolean;
  readonly errors: Readonly<Record<string, string>>;
}

const EDITABLE_SECTIONS = new Set<MossWebSettingsSection>([
  'general',
  'models',
  'permissions',
  'skills',
  'mcp',
]);

/** Settings application service that reuses CLI config validation and persistence. @internal */
export class MossWebSettingsService {
  private readonly configPath: string;

  constructor(
    private readonly agent: MossAgent,
    private readonly services: Pick<CliServices, 'config' | 'models'>,
    private readonly options: MossWebSettingsServiceOptions = {}
  ) {
    this.configPath = options.configPath ?? services.config.resolveConfigPath();
  }

  async snapshot() {
    const sections = await Promise.all(
      (['general', 'models', 'permissions', 'skills', 'mcp', 'plugins', 'runtime'] as const).map(
        async (section) => [section, await this.section(section)] as const
      )
    );
    return { sections: Object.fromEntries(sections) };
  }

  async section(section: MossWebSettingsSection) {
    this.assertSection(section);
    const config = this.load();
    if (section === 'general') {
      return this.view(section, {
        profile: config.profile,
        workspace: config.workspace,
        promptCache: config.promptCache,
        agent: config.agent,
      });
    }
    if (section === 'models') {
      return {
        ...this.view(section, {
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
        }),
        credentials: { apiKey: { configured: Boolean(config.apiKey) } },
      };
    }
    if (section === 'permissions') {
      return this.view(section, {
        safetyMode: config.safetyMode,
        approvalPolicy: config.approvalPolicy,
        trustedTools: config.trustedTools ?? [],
        deniedTools: config.deniedTools ?? [],
        guardrails: config.guardrails,
      });
    }
    if (section === 'skills') {
      return {
        ...this.view(section, { ...(config.skills ?? {}) }),
        inventory:
          this.agent.config.skillRegistry?.list().map((skill) => ({
            id: skill.stableId ?? skill.name,
            name: skill.name,
            description: skill.description,
            enabled: skill.enabled !== false,
          })) ?? [],
        diagnostics: this.agent.config.skillRegistry?.diagnostics() ?? [],
      };
    }
    if (section === 'mcp') {
      return this.view(section, { ...(config.mcp ?? {}) });
    }
    if (section === 'plugins') {
      return {
        ...this.view(section, {}),
        installed: (await this.options.pluginRegistry?.list()) ?? [],
        active: this.agent.plugins.inspect(),
      };
    }
    return {
      ...this.view(section, {}),
      inventory: {
        model: this.agent.config.model,
        workspace: this.agent.config.workspaceDir,
        tools: this.agent.tools.getNames(),
        asyncTasks: this.agent.asyncTasks.list(),
        plugins: this.agent.plugins.inspect(),
      },
    };
  }

  validate(section: MossWebSettingsSection, values: unknown): ValidationResult {
    this.assertEditable(section);
    const errors: Record<string, string> = {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return { valid: false, dirty: false, errors: { values: 'expected an object' } };
    }
    const draft = values as Record<string, unknown>;
    if (section === 'general') {
      if (
        draft.profile !== undefined &&
        draft.profile !== null &&
        this.services.config.normalizeConfigProfile(String(draft.profile)) === null
      ) {
        errors.profile = 'profile must be cautious, balanced, or autonomous';
      }
      if (
        draft.workspace !== undefined &&
        draft.workspace !== null &&
        typeof draft.workspace !== 'string'
      ) {
        errors.workspace = 'workspace must be a path string';
      }
    }
    if (section === 'models') {
      for (const field of ['provider', 'model', 'baseUrl'] as const) {
        if (
          draft[field] !== undefined &&
          draft[field] !== null &&
          typeof draft[field] !== 'string'
        ) {
          errors[field] = `${field} must be a string`;
        }
      }
      if (typeof draft.baseUrl === 'string') {
        try {
          const protocol = new URL(draft.baseUrl).protocol;
          if (protocol !== 'http:' && protocol !== 'https:')
            errors.baseUrl = 'baseUrl must use http or https';
        } catch {
          errors.baseUrl = 'baseUrl must be a valid URL';
        }
      }
      if ('apiKey' in draft) errors.apiKey = 'credentials use the write-only credential endpoint';
    }
    if (section === 'permissions') {
      if (
        draft.safetyMode !== undefined &&
        draft.safetyMode !== null &&
        this.services.config.normalizeSafetyModeConfig(String(draft.safetyMode)) === null
      ) {
        errors.safetyMode = 'safetyMode must be read-only, workspace-write, or full-access';
      }
      if (
        draft.approvalPolicy !== undefined &&
        draft.approvalPolicy !== null &&
        this.services.config.normalizeApprovalPolicyConfig(String(draft.approvalPolicy)) === null
      ) {
        errors.approvalPolicy = 'approvalPolicy must be prompt or never';
      }
      for (const field of ['trustedTools', 'deniedTools'] as const) {
        if (
          draft[field] !== undefined &&
          draft[field] !== null &&
          (!Array.isArray(draft[field]) || draft[field].some((item) => typeof item !== 'string'))
        ) {
          errors[field] = `${field} must be an array of strings`;
        }
      }
    }
    if (section === 'skills') {
      if (
        draft.extraRoots !== undefined &&
        draft.extraRoots !== null &&
        (!Array.isArray(draft.extraRoots) ||
          draft.extraRoots.some((item) => typeof item !== 'string'))
      ) {
        errors.extraRoots = 'extraRoots must be an array of path strings';
      }
    }
    if (section === 'mcp') {
      if (
        draft.enabled !== undefined &&
        draft.enabled !== null &&
        typeof draft.enabled !== 'boolean'
      ) {
        errors.enabled = 'enabled must be a boolean';
      }
      if (
        draft.configPath !== undefined &&
        draft.configPath !== null &&
        typeof draft.configPath !== 'string'
      ) {
        errors.configPath = 'configPath must be a path string';
      }
    }
    const current = this.sectionValues(section, this.load());
    return {
      valid: Object.keys(errors).length === 0,
      dirty: JSON.stringify(current) !== JSON.stringify({ ...current, ...draft }),
      errors,
    };
  }

  save(section: MossWebSettingsSection, values: unknown): ValidationResult {
    const validation = this.validate(section, values);
    if (!validation.valid) return validation;
    const draft = values as Record<string, unknown>;
    const current = this.load();
    const next = this.applySection(section, current, draft);
    this.persist(next);
    return { valid: true, dirty: false, errors: {} };
  }

  async modelCatalog() {
    const config = this.services.config.resolveCliConfig({}, this.load(), {
      configPath: this.configPath,
    });
    return this.services.models.loadModelChoicesForRuntime(config, config.model ?? '');
  }

  async selectModel(input: string) {
    const catalog = await this.modelCatalog();
    const selected = this.services.models.resolveModelSelection(input, catalog.choices);
    if (!selected) this.invalid(`unknown model "${input}"`);
    const model =
      (selected as { model?: string; id?: string }).model ?? (selected as { id?: string }).id;
    if (!model) this.invalid('selected model has no model id');
    const config = this.load();
    this.persist({ ...config, model });
    return { model, provider: selected.provider, restartRequired: true };
  }

  writeCredential(name: 'apiKey', value: string): void {
    if (name !== 'apiKey') this.invalid(`unknown credential "${name}"`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 16_384) {
      this.invalid('credential must contain 1 to 16384 characters');
    }
    this.persist({ ...this.load(), apiKey: normalized });
  }

  deleteCredential(name: 'apiKey'): void {
    if (name !== 'apiKey') this.invalid(`unknown credential "${name}"`);
    const { apiKey: _, _apiKeyEncrypted: __, ...rest } = this.load();
    this.persist(rest);
  }

  private view(section: MossWebSettingsSection, values: Readonly<Record<string, unknown>>) {
    return {
      section,
      values,
      valid: true,
      dirty: false,
      errors: {},
      editable: EDITABLE_SECTIONS.has(section),
    };
  }

  private sectionValues(
    section: MossWebSettingsSection,
    config: ConfigFile
  ): Record<string, unknown> {
    if (section === 'general')
      return {
        profile: config.profile,
        workspace: config.workspace,
        promptCache: config.promptCache,
        agent: config.agent,
      };
    if (section === 'models')
      return { provider: config.provider, model: config.model, baseUrl: config.baseUrl };
    if (section === 'permissions')
      return {
        safetyMode: config.safetyMode,
        approvalPolicy: config.approvalPolicy,
        trustedTools: config.trustedTools ?? [],
        deniedTools: config.deniedTools ?? [],
        guardrails: config.guardrails,
      };
    if (section === 'skills') return { ...(config.skills ?? {}) };
    if (section === 'mcp') return { ...(config.mcp ?? {}) };
    return {};
  }

  private applySection(
    section: MossWebSettingsSection,
    config: ConfigFile,
    draft: Record<string, unknown>
  ): ConfigFile {
    const values = { ...this.sectionValues(section, config), ...draft };
    for (const [key, value] of Object.entries(values)) if (value === null) delete values[key];
    if (section === 'general') return { ...config, ...values } as ConfigFile;
    if (section === 'models') return { ...config, ...values } as ConfigFile;
    if (section === 'permissions') return { ...config, ...values } as ConfigFile;
    if (section === 'skills') return { ...config, skills: values as ConfigFile['skills'] };
    return { ...config, mcp: values as ConfigFile['mcp'] };
  }

  private load(): ConfigFile {
    return this.services.config.loadConfigFile(this.configPath);
  }

  private persist(config: ConfigFile): void {
    try {
      this.services.config.saveConfigFileAtPath(config, this.configPath);
    } catch (error) {
      throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
        message: 'Failed to persist Web settings',
      });
    }
  }

  private assertSection(section: string): asserts section is MossWebSettingsSection {
    if (
      !['general', 'models', 'permissions', 'skills', 'mcp', 'plugins', 'runtime'].includes(section)
    ) {
      this.invalid(`unknown settings section "${section}"`);
    }
  }

  private assertEditable(section: MossWebSettingsSection): void {
    this.assertSection(section);
    if (!EDITABLE_SECTIONS.has(section)) this.invalid(`settings section "${section}" is read-only`);
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
  }
}
