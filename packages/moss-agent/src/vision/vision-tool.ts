/**
 * Vision analysis tool — enables the agent to understand screenshots and images.
 *
 * This tool reads image files (PNG, JPEG, GIF, WebP, BMP) from the workspace,
 * from HTTP/HTTPS URLs, or as base64 data URLs, encodes them as base64 data
 * URLs, and returns structured content blocks that LLM providers with vision
 * support can process.
 *
 * @public
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContentBlock } from '../core/tools/tool-types.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { isPrivateHost } from '../tools/web-fetch.js';
import { errorMessage, MossError, ErrorCode, throwMoss } from '../errors.js';

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
const URL_FETCH_TIMEOUT_MS = 15_000;       // 15s for image URL downloads

export interface VisionAnalyzeInput {
  /** Path to image file relative to workspace root, HTTP/HTTPS URL, or "data:..." base64 data URL. */
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

function toolError(prefix: string, err: unknown): MossError {
  return new MossError({
    code: ErrorCode.TOOL_EXECUTION_FAILED,
    message: `${prefix}: ${errorMessage(err)}`,
    cause: err,
  });
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

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/** Detect MIME type from content-type header or URL extension. */
function mimeFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const imageMatch = contentType.match(/image\/(png|jpeg|gif|webp|bmp)/i);
  if (imageMatch) return `image/${imageMatch[1].toLowerCase()}`;
  return null;
}

/** Detect MIME from URL path extension. */
function mimeFromUrlPath(urlStr: string): string | null {
  try {
    const urlPath = new URL(urlStr).pathname;
    const ext = path.extname(urlPath).toLowerCase();
    return SUPPORTED_MIME_TYPES[ext] ?? null;
  } catch {
    return null;
  }
}

