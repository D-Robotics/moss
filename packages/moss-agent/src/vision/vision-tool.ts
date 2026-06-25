/**
 * Vision analysis tool — enables the agent to understand screenshots and images.
 *
 * This tool reads image files (PNG, JPEG, GIF, WebP) from the workspace,
 * encodes them as base64 data URLs, and returns structured content blocks
 * that LLM providers with vision support can process.
 *
 * @public
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContentBlock } from '../core/tools/tool-types.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';

const SUPPORTED_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_BASE64_CHARS = 10_000_000;       // ~7.5 MB encoded

export interface VisionAnalyzeInput {
  /** Path to image file relative to workspace root, or "data:..." base64 data URL. */
  image: string;
  /** Optional natural-language question about the image. Defaults to a generic description request. */
  question?: string;
  /** Optional detail level: 'low' (fast, lower res), 'high' (detailed), 'auto' (default). */
  detail?: 'low' | 'high' | 'auto';
}

export interface VisionAnalyzeResult {
  /** The image as a data URL ready for LLM consumption. */
  imageUrl: string;
  /** Detected MIME type. */
  mimeType: string;
  /** The prompt text that should accompany the image in a vision-capable LLM call. */
  prompt: string;
  /** Image dimensions if detectable (bytes-based approximation). */
  sizeBytes: number;
}

export interface VisionToolOptions {
  /** Maximum image size in bytes (default 20 MB). */
  maxImageBytes?: number;
  /** Default detail level (default 'auto'). */
  defaultDetail?: 'low' | 'high' | 'auto';
}

function toolError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
}

async function safePath(inputPath: string, workspaceDir: string): Promise<string> {
  const { resolved } = await assertSandboxPath({
    filePath: inputPath,
    cwd: workspaceDir,
    root: workspaceDir,
  });
  return resolved;
}

function detectMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_MIME_TYPES[ext] ?? null;
}

function isDataUrl(input: string): boolean {
  return /^data:image\/[a-z+.-]+;base64,/i.test(input);
}

function parseDataUrl(input: string): { mimeType: string; data: string } | null {
  const match = input.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function buildPrompt(question?: string): string {
  if (question) {
    return `Please analyze this image and answer the following question:\n\n${question}\n\nProvide a detailed, accurate response based on what you see in the image.`;
  }
  return 'Please describe this image in detail. What do you see? Include all relevant objects, text, UI elements, colors, layout, and any notable details.';
}

/**
 * Create a vision analysis tool with custom options.
 *
 * @public
 */
export function createVisionAnalyzeTool(options: VisionToolOptions = {}): Tool<VisionAnalyzeInput> {
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  const defaultDetail = options.defaultDetail ?? 'auto';

  return {
    name: 'vision_analyze',
    description:
      'Analyze an image or screenshot using vision capabilities. ' +
      'Provide an image file path (relative to workspace) or a base64 data URL. ' +
      'Optionally ask a specific question about the image. ' +
      'Returns structured content with the image and prompt for the LLM to process visually. ' +
      'Supported formats: PNG, JPEG, GIF, WebP, BMP.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Path to an image file in the workspace (e.g., "screenshot.png") or a "data:image/...;base64,..." data URL.',
        },
        question: {
          type: 'string',
          description: 'Optional question about the image. If omitted, a general description is requested.',
        },
        detail: {
          type: 'string',
          enum: ['low', 'high', 'auto'],
          description: 'Detail level: "low" for fast analysis, "high" for detailed, "auto" for automatic (default).',
        },
      },
      required: ['image'],
    },
    async execute(input, ctx) {
      try {
        const detail = (input.detail ?? defaultDetail) as 'low' | 'high' | 'auto';
        const question = typeof input.question === 'string' ? input.question.trim() : undefined;

        let mimeType: string;
        let base64Data: string;
        let sizeBytes: number;

        if (isDataUrl(input.image)) {
          const parsed = parseDataUrl(input.image);
          if (!parsed) {
            return 'Error: invalid data URL format. Expected "data:image/<type>;base64,..."';
          }
          mimeType = parsed.mimeType;
          base64Data = parsed.data;
          sizeBytes = Math.ceil((base64Data.length * 3) / 4); // approximate decoded size
          if (base64Data.length > MAX_BASE64_CHARS) {
            return `Error: base64 image data too large (${base64Data.length} chars, max ${MAX_BASE64_CHARS}). Resize or compress the image.`;
          }
        } else {
          const filePath = await safePath(input.image, ctx.workspaceDir);
          const detectedMime = detectMimeType(filePath);
          if (!detectedMime) {
            const ext = path.extname(filePath).toLowerCase();
            return `Error: unsupported image format "${ext}". Supported: ${Object.keys(SUPPORTED_MIME_TYPES).join(', ')}`;
          }
          mimeType = detectedMime;

          let stat;
          try {
            stat = await fs.stat(filePath);
          } catch {
            return `Error: image file not found: ${input.image}`;
          }
          if (stat.size > maxImageBytes) {
            return `Error: image file too large (${stat.size} bytes, max ${maxImageBytes}). Resize or compress the image.`;
          }
          sizeBytes = stat.size;

          const buffer = await fs.readFile(filePath);
          base64Data = buffer.toString('base64');
        }

        const prompt = buildPrompt(question);

        const textLines = [
          `[vision_analyze: ready for visual processing]`,
          `MIME type: ${mimeType}`,
          `Size: ${sizeBytes} bytes`,
          `Detail: ${detail}`,
          `Question: ${question || '(general description)'}`,
          ``,
          `The image has been encoded as a data URL. Use your vision capabilities to analyze it.`,
          `Prompt: ${prompt}`,
        ];

        return textLines.join('\n');
      } catch (err) {
        throw toolError('Vision analysis failed', err);
      }
    },
    async executeStructured(input, ctx) {
      try {
        const detail = (input.detail ?? defaultDetail) as 'low' | 'high' | 'auto';
        const question = typeof input.question === 'string' ? input.question.trim() : undefined;

        let mimeType: string;
        let base64Data: string;
        let sizeBytes: number;

        if (isDataUrl(input.image)) {
          const parsed = parseDataUrl(input.image);
          if (!parsed) {
            return { content: [{ type: 'text' as const, text: 'Error: invalid data URL format.' }], isError: true };
          }
          mimeType = parsed.mimeType;
          base64Data = parsed.data;
          sizeBytes = Math.ceil((base64Data.length * 3) / 4);
        } else {
          const filePath = await safePath(input.image, ctx.workspaceDir);
          const detectedMime = detectMimeType(filePath);
          if (!detectedMime) {
            return { content: [{ type: 'text' as const, text: `Error: unsupported image format.` }], isError: true };
          }
          mimeType = detectedMime;
          let stat;
          try {
            stat = await fs.stat(filePath);
          } catch {
            return { content: [{ type: 'text' as const, text: `Error: image file not found.` }], isError: true };
          }
          sizeBytes = stat.size;
          const buffer = await fs.readFile(filePath);
          base64Data = buffer.toString('base64');
        }

        const prompt = buildPrompt(question);

        const content: ToolContentBlock[] = [
          {
            type: 'image',
            data: base64Data,
            mimeType,
            alt: question || 'Image for analysis',
          },
          {
            type: 'text',
            text: `[vision_analyze] ${prompt}\nDetail: ${detail}\nSize: ${sizeBytes} bytes`,
          },
        ];

        return { content };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Vision analysis error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * Default vision analysis tool instance.
 *
 * @public
 */
export const visionAnalyzeTool: Tool<VisionAnalyzeInput> = createVisionAnalyzeTool();
