import { ErrorCode, wrapAsMoss } from '../../errors.js';
import type { SkillRegistry } from '../../skills/registry.js';
import { collectCapabilityPacks } from '../packs/capability-pack.js';
import { createMossPluginHost, type MossPluginHost } from '../plugins/plugin-host.js';
import {
  resolveSubagentExpertRegistry,
  type SubagentExpertRegistry,
} from '../subagent/expert-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MossAgentConfig } from './moss-agent-types.js';
import { AgentRoleRegistry } from '../../orchestration/agent-role-registry.js';

export interface AgentPluginComposition {
  readonly expertRegistry: SubagentExpertRegistry;
  readonly agentRoleRegistry: AgentRoleRegistry;
  readonly pluginHost: MossPluginHost;
  readonly packPromptLayers: readonly string[];
  readonly packHostRequirements: readonly string[];
}

/** Build the instance-local compatibility layer over the Cordis-style plugin host. @internal */
export function createAgentPluginComposition(
  config: MossAgentConfig,
  tools: ToolRegistry
): AgentPluginComposition {
  try {
    const contributions = collectCapabilityPacks(config.capabilityPacks ?? []);
    const expertResolution = resolveSubagentExpertRegistry(config, contributions);
    const agentRoleRegistry =
      config.agentRoleRegistry ??
      new AgentRoleRegistry({ allowIsolatedWrite: config.allowPluginIsolatedWrite });
    const roleDisposers = (config.agentRoles ?? []).map((role) => agentRoleRegistry.register(role));
    const skillRegistry: SkillRegistry | undefined = config.skillRegistry;
    const pluginHost = createMossPluginHost({
      hasTool: (name) => tools.has(name),
      registerTool: (tool, owner) => tools.registerScoped(tool, `plugin:${owner}`),
      hasSkill: (id) => skillRegistry?.hasStableId(id) ?? false,
      registerSkill: (skill) => {
        if (!skillRegistry) throw new Error('plugin skill registration requires skillRegistry');
        return skillRegistry.registerInline(skill);
      },
      hasExpert: (id) => expertResolution.registry.get(id) !== undefined,
      registerExpert: (expert) => expertResolution.registry.register(expert),
      hasAgentRole: (id) => agentRoleRegistry.get(id) !== undefined,
      registerAgentRole: (role) => agentRoleRegistry.register(role),
    });
    pluginHost.own(expertResolution.disposePackExperts, 'capability-pack experts');
    for (const [index, dispose] of roleDisposers.entries()) {
      pluginHost.own(dispose, `configured agent role:${config.agentRoles?.[index]?.id ?? index}`);
    }
    for (const group of contributions.toolGroups) {
      tools.registerGroup(group);
      pluginHost.own(() => tools.removeGroup(group.id), `capability-pack tools:${group.id}`);
    }
    return {
      expertRegistry: expertResolution.registry,
      agentRoleRegistry,
      pluginHost,
      packPromptLayers: contributions.promptLayers,
      packHostRequirements: contributions.requiredHostCapabilities,
    };
  } catch (error) {
    throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
      message: 'invalid agent plugin or capability-pack configuration',
    });
  }
}
