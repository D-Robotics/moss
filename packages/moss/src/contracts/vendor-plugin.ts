















export interface MossPromptContributor {
  readonly id: string;
  
  buildStableLayers?(): string[];
  
  buildDynamicLayers?(): string[];
}







export interface MossToolContributor<THostTool = unknown> {
  readonly id: string;
  



  createTools(deviceId: string | undefined): THostTool[];
}










export interface MossVendorPlugin<THostTool = unknown> {
  readonly id: string;
  readonly displayName: string;
  
  promptContributors?: MossPromptContributor[];
  
  toolContributors?: MossToolContributor<THostTool>[];
}
