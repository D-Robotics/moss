import fs from 'node:fs';
import path from 'node:path';
import type { MossAgentConfig } from '../core/agent/moss-agent-types.js';
import { MossAgent } from '../core/agent/moss-agent.js';
import type { Tool } from '../core/tools/tool-types.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { ExperienceLog } from '../memory/experience-log.js';
import { ObservationAggregator } from '../memory/observation-aggregator.js';
import { SkillLearner } from '../skill-learning/skill-learner.js';
import { SkillPipeline } from '../skill-learning/skill-pipeline.js';
import { SkillRegistry } from '../skills/registry.js';
import type { SkillMeta } from '../skills/types.js';
import type { SkillEnvironmentContext, SkillPlan } from '../skills/composer-types.js';
import { normalizeSkillComposerConfig } from '../skills/composer-config.js';
import type { SkillComposerConfigInput } from '../skills/composer-config.js';
import { SkillComposerOrchestrator } from '../skills/skill-composer-orchestrator.js';
import { clearActiveSkillPlan, setActiveSkillPlan } from '../skills/active-skill-plan.js';
import { ContractRegistry } from '../acceptance/contract-registry.js';
import { TerminalVerdictLog } from '../acceptance/terminal-verdict-log.js';
import { PromotionCoordinator } from '../acceptance/promotion-coordinator.js';
import {
  createTerminalCandidateSource,
  createTerminalStatsSource,
} from '../acceptance/promotion-candidate-source.js';
import { createOpinionSink } from '../acceptance/promotion-opinion-sink.js';
import { createObjectiveVerifierHook } from '../core/tools/objective-verifier-hook.js';
import { wrapWithTerminalArbitration } from '../core/tools/terminal-arbitration-gate.js';
import { wrapWithPromotionObservation } from '../core/tools/promotion-completion-gate.js';
import { PlanControllerStore } from '../plan-execute/plan-controller-store.js';
import { createPlanStepTool, createPlanTool } from '../plan-execute/plan-tools.js';
import { builtinTools } from '../tools/builtin.js';
import { createLoadSkillTool } from '../tools/skill-tools.js';
import type { DeviceReadonlyExecutor } from '../core/tools/device-readonly-executor.js';
import type { MossPlugin, MossPluginHost } from '../core/plugins/plugin-host.js';

/** Core services shared by CLI, Desktop, and other Moss hosts. */
export interface MossCoreServices {
  memoryManager: MemoryManager;
  skillLearner: SkillLearner;
  skillPipeline: SkillPipeline;
  skillRegistry: SkillRegistry;
  experienceLog: ExperienceLog;
  observationAggregator: ObservationAggregator;
  memoryDir: string;
  skillsDir: string;
}

export interface MossCoreServicesOptions {
  workspaceDir: string;
  dataDir: string;
  model?: string;
  autoPromoteHighConfidence?: boolean;
  extraSkillDirs?: string[];
  includeBundledRdkSkills?: boolean;
}

/**
 * Construct the stateful Moss services once, independently of any CLI or UI.
 * Hosts should use this instead of assembling memory and self-learning pieces
 * separately, otherwise two products can report the same version while running
 * different capability graphs.
 */
export function createMossCoreServices(options: MossCoreServicesOptions): MossCoreServices {
  const memoryDir = path.join(options.dataDir, 'memory');
  const skillsDir = path.join(options.dataDir, 'skills');
  const memoryManager = new MemoryManager(memoryDir);
  const skillLearner = new SkillLearner({ skillsDir });
  const skillPipeline = new SkillPipeline({
    workspaceDir: options.workspaceDir,
    model: options.model,
    autoPromoteHighConfidence: options.autoPromoteHighConfidence ?? false,
  });
  const skillRegistry = new SkillRegistry({
    workspaceDir: options.workspaceDir,
    extraDirs: [skillsDir, ...(options.extraSkillDirs ?? [])],
    includeBuiltin: true,
    includeBundledRdkSkills: options.includeBundledRdkSkills ?? true,
  });
  const experienceLog = new ExperienceLog({ baseDir: memoryDir });
  const observationAggregator = new ObservationAggregator({ experienceLog, memoryManager });
  return {
    memoryManager,
    skillLearner,
    skillPipeline,
    skillRegistry,
    experienceLog,
    observationAggregator,
    memoryDir,
    skillsDir,
  };
}

