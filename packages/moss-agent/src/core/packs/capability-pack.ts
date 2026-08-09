import type { Tool } from '../tools/tool-types.js';
import type { ToolGroup } from '../tools/tool-registry.js';

export interface CapabilityPack {
  id: string;

  displayName?: string;

  buildTools?(): Tool[];

  promptLayers?: readonly string[];

  requiredHostCapabilities?: readonly string[];
}

export interface CapabilityPackContributions {
  toolGroups: ToolGroup[];

  promptLayers: string[];

  requiredHostCapabilities: string[];
}

export function collectCapabilityPacks(
  packs: readonly CapabilityPack[]
): CapabilityPackContributions {
  const toolGroups: ToolGroup[] = [];
  const promptLayers: string[] = [];
  const requiredHostCapabilities: string[] = [];
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
  }

  return { toolGroups, promptLayers, requiredHostCapabilities };
}
