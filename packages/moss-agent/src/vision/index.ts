/**
 * Vision module — general-purpose visual understanding for the Moss agent.
 *
 * Provides tools for analyzing screenshots, images, and visual content
 * through LLM vision capabilities. Supports local image files and
 * base64-encoded image data.
 *
 * @module vision
 * @public
 */
export {
  createVisionAnalyzeTool,
  visionAnalyzeTool,
  type VisionAnalyzeInput,
  type VisionAnalyzeResult,
  type VisionToolOptions,
} from './vision-tool.js';

export {
  VisionRegistry,
  createDefaultVisionRegistry,
  type VisionCapability,
  type VisionCapabilityProvider,
  type VisionRegistryOptions,
} from './vision-registry.js';

export {
  buildVisionSystemPrompt,
  type VisionPromptOptions,
} from './vision-prompt.js';