export type MossRuntimeToolProfile = 'desktop-safe' | 'full';

export interface CreateMossRuntimeOptions {
  workspaceDir: string;
  dataDir: string;
  agentConfig: Omit<
    MossAgentConfig,
    | 'workspaceDir'
    | 'memoryManager'
    | 'skillLearner'
    | 'skillPipeline'
    | 'skillRegistry'
    | 'memoryContextProvider'
    | 'completionGate'
  >;
  toolProfile?: MossRuntimeToolProfile;
  extraTools?: Tool[];
  enableSelfEvolution?: boolean;
  /** Live device verifier used by terminal acceptance and objective hooks. */
  deviceExecutor?: { current: DeviceReadonlyExecutor | null };
  enableSkillComposer?: boolean;
  skillComposer?: SkillComposerConfigInput;
  /** Explicit packaged skill roots (for example Electron extraResources). */
  extraSkillDirs?: string[];
  /** Disable package-relative discovery when a host supplies packaged roots. */
  includeBundledRdkSkills?: boolean;
  /** Host-trusted plugins installed before the runtime is returned. @beta */
  plugins?: readonly MossPlugin[];
}

export interface ComposedSkillContext {
  context: string;
  plan?: SkillPlan;
}

export interface MossRuntime {
  agent: MossAgent;
  /** @beta */
  plugins: MossPluginHost;
  services: MossCoreServices;
  toolProfile: MossRuntimeToolProfile;
  toolNames: string[];
  composeSkillContext(
    task: string,
    sessionKey: string,
    signal?: AbortSignal
  ): Promise<ComposedSkillContext>;
  close(): Promise<void>;
}

const DESKTOP_SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'search_code',
  'todo_write',
  'web_fetch',
  'web_search',
  'load_skill',
  'skillhub_search',
  'generate_structured',
  'eval',
  'plan',
  'plan_step',
]);

function selectTools(
  profile: MossRuntimeToolProfile,
  skillRegistry: SkillRegistry,
  planControllerStore: MossAgent['planControllerStore'],
  agentExecutionStore: MossAgent['executionStore']
): Tool[] {
  const selected =
    profile === 'full'
      ? [...builtinTools]
      : builtinTools.filter((tool) => DESKTOP_SAFE_TOOLS.has(tool.name));
  return selected.map((tool) => {
    if (tool.name === 'load_skill') return createLoadSkillTool(skillRegistry);
    if (tool.name === 'plan') return createPlanTool(planControllerStore, agentExecutionStore);
    if (tool.name === 'plan_step')
      return createPlanStepTool(planControllerStore, agentExecutionStore);
    return tool;
  });
}

function readSkillBody(skill: SkillMeta): string | undefined {
  if (skill.body?.trim()) return skill.body.trim();
  if (skill.sourcePath.startsWith('builtin://')) return undefined;
  try {
    const raw = fs.readFileSync(skill.sourcePath, 'utf8');
    return raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  } catch {
    return undefined;
  }
}

/**
 * Create an embeddable Moss runtime. Electron bundles this module into its main
 * process, so the installed application does not require a global Moss CLI.
 */
