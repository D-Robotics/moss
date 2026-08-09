import type {
  SkillComposeInput,
  SkillComposer,
  SkillComposerConfig,
  SkillComposerProviderCapabilities,
  SkillComposerProviderFactory,
  SkillComposerProviderMode,
  SkillPlan,
} from './composer-types.js';
import { RulesSkillComposer } from './rules-skill-composer.js';
import { validateSkillPlan } from './skill-plan-validation.js';
import { toSkillCompositionTrace, type SkillCompositionTrace } from './skill-composition-trace.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';

export interface SkillCompositionResult {
  plan: SkillPlan;
  shadowPlan?: SkillPlan;
}

export interface SkillComposerOrchestratorOptions {
  config: SkillComposerConfig;
  capabilities?: SkillComposerProviderCapabilities;
  providers?: Partial<Record<'local-model' | 'remote-model', SkillComposerProviderFactory>>;
  onTrace?: (trace: SkillCompositionTrace, kind: 'active' | 'shadow') => void;
}

export class SkillComposerOrchestrator {
  private readonly rules: RulesSkillComposer;
  private readonly providerInstances = new Map<string, SkillComposer>();

  constructor(private readonly options: SkillComposerOrchestratorOptions) {
    this.rules = new RulesSkillComposer(options.config);
  }

  private selectMode(
    input: SkillComposeInput
  ): Exclude<SkillComposerProviderMode, 'legacy' | 'auto'> {
    const { config, capabilities = {} } = this.options;
    if (
      config.mode === 'rules' ||
      config.mode === 'local-model' ||
      config.mode === 'remote-model'
    ) {
      return config.mode;
    }
    // Auto mode never puts inference on a board implicitly. A deployment that
    // deliberately wants that trade-off must select local-model explicitly.
    if (input.environment.deployment === 'board') return 'rules';
    if (
      config.localModelEnabled &&
      capabilities.localModelRuntimeAvailable &&
      capabilities.modelArtifactsAvailable &&
      (config.maxMemoryMb === undefined ||
        (capabilities.localModelEstimatedMemoryMb !== undefined &&
          capabilities.localModelEstimatedMemoryMb <= config.maxMemoryMb)) &&
      (capabilities.availableMemoryMb === undefined ||
        capabilities.localModelEstimatedMemoryMb === undefined ||
        capabilities.localModelEstimatedMemoryMb <= capabilities.availableMemoryMb)
    ) {
      return 'local-model';
    }
    if (config.remoteModelEnabled && capabilities.networkAllowed) return 'remote-model';
    return 'rules';
  }

  private async resolveProvider(
    mode: 'rules' | 'local-model' | 'remote-model'
  ): Promise<SkillComposer> {
    if (mode === 'rules') return this.rules;
    const cached = this.providerInstances.get(mode);
    if (cached) return cached;
    const factory = this.options.providers?.[mode];
    if (!factory) throw new Error(`${mode} skill composer provider is not registered`);
    const provider = await factory();
    this.providerInstances.set(mode, provider);
    return provider;
  }

  private async composeWithDeadline(
    mode: 'rules' | 'local-model' | 'remote-model',
    input: SkillComposeInput,
    parentSignal?: AbortSignal
  ): Promise<SkillPlan> {
    if (parentSignal?.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new Error('Skill composition aborted');
    }
    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Skill composer deadline exceeded');
        controller.abort(error);
        reject(error);
      }, this.options.config.deadlineMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('Skill composition aborted')
        );
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const operation = (async () => {
      const composer = await this.resolveProvider(mode);
      return composer.compose(input, controller.signal);
    })();
    try {
      return await Promise.race([operation, deadline, aborted]);
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  }

  private trace(plan: SkillPlan, kind: 'active' | 'shadow'): void {
    this.options.onTrace?.(toSkillCompositionTrace(plan), kind);
  }

  private async fallback(
    input: SkillComposeInput,
    reason: string,
    signal?: AbortSignal
  ): Promise<SkillPlan> {
    const rulesPlan = await this.rules.compose(input, signal);
    return {
      ...rulesPlan,
      provider: 'fallback',
      diagnostics: {
        ...rulesPlan.diagnostics,
        fallbackReason: sanitizeSecrets(reason).slice(0, 240),
      },
    };
  }

  private async runMode(
    mode: 'rules' | 'local-model' | 'remote-model',
    input: SkillComposeInput,
    signal?: AbortSignal
  ): Promise<SkillPlan> {
    const startedAt = Date.now();
    try {
      const rawPlan = await this.composeWithDeadline(mode, input, signal);
      const plan: SkillPlan = {
        ...rawPlan,
        diagnostics: {
          ...rawPlan.diagnostics,
          registryDigest: rawPlan.diagnostics?.registryDigest ?? input.registryDigest,
          latencyMs: rawPlan.diagnostics?.latencyMs ?? Date.now() - startedAt,
        },
      };
      const validation = validateSkillPlan(plan, input);
      if (!validation.valid) return this.fallback(input, validation.errors.join('; '), signal);
      if (plan.skills.length > 0 && plan.confidence < this.options.config.minConfidence) {
        return {
          ...plan,
          skills: [],
          rejected: true,
          diagnostics: {
            ...plan.diagnostics,
            rejectionReason: 'below-minimum-confidence',
            warnings: [
              ...(plan.diagnostics?.warnings ?? []),
              `Plan confidence ${plan.confidence.toFixed(3)} is below ${this.options.config.minConfidence.toFixed(3)}`,
            ],
          },
        };
      }
      return plan;
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.fallback(input, error instanceof Error ? error.message : String(error), signal);
    }
  }

  async compose(input: SkillComposeInput, signal?: AbortSignal): Promise<SkillCompositionResult> {
    const mode = this.selectMode(input);
    const plan = await this.runMode(mode, input, signal);
    this.trace(plan, 'active');
    let shadowPlan: SkillPlan | undefined;
    const shadowMode = this.options.config.shadowProvider;
    if (this.options.config.shadowMode && shadowMode && shadowMode !== mode) {
      shadowPlan = await this.runMode(shadowMode, input, signal);
      this.trace(shadowPlan, 'shadow');
    }
    return { plan, ...(shadowPlan ? { shadowPlan } : {}) };
  }
}
