import type {
  KnowledgeModule,
  DeviceProfileBase,
  DocIndexEntry,
  PromptFragment,
  CommandPattern,
  FailureHint,
} from '@rdk-moss/core';
import type { DeviceFamily } from '@rdk-moss/core';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('agent:knowledge');

export class KnowledgeRegistry {
  private readonly modules = new Map<string, KnowledgeModule>();

  private warnIfDependencyCycle(mod: KnowledgeModule): void {
    const deps = mod.dependencies ?? [];
    if (deps.length === 0) return;
    for (const depId of deps) {
      const other = this.modules.get(depId);
      if (!other) continue;
      const otherDeps = other.dependencies ?? [];
      if (otherDeps.includes(mod.id)) {
        log.warn('dependency cycle detected', {
          modules: [mod.id, other.id],
          note: 'direct 2-node cycle; registration continues',
        });
      }
    }
  }

  register(mod: KnowledgeModule): void {
    const existing = this.modules.get(mod.id);
    if (existing === mod) {
      return;
    }
    if (existing) {
      log.warn('replacing module', {
        id: mod.id,
        oldVersion: existing.version,
        newVersion: mod.version,
      });
    }
    this.warnIfDependencyCycle(mod);
    this.modules.set(mod.id, mod);
    log.debug('registered', {
      id: mod.id,
      version: mod.version,
      platforms: mod.platforms.length,
    });
  }

  unregister(id: string): boolean {
    return this.modules.delete(id);
  }

  get(id: string): KnowledgeModule | undefined {
    return this.modules.get(id);
  }

  getAll(): KnowledgeModule[] {
    return [...this.modules.values()];
  }

  findForPlatform(platform: string): KnowledgeModule | undefined {
    const candidates: KnowledgeModule[] = [];
    for (const mod of this.modules.values()) {
      if (mod.platforms.includes(platform)) candidates.push(mod);
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    candidates.sort((a, b) => {
      const pa = a.platformClaimPriority ?? 0;
      const pb = b.platformClaimPriority ?? 0;
      if (pb !== pa) return pb - pa;
      return a.id.localeCompare(b.id);
    });
    return candidates[0];
  }

  findForFamily(family: DeviceFamily): KnowledgeModule | undefined {
    const candidates: KnowledgeModule[] = [];
    for (const mod of this.modules.values()) {
      if (mod.family === family) candidates.push(mod);
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    candidates.sort((a, b) => {
      const pa = a.platformClaimPriority ?? 0;
      const pb = b.platformClaimPriority ?? 0;
      if (pb !== pa) return pb - pa;
      return a.id.localeCompare(b.id);
    });
    return candidates[0];
  }

  getAllDeviceProfiles(): Record<string, DeviceProfileBase> {
    const result: Record<string, DeviceProfileBase> = {};
    for (const mod of this.modules.values()) {
      Object.assign(result, mod.getDeviceProfiles());
    }
    return result;
  }

  getAllDocEntries(): DocIndexEntry[] {
    const entries: DocIndexEntry[] = [];
    for (const mod of this.modules.values()) {
      entries.push(...mod.getDocIndex());
    }
    return entries;
  }

  getAllPromptFragments(filter?: {
    tier?: string;
    mode?: string;
    section?: string;
  }): PromptFragment[] {
    const fragments: PromptFragment[] = [];
    const wantTier = filter?.tier && filter.tier !== 'all' ? filter.tier : undefined;
    const wantMode = filter?.mode && filter.mode !== 'all' ? filter.mode : undefined;
    for (const mod of this.modules.values()) {
      for (const f of mod.getPromptFragments()) {
        if (wantTier && f.tier !== 'all' && f.tier !== wantTier) continue;
        if (wantMode && f.mode !== 'all' && f.mode !== wantMode) continue;
        if (filter?.section && f.section !== filter.section) continue;
        fragments.push(f);
      }
    }
    return fragments.sort((a, b) => {
      const prioDiff = b.priority - a.priority;
      if (prioDiff !== 0) return prioDiff;
      return (a.section ?? '').localeCompare(b.section ?? '');
    });
  }

  getAllCommandPatterns(): CommandPattern[] {
    const patterns: CommandPattern[] = [];
    for (const mod of this.modules.values()) {
      patterns.push(...mod.getCommandPatterns());
    }
    return patterns;
  }

  getAllFailureHints(): FailureHint[] {
    const hints: FailureHint[] = [];
    for (const mod of this.modules.values()) {
      hints.push(...mod.getFailureHints());
    }
    return hints;
  }

  getAggregatedEcosystemPrompt(): string {
    const sortedModules = [...this.modules.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, mod]) => mod);
    const parts: string[] = [];
    for (const mod of sortedModules) {
      const p = mod.getEcosystemPrompt();
      if (p.trim()) parts.push(p);
    }
    return parts.join('\n\n');
  }

