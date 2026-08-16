import type { Tool } from '../tools/tool-types.js';
import type { ToolGroup } from '../tools/tool-registry.js';
import type { SubagentExpertDefinition } from '../subagent/expert-registry.js';

/** A host-trusted, instance-local bundle of agent capabilities. @public */
export interface CapabilityPack {
  id: string;

  displayName?: string;

  buildTools?(): Tool[];

  promptLayers?: readonly string[];

  requiredHostCapabilities?: readonly string[];

  /** Declarative sub-agent experts installed with this pack. @beta */
  subagentExperts?: readonly SubagentExpertDefinition[];
}

/** Normalized contributions collected from capability packs. @public */
export interface CapabilityPackContributions {
  toolGroups: ToolGroup[];

  promptLayers: string[];

  requiredHostCapabilities: string[];

  /** @beta */
  subagentExperts: SubagentExpertDefinition[];
}

/** Validate and collect capability-pack contributions without installing them. @public */
export function collectCapabilityPacks(
  packs: readonly CapabilityPack[]
): CapabilityPackContributions {
  const toolGroups: ToolGroup[] = [];
  const promptLayers: string[] = [];
  const requiredHostCapabilities: string[] = [];
  const subagentExperts: SubagentExpertDefinition[] = [];
  const seenRequirements = new Set<string>();
  const seenPackIds = new Set<string>();

  for (const pack of packs) {
    if (!pack || typeof pack.id !== 'string' || pack.id.length === 0) {
      throw new Error('CapabilityPack requires a non-empty string id');
    }
    if (seenPackIds.has(pack.id)) {
      throw new Error(`Duplicate CapabilityPack id: ${pack.id}`);
    }
    seenPackIds.add(pack.id);

    const tools = pack.buildTools?.() ?? [];
    if (tools.length > 0) {
      toolGroups.push({
        id: pack.id,
        displayName: pack.displayName ?? pack.id,
        tools,
      });
    }

    for (const layer of pack.promptLayers ?? []) {
      if (typeof layer === 'string' && layer.trim().length > 0) {
        promptLayers.push(layer);
      }
    }

    for (const cap of pack.requiredHostCapabilities ?? []) {
      if (typeof cap === 'string' && cap.length > 0 && !seenRequirements.has(cap)) {
        seenRequirements.add(cap);
        requiredHostCapabilities.push(cap);
      }
    }

    subagentExperts.push(...(pack.subagentExperts ?? []));
  }

  return { toolGroups, promptLayers, requiredHostCapabilities, subagentExperts };
}
