












import type { DeviceFamily } from './device-family.js';
import type { KnowledgeModule } from './knowledge-module.js';
import type { MossVendorPlugin, MossToolContributor } from './vendor-plugin.js';





export interface MossPlatformExtensionIdentities {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  
  readonly knowledgeModuleId: string;
  
  readonly vendorPluginId: string;
  












  readonly family?: DeviceFamily;
}






export interface MossPlatformExtension<
  THostTool = unknown,
> extends MossPlatformExtensionIdentities {
  
  isEnabled(): boolean;

  
  getKnowledgeModule(): KnowledgeModule;

  
  getVendorPlugin(): MossVendorPlugin<THostTool>;

  
  getExtraDeviceToolContributors?(): MossToolContributor<THostTool>[];
}