  dispose(): void {
    this.modules.clear();
  }
}

const defaultRegistry = new KnowledgeRegistry();

const pendingGlobalModules = new Map<string, KnowledgeModule>();
const extensionBridgedModules = new Map<string, KnowledgeModule>();
let deprecationWarningEmitted = false;

export function drainPendingGlobalModules(target: KnowledgeRegistry): void {
  for (const mod of pendingGlobalModules.values()) {
    target.register(mod);
  }
}

export function bridgeGlobalKnowledgeModuleForExtension(mod: KnowledgeModule): void {
  extensionBridgedModules.set(mod.id, mod);
  defaultRegistry.register(mod);
  pendingGlobalModules.set(mod.id, mod);
}

export function unbridgeGlobalKnowledgeModuleForExtension(id: string): boolean {
  const bridged = extensionBridgedModules.get(id);
  if (!bridged) return false;
  extensionBridgedModules.delete(id);

  let removedFromDefault = false;
  if (defaultRegistry.get(id) === bridged) {
    removedFromDefault = defaultRegistry.unregister(id);
  }

  let removedFromBridge = false;
  if (pendingGlobalModules.get(id) === bridged) {
    removedFromBridge = pendingGlobalModules.delete(id);
  }

  return removedFromDefault || removedFromBridge;
}

export function registerKnowledgeModule(mod: KnowledgeModule): void {
  if (!deprecationWarningEmitted) {
    log.warn(
      'registerKnowledgeModule() is deprecated — use agent.registerKnowledge(mod) instead. ' +
        'Global registrations are bridged into new MossAgent instances at construction time.'
    );
    deprecationWarningEmitted = true;
  }
  extensionBridgedModules.delete(mod.id);
  defaultRegistry.register(mod);
  pendingGlobalModules.set(mod.id, mod);
}

export function unregisterKnowledgeModule(id: string): boolean {
  extensionBridgedModules.delete(id);
  const removedFromDefault = defaultRegistry.unregister(id);
  const removedFromBridge = pendingGlobalModules.delete(id);
  return removedFromDefault || removedFromBridge;
}

export function getKnowledgeModule(id: string): KnowledgeModule | undefined {
  return defaultRegistry.get(id);
}

export function getAllKnowledgeModules(): KnowledgeModule[] {
  return defaultRegistry.getAll();
}

export function findModuleForPlatform(platform: string): KnowledgeModule | undefined {
  return defaultRegistry.findForPlatform(platform);
}

export function findModuleForFamily(family: DeviceFamily): KnowledgeModule | undefined {
  return defaultRegistry.findForFamily(family);
}

export function getAllDeviceProfiles(): Record<string, DeviceProfileBase> {
  return defaultRegistry.getAllDeviceProfiles();
}

export function getAllDocEntries(): DocIndexEntry[] {
  return defaultRegistry.getAllDocEntries();
}

export function getAllPromptFragments(filter?: {
  tier?: string;
  mode?: string;
  section?: string;
}): PromptFragment[] {
  return defaultRegistry.getAllPromptFragments(filter);
}

export function getAllCommandPatterns(): CommandPattern[] {
  return defaultRegistry.getAllCommandPatterns();
}

export function getAllFailureHints(): FailureHint[] {
  return defaultRegistry.getAllFailureHints();
}

export function getAggregatedEcosystemPrompt(): string {
  return defaultRegistry.getAggregatedEcosystemPrompt();
}
