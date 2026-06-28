







export interface VisionCapability {
  
  provider: string;
  
  maxImageBytes: number;
  
  supportedMimeTypes: string[];
  
  maxResolution: number;
  
  supportsMultipleImages: boolean;
}

export interface VisionCapabilityProvider {
  
  getCapabilities(modelId: string): VisionCapability | null;
}

export interface VisionRegistryOptions {
  
  providers?: VisionCapabilityProvider[];
}









export class VisionRegistry {
  private providers: VisionCapabilityProvider[] = [];
  private defaults: Map<string, VisionCapability> = new Map();

  constructor(options: VisionRegistryOptions = {}) {
    if (options.providers) {
      for (const p of options.providers) {
        this.registerProvider(p);
      }
    }
  }

  


  registerProvider(provider: VisionCapabilityProvider): void {
    this.providers.push(provider);
  }

  


  registerDefault(modelId: string, capability: VisionCapability): void {
    this.defaults.set(modelId, capability);
  }

  


  getCapabilities(modelId: string): VisionCapability | null {
    for (const provider of this.providers) {
      const caps = provider.getCapabilities(modelId);
      if (caps) return caps;
    }
    return this.defaults.get(modelId) ?? null;
  }

  


  supportsVision(modelId: string): boolean {
    return this.getCapabilities(modelId) !== null;
  }

  


  getMaxImageBytes(modelId: string): number {
    return this.getCapabilities(modelId)?.maxImageBytes ?? 5 * 1024 * 1024; 
  }
}




const BUILTIN_CAPABILITIES: Array<[string, VisionCapability]> = [
  [
    'claude-3',
    {
      provider: 'anthropic',
      maxImageBytes: 5 * 1024 * 1024,
      supportedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      maxResolution: 8000,
      supportsMultipleImages: true,
    },
  ],
  [
    'gpt-4o',
    {
      provider: 'openai',
      maxImageBytes: 20 * 1024 * 1024,
      supportedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      maxResolution: 8192,
      supportsMultipleImages: true,
    },
  ],
  [
    'gpt-4-vision',
    {
      provider: 'openai',
      maxImageBytes: 20 * 1024 * 1024,
      supportedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      maxResolution: 8192,
      supportsMultipleImages: true,
    },
  ],
  [
    'gemini',
    {
      provider: 'google',
      maxImageBytes: 10 * 1024 * 1024,
      supportedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxResolution: 0,
      supportsMultipleImages: true,
    },
  ],
];






export function createDefaultVisionRegistry(): VisionRegistry {
  const registry = new VisionRegistry();
  for (const [modelId, caps] of BUILTIN_CAPABILITIES) {
    registry.registerDefault(modelId, caps);
  }
  return registry;
}
