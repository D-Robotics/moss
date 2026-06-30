/** Contributed stable/dynamic prompt layers from a vendor plugin. @public */
export interface MossPromptContributor {
  readonly id: string;
  
  buildStableLayers?(): string[];
  
  buildDynamicLayers?(): string[];
}







/** Contributed tools from a vendor plugin, parameterized by host tool type. @public */
export interface MossToolContributor<THostTool = unknown> {
  readonly id: string;
  



  createTools(deviceId: string | undefined): THostTool[];
}










/** A vendor plugin: prompt contributors, tool contributors, id, and display name. @public */
export interface MossVendorPlugin<THostTool = unknown> {
  readonly id: string;
  readonly displayName: string;
  
  promptContributors?: MossPromptContributor[];
  
  toolContributors?: MossToolContributor<THostTool>[];
}
