import type { MossVendorPlugin } from '@rdk-moss/core';
import type { MossPlatformExtension } from '@rdk-moss/core';
import type { KnowledgeRegistry } from '../knowledge/registry.js';
import {
  bridgeGlobalKnowledgeModuleForExtension,
  unbridgeGlobalKnowledgeModuleForExtension,
} from '../knowledge/registry.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('extensions');

export interface VendorPluginCallbacks<THostTool = unknown> {
  register(plugin: MossVendorPlugin<THostTool>): void;
  unregister(id: string): void;
}

export class PlatformExtensionRegistry {
  private vendorCallbacks: VendorPluginCallbacks | null = null;
  private knowledgeRegistry: KnowledgeRegistry | null = null;
  private lastApplied = new Map<string, boolean>();
  private cachedExtensions: MossPlatformExtension[] = [];

  setVendorPluginCallbacks(callbacks: VendorPluginCallbacks): void {
    this.vendorCallbacks = callbacks;
  }

  setKnowledgeRegistry(registry: KnowledgeRegistry): void {
    this.knowledgeRegistry = registry;
  }

  apply(ext: MossPlatformExtension): void {
    const want = ext.isEnabled();
    const prev = this.lastApplied.get(ext.id);
    if (prev === want && prev !== undefined) return;

    if (!want) {
      this.knowledgeRegistry?.unregister(ext.knowledgeModuleId);
      this.vendorCallbacks?.unregister(ext.vendorPluginId);
      this.lastApplied.set(ext.id, false);
      return;
    }

    this.knowledgeRegistry?.register(ext.getKnowledgeModule());
    this.vendorCallbacks?.register(ext.getVendorPlugin());
    this.lastApplied.set(ext.id, true);
  }

  applyForce(ext: MossPlatformExtension): void {
    this.lastApplied.delete(ext.id);
    this.apply(ext);
  }

  reset(): void {
    this.lastApplied.clear();
  }

  listAppliedState(): ReadonlyMap<string, boolean> {
    return this.lastApplied;
  }

  setExtensionsSnapshot(exts: readonly MossPlatformExtension[]): void {
    this.cachedExtensions = [...exts];
  }

  getExtensions(): readonly MossPlatformExtension[] {
    return this.cachedExtensions;
  }

  syncAtStartup(factories: Array<() => MossPlatformExtension>): void {
    const instances: MossPlatformExtension[] = [];
    for (const factory of factories) {
      const ext = factory();
      instances.push(ext);
      this.apply(ext);
    }
    this.setExtensionsSnapshot(instances);
  }

  copyCompatibilityStateFrom(source: PlatformExtensionRegistry): void {
    this.vendorCallbacks = source.vendorCallbacks;
    this.cachedExtensions = [...source.cachedExtensions];
  }
}

let _defaultRegistry: PlatformExtensionRegistry | null = null;

function getDefault(): PlatformExtensionRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new PlatformExtensionRegistry();
  }
  return _defaultRegistry;
}

export function getDefaultExtensionsRegistry(): PlatformExtensionRegistry {
  return getDefault();
}

export function createAgentExtensionRegistryFromDefaults(): PlatformExtensionRegistry {
  const registry = new PlatformExtensionRegistry();
  registry.copyCompatibilityStateFrom(getDefault());
  return registry;
}

export function resetExtensionsWireCountForTests(): void {
  _deprecatedWarnedFunctions.clear();
}

const _deprecatedWarnedFunctions = new Set<string>();

function warnDeprecated(name: string): void {
  if (_deprecatedWarnedFunctions.has(name)) return;
  _deprecatedWarnedFunctions.add(name);
  log.warn(
    `Deprecated extension free function "${name}" called. ` +
      'Migrate to agent.extensions.* for per-agent isolation.'
  );
}

function bridgeDefaultExtensionKnowledge(ext: MossPlatformExtension): void {
  if (ext.isEnabled()) {
    bridgeGlobalKnowledgeModuleForExtension(ext.getKnowledgeModule());
  } else {
    unbridgeGlobalKnowledgeModuleForExtension(ext.knowledgeModuleId);
  }
}

export function setVendorPluginCallbacks(callbacks: VendorPluginCallbacks): void {
  warnDeprecated('setVendorPluginCallbacks');
  getDefault().setVendorPluginCallbacks(callbacks);
}

export function setKnowledgeRegistryForExtensions(registry: KnowledgeRegistry): void {
  warnDeprecated('setKnowledgeRegistryForExtensions');
  getDefault().setKnowledgeRegistry(registry);
}

export function applyPlatformExtension(ext: MossPlatformExtension): void {
  warnDeprecated('applyPlatformExtension');
  getDefault().apply(ext);
  bridgeDefaultExtensionKnowledge(ext);
}

export function applyPlatformExtensionForce(ext: MossPlatformExtension): void {
  warnDeprecated('applyPlatformExtensionForce');
  getDefault().applyForce(ext);
  bridgeDefaultExtensionKnowledge(ext);
}

export function resetPlatformExtensionRegistryForTests(): void {
  getDefault().reset();
}

export function listAppliedPlatformExtensionState(): ReadonlyMap<string, boolean> {
  return getDefault().listAppliedState();
}

export function setRegisteredPlatformExtensionsSnapshot(
  exts: readonly MossPlatformExtension[]
): void {
  getDefault().setExtensionsSnapshot(exts);
}

export function getRegisteredPlatformExtensions(): readonly MossPlatformExtension[] {
  return getDefault().getExtensions();
}

export function syncPlatformExtensionsAtStartup(
  factories: Array<() => MossPlatformExtension>
): void {
  warnDeprecated('syncPlatformExtensionsAtStartup');
  const instances: MossPlatformExtension[] = [];
  for (const factory of factories) {
    const ext = factory();
    instances.push(ext);
    getDefault().apply(ext);
    bridgeDefaultExtensionKnowledge(ext);
  }
  getDefault().setExtensionsSnapshot(instances);
}