function parseDataUrl(input: string): { mimeType: string; data: string } | null {
  const match = input.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/** Fetch an image from an HTTP(S) URL and return base64 data + detected MIME type. */
async function fetchImageFromUrl(
  urlStr: string,
  abortSignal?: AbortSignal,
): Promise<{ base64Data: string; mimeType: string; sizeBytes: number }> {
  // Anti-SSRF: block private / loopback / link-local targets (cloud metadata
  // 169.254.169.254, localhost, 10.x / 192.168.x / 172.16-31.x, etc.) before
  // fetching. vision_analyze is LLM-callable, so without this a prompt could
  // drive it to fetch internal services and exfiltrate the response via the
  // image block. Mirrors web-fetch's default private-host blocking.
  let hostname: string;
  try {
    hostname = new URL(urlStr).hostname;
  } catch {
    throwMoss({ code: ErrorCode.TOOL_NOT_ALLOWED, message: `Invalid image URL: ${urlStr}` });
  }
  if (await isPrivateHost(hostname)) {
    throwMoss({
      code: ErrorCode.TOOL_NOT_ALLOWED,
      message: `Refusing to fetch image from private/loopback/link-local host "${hostname}" (anti-SSRF). Use a public image URL.`,
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  // Named handler so we can removeEventListener in `finally` — anonymous
  // arrow + `{ once: true }` was leaking a listener per fetch when the parent
  // signal was long-lived (session-scoped) and never aborted. Over a long
  // session the parent's listener list grew unbounded (Node's default warn
  // limit is 10, but the actual leak keeps the closure + AbortController alive
  // even after fetch success).
  const onParentAbort = (): void => controller.abort();
  if (abortSignal) {
    abortSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    const response = await fetch(urlStr, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 404) {
        throwMoss({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: `HTTP 404: Image URL not found. Verify URL: ${urlStr}` });
      }
      throwMoss({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: `HTTP ${response.status}: ${response.statusText}` });
    }
    const contentLength = response.headers.get('content-length');
    const sizeBytes = contentLength ? Number.parseInt(contentLength, 10) : 0;
    if (sizeBytes > MAX_IMAGE_BYTES) {
      throwMoss({ code: ErrorCode.TOOL_NOT_ALLOWED, message: `Image too large (${sizeBytes} bytes, max ${MAX_IMAGE_BYTES}). Try a smaller image or different URL.` });
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_IMAGE_BYTES) {
      throwMoss({ code: ErrorCode.TOOL_NOT_ALLOWED, message: `Image too large after download (${buffer.length} bytes, max ${MAX_IMAGE_BYTES}). Try a smaller image or different URL.` });
    }
    const mimeType =
      mimeFromContentType(response.headers.get('content-type')) ??
      mimeFromUrlPath(urlStr) ??
      'image/png';
    const base64Data = buffer.toString('base64');
    if (base64Data.length > MAX_BASE64_CHARS) {
      throwMoss({ code: ErrorCode.TOOL_NOT_ALLOWED, message: `Image data too large after encoding (${base64Data.length} chars, max ${MAX_BASE64_CHARS}). Try a smaller image or different URL.` });
    }
    return { base64Data, mimeType, sizeBytes: buffer.length };
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('abort') || err.name === 'AbortError') {
        throwMoss({ code: ErrorCode.TOOL_EXECUTION_TIMEOUT, message: `Timeout: failed to download image after ${URL_FETCH_TIMEOUT_MS}ms (network slow or URL unreachable). Check URL: ${urlStr}` });
      }
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (abortSignal) abortSignal.removeEventListener('abort', onParentAbort);
  }
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
      'Provide an image file path (relative to workspace), an HTTP/HTTPS URL, or a base64 data URL. ' +
      'Optionally ask a specific question about the image. ' +
      'Returns structured content with the image and prompt for the LLM to process visually. ' +
      'Supported formats: PNG, JPEG, GIF, WebP, BMP. URL images are downloaded automatically.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Workspace-relative path to image file (e.g., "screenshots/app.png", not absolute paths like /Users/me/image.png). All image paths must be within the workspace directory. Alternatively, use HTTP/HTTPS URL or base64 data URL (data:image/...;base64,...).',
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
          sizeBytes = Math.ceil((base64Data.length * 3) / 4);
          if (base64Data.length > MAX_BASE64_CHARS) {
            return `Error: base64 image data too large (${base64Data.length} chars, max ${MAX_BASE64_CHARS}). Resize or compress the image.`;
          }
        } else if (isHttpUrl(input.image)) {
          try {
            const fetched = await fetchImageFromUrl(input.image, ctx.abortSignal);
            mimeType = fetched.mimeType;
            base64Data = fetched.base64Data;
            sizeBytes = fetched.sizeBytes;
          } catch (err) {
            return `Error: failed to fetch image from URL: ${errorMessage(err)}`;
          }
        } else {
          let filePath: string;
          try {
            filePath = await safePath(input.image, ctx.workspaceDir);
          } catch (err) {
            return `Error: image file path must be within the workspace. Received: ${input.image}. Use a workspace-relative path, e.g., "images/screenshot.png", or provide an HTTP URL or data URL instead. Reason: ${errorMessage(err)}`;
          }
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
            return `Error: image file not found: ${input.image}. Verify the workspace-relative path exists and is readable.`;
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
          `[vision_analyze_ok]`,
          `📷 Image loaded and encoded (base64)`,
          `├─ Type: ${mimeType}`,
          `├─ Size: ${sizeBytes} bytes`,
          `├─ Detail level: ${detail}`,
          `└─ Question: ${question ? `"${question}"` : '(general description)'}`,
          ``,
          `Ready for vision processing with prompt:`,
          `${prompt}`,
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
        } else if (isHttpUrl(input.image)) {
          try {
            const fetched = await fetchImageFromUrl(input.image, ctx.abortSignal);
            mimeType = fetched.mimeType;
            base64Data = fetched.base64Data;
            sizeBytes = fetched.sizeBytes;
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error: failed to fetch image from URL: ${errorMessage(err)}` }], isError: true };
          }
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
          content: [{ type: 'text' as const, text: `Vision analysis error: ${errorMessage(err)}` }],
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