export async function createMossRuntime(options: CreateMossRuntimeOptions): Promise<MossRuntime> {
  const toolProfile = options.toolProfile ?? 'desktop-safe';
  const services = createMossCoreServices({
    workspaceDir: options.workspaceDir,
    dataDir: options.dataDir,
    model: options.agentConfig.model,
    extraSkillDirs: options.extraSkillDirs,
    includeBundledRdkSkills: options.includeBundledRdkSkills,
  });
  await services.memoryManager.load();

  const selfEvolutionEnabled = options.enableSelfEvolution !== false;
  const terminalVerdictLog = new TerminalVerdictLog({ baseDir: services.memoryDir });
  const planControllerStore = new PlanControllerStore();
  const planProvider = {
    get: (sessionKey: string) => planControllerStore.getActivePlanForSession(sessionKey),
  };
  const deviceExecutor = options.deviceExecutor ?? { current: null };
  const promotionCoordinator = new PromotionCoordinator({
    candidateSource: createTerminalCandidateSource({ terminalVerdictLog }),
    statsSource: createTerminalStatsSource({ terminalVerdictLog }),
    crossSignalVerifier: () => false,
    decisionSink: createOpinionSink({ memoryManager: services.memoryManager }),
  });

  const baseCompletionGate = async () => ({ ok: true as const });
  const completionGate = selfEvolutionEnabled
    ? wrapWithPromotionObservation(
        wrapWithTerminalArbitration(baseCompletionGate, {
          experienceLog: services.experienceLog,
          planProvider,
          workspaceDir: options.workspaceDir,
          deviceExecutor,
          terminalVerdictLog,
        }),
        {
          async observeCompletion(completion) {
            await promotionCoordinator.observeCompletion(completion);
            await services.observationAggregator.aggregate();
          },
        }
      )
    : undefined;

  const agent = new MossAgent({
    ...options.agentConfig,
    workspaceDir: options.workspaceDir,
    memoryManager: services.memoryManager,
    skillLearner: services.skillLearner,
    skillPipeline: services.skillPipeline,
    skillRegistry: services.skillRegistry,
    memoryContextProvider: () => services.memoryManager.buildDigest(),
    planControllerStore,
    ...(completionGate ? { completionGate } : {}),
  });

  for (const tool of selectTools(
    toolProfile,
    services.skillRegistry,
    agent.planControllerStore,
    agent.executionStore
  ))
    agent.tools.register(tool);
  for (const tool of options.extraTools ?? []) agent.tools.replace(tool, 'host:extra-tools');
  try {
    for (const plugin of options.plugins ?? []) await agent.plugins.install(plugin);
  } catch (error) {
    await agent.close();
    throw error;
  }

  if (selfEvolutionEnabled) {
    const contracts = ContractRegistry.fromSkills(services.skillRegistry.list());
    agent.registerPostToolHook(
      createObjectiveVerifierHook({
        experienceLog: services.experienceLog,
        contractRegistry: contracts,
        planProvider,
        deviceExecutor,
      })
    );
  }

  const composerConfig = normalizeSkillComposerConfig(
    {
      ...options.skillComposer,
      enabled: options.enableSkillComposer ?? options.skillComposer?.enabled ?? false,
    },
    'host'
  );
  const composer = new SkillComposerOrchestrator({ config: composerConfig });

  return {
    agent,
    plugins: agent.plugins,
    services,
    toolProfile,
    get toolNames() {
      return agent.tools.getNames();
    },
    close: () => agent.close(),
    async composeSkillContext(task, sessionKey, signal) {
      if (!composerConfig.enabled || composerConfig.mode === 'legacy') {
        clearActiveSkillPlan(sessionKey);
        return { context: '' };
      }
      const snapshot = services.skillRegistry.snapshot();
      const environment: SkillEnvironmentContext = {
        deployment: 'host',
        networkAllowed: agent.tools.has('web_search') || agent.tools.has('web_fetch'),
        availablePermissions:
          toolProfile === 'full'
            ? ['workspace_read', 'workspace_write', 'device_exec', 'network']
            : ['workspace_read', 'network'],
        platform: process.platform,
      };
      const result = await composer.compose(
        {
          task,
          environment,
          skills: snapshot.skills,
          maxSkills: composerConfig.maxSkills,
          registryDigest: snapshot.digest,
        },
        signal
      );
      const plan = result.plan;
      setActiveSkillPlan(sessionKey, plan);
      const byId = new Map(snapshot.skills.map((skill) => [skill.stableId, skill]));
      const sections: string[] = [];
      for (const planned of plan.skills) {
        const skill = byId.get(planned.stableId);
        if (!skill) continue;
        const body = readSkillBody(skill);
        sections.push(
          body
            ? `### ${skill.name}\n${skill.description}\n\n${body}`
            : `### ${skill.name}\n${skill.description}`
        );
      }
      const context =
        sections.length === 0
          ? ''
          : [
              '## Ordered Skill Plan',
              `Apply these skills in order: ${plan.skills.map((skill, index) => `${index + 1}. ${skill.name}`).join(' -> ')}`,
              ...sections,
            ].join('\n\n');
      if (plan.diagnostics) plan.diagnostics.injectedChars = context.length;
      return {
        plan,
        context,
      };
    },
  };
}
