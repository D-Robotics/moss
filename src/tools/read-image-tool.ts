import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, StructuredToolResult } from '../core/tools/tool-types.js';
import type { ToolContentBlock } from '../contracts/messages.js';
import { resolveReadPath } from '../safety/read-scope.js';
import { providerRejectsImageInput } from '../provider/image-capability.js';

/**
 * Largest image `read_image` attaches to the conversation. The bytes travel as
 * base64 in the transcript (~1.37× on disk), so this is a real storage budget,
 * not a rendering limit: 3 MB keeps one attached screenshot well under the
 * point where a session file or a single request becomes unwieldy.
 */
export const READ_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** Extensions we can name in a fix-it hint when magic bytes do not match. */
const KNOWN_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

type DetectedImage = { mimeType: string; extension: string };

/**
 * Magic-byte detection, not extension: a `.png` that is really a JPEG is the
 * common case (screenshot tools mislabel), and a text file renamed `.png` must
 * not be sent to a model as an image.
 */
export function detectImageMimeType(bytes: Uint8Array): DetectedImage | null {
  const at = (offset: number): number => bytes[offset] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (
    at(0) === 0x47 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x38 &&
    (at(4) === 0x39 || at(4) === 0x37)
  ) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  // RIFF....WEBP
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  return null;
}

type PreparedImage =
  | { ok: true; text: string; block: ToolContentBlock }
  | { ok: false; text: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function prepareImageInput(
  input: { path?: unknown; alt?: unknown },
  ctx: Pick<ToolContext, 'workspaceDir' | 'supportsImages'>
): Promise<PreparedImage> {
  const shown = String(input.path ?? '').trim();
  if (!shown) return { ok: false, text: 'Error: read_image needs a path.' };
  if (ctx.supportsImages === false || providerRejectsImageInput()) {
    if (providerRejectsImageInput() && ctx.supportsImages !== false) {
      return {
        ok: false,
        text:
          `Error: ${shown} was not attached — this session's endpoint already rejected image input ` +
          '(`invalid_image_url`/unsupported image content) on an earlier turn, so retrying would fail the ' +
          'same way. Describe the file in text instead (read_file for text, exec with `file`/`xxd` for ' +
          'bytes). If the gateway does support images, set agent.supportsImages true and start a new ' +
          'session, or run `moss config set agent.supportsImages false` to make this the default.',
      };
    }
    return {
      ok: false,
      text:
        `Error: ${shown} was not attached — the configured model declares no image input ` +
        '(agent.supportsImages=false), so an image block would be dropped or rejected by the provider. ' +
        'Describe the file in text instead (read_file for text, exec with `file`/`xxd` for bytes), ' +
        'or switch to a vision-capable model and set agent.supportsImages back to true.',
    };
  }
  const filePath = resolveReadPath(shown, ctx.workspaceDir);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return {
      ok: false,
      text: `Error: ${shown} does not exist. Use list_directory to find the image file.`,
    };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      text: `Error: ${shown} is a directory, not an image. Use list_directory to see what is in it.`,
    };
  }
  if (stat.size > READ_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      text:
        `Error: ${shown} is ${formatBytes(stat.size)} — larger than read_image attaches ` +
        `(${formatBytes(READ_IMAGE_MAX_BYTES)}). Downscale or crop it first, then read the smaller file.`,
    };
  }
  const bytes = await fs.readFile(filePath);
  const detected = detectImageMimeType(bytes);
  if (!detected) {
    const extension = path.extname(filePath).toLowerCase();
    const hint = KNOWN_EXTENSIONS.has(extension)
      ? `the ${extension} extension does not match its bytes — the file is not a PNG/JPEG/GIF/WebP image`
      : 'read_image accepts PNG, JPEG, GIF and WebP';
    return {
      ok: false,
      text:
        `Error: ${shown} is not a supported image (${hint}). ` +
        'Use read_file for text, or exec (file, xxd) to inspect unknown bytes.',
    };
  }
  const alt = typeof input.alt === 'string' && input.alt.trim() ? input.alt.trim() : shown;
  const text =
    `[image] ${shown} (${detected.mimeType}, ${formatBytes(stat.size)}) — attached to the conversation. ` +
    'Describe what is actually visible instead of inferring from the file name.';
  return {
    ok: true,
    text,
    block: {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: detected.mimeType,
      alt,
    },
  };
}

export const readImageTool: Tool = {
  name: 'read_image',
  description:
    'Attach a local image (PNG/JPEG/GIF/WebP, up to 3 MB) to the conversation so you can see it. ' +
    'Use this for screenshots, photos, diagrams and rendered UI instead of read_file — read_file returns text and ' +
    'reports binary files as errors. Not for text, source code or SVG you want as text (read_file). ' +
    'The tool returns a short description line plus the image itself; ' +
    'answer from what you see, and say when something is not visible instead of guessing.',
  metadata: {
    leanDescription:
      'Attach a local image (PNG/JPEG/GIF/WebP, up to 3 MB) so you can see it: screenshots, photos, diagrams, rendered UI. Use instead of read_file for images. Not for text, source or SVG (read_file). Say when something is not visible instead of guessing.',
    classification: { singleCallExempt: true, discovery: true },
    maxResultTokens: 600,
    truncationHint: 'the image is attached separately — do not re-read it as text',
    sideEffectClass: 'readonly',
    planMode: 'allow',
    // Content is a real observation every time (the file may have changed).
    noReplay: true,
    freshObservation: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Image path relative to the workspace root (absolute paths outside the workspace also work)',
      },
      alt: {
        type: 'string',
        description: 'Optional short description of what the image is meant to show',
      },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    const prepared = await prepareImageInput(input, ctx);
    return prepared.text;
  },
  async executeStructured(input, ctx): Promise<StructuredToolResult> {
    const prepared = await prepareImageInput(input, ctx);
    if (!prepared.ok) return { content: [{ type: 'text', text: prepared.text }], isError: true };
    return { content: [{ type: 'text', text: prepared.text }, prepared.block] };
  },
};
