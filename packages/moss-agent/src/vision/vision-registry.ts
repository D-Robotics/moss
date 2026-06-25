/**
 * Vision capability registry — manages vision-capable model providers and their configurations.
 *
 * Hosts register vision-capable models here so the vision tools can adapt
 * their output format to the specific provider's requirements.
 *
 * @public
 */
export interface VisionCapability {
  /** Provider identifier (e.g., 'anthropic', 'openai', 'google'). */
  provider: string;
  /** Maximum image size in bytes this provider accepts. */
  maxImageBytes: number;
  /** Supported image MIME types. */
  supportedMimeTypes: string[];
  /** Maximum resolution (longest edge in pixels). 0 = no limit. */
  maxResolution: number;
  /** Whether the provider supports multiple images per request. */
  supportsMultipleImages: boolean;
}

export interface VisionCapabilityProvider {
  /** Returns the vision capabilities for a given model ID. */
  getCapabilities(modelId: string): VisionCapability | null;
}

export interface VisionRegistryOptions {
  /** Pre-registered capability providers. */
  providers?: VisionCapabilityProvider[];
}

/**
 * Registry of vision-capable model providers.
 *
 * Hosts register their providers so vision tools can produce
 * provider-appropriate image formats.
 *
 * @public
 */
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

  /**
   * Register a capability provider.
   */
  registerProvider(provider: VisionCapabilityProvider): void {
    this.providers.push(provider);
  }

  /**
   * Register a default capability for a model ID.
   */
  registerDefault(modelId: string, capability: VisionCapability): void {
    this.defaults.set(modelId, capability);
  }

  /**
   * Get vision capabilities for a model, checking providers first then defaults.
   */
  getCapabilities(modelId: string): VisionCapability | null {
    for (const provider of this.providers) {
      const caps = provider.getCapabilities(modelId);
      if (caps) return caps;
    }
    return this.defaults.get(modelId) ?? null;
  }

  /**
   * Check if a model supports vision at all.
   */
  supportsVision(modelId: string): boolean {
    return this.getCapabilities(modelId) !== null;
  }

  /**
   * Get the maximum supported image size for a model.
   */
  getMaxImageBytes(modelId: string): number {
    return this.getCapabilities(modelId)?.maxImageBytes ?? 5 * 1024 * 1024; // 5 MB default
  }
}

/**
 * Built-in vision capability defaults for common providers.
 */
const BUILTIN_CAPABILITIES: Array<[string, VisionCapability]> = [
  ['claude-3', {
    provider: 'anthropic',
    maxImageBytes: 5 * 1024 * 1024,
    supportedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxResolution: 8000,
    supportsMultipleImages: true,
  }],
  ['gpt-4o', {
    provider: 'openai',
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxResolution: 8192,
    supportsMultipleImages: true,
  }],
  ['gpt-4-vision', {
    provider: 'openai',
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxResolution: 8192,
    supportsMultipleImages: true,
  }],
  ['gemini', {
    provider: 'google',
    maxImageBytes: 10 * 1024 * 1024,
    supportedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxResolution: 0,
    supportsMultipleImages: true,
  }],
];

/**
 * Create a VisionRegistry pre-populated with common provider defaults.
 *
 * @public
 */
export function createDefaultVisionRegistry(): VisionRegistry {
  const registry = new VisionRegistry();
  for (const [modelId, caps] of BUILTIN_CAPABILITIES) {
    registry.registerDefault(modelId, caps);
  }
  return registry;
}
