export {
  PlatformExtensionRegistry,
  getDefaultExtensionsRegistry,
  createAgentExtensionRegistryFromDefaults,
  resetExtensionsWireCountForTests,
  applyPlatformExtension,
  applyPlatformExtensionForce,
  syncPlatformExtensionsAtStartup,
  setVendorPluginCallbacks,
  setKnowledgeRegistryForExtensions,
  getRegisteredPlatformExtensions,
  setRegisteredPlatformExtensionsSnapshot,
  resetPlatformExtensionRegistryForTests,
  listAppliedPlatformExtensionState,
} from './registry.js';
export type { VendorPluginCallbacks } from './registry.js';

export type { MossPlatformExtension, MossPlatformExtensionIdentities } from '@rdk-moss/core';
