/**
 * B01: make `@<image>` references self-explanatory to the model.
 *
 * Pasting an image into the TUI stages it under `.moss/runtime/attachments` and
 * inserts `@<relpath>` into the composer (clipboard-attachment.ts). That mention
 * is plain text: nothing told the model it points at an image or that it should
 * open it, so a pasted screenshot could sit in the transcript while the model
 * answered from memory. Cursor and Claude Code attach the image content to the
 * message; Moss has no multimodal attachment path, so the equivalent is to make
 * the reference explicit and point at `read_image` in the same turn.
 *
 * Only image files that actually exist inside the workspace are reported: an
 * unknown `@path` stays ordinary text, and a missing file never turns into a
 * phantom attachment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectImageMimeType } from '../tools/read-image-tool.js';

/** Formats `read_image` can attach (see tools/read-image-tool.ts). */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/** Same ceiling as `read_image`; a bigger file could not be opened anyway. */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const MENTION_PATTERN = new RegExp(
  String.raw`@([A-Za-z0-9._/\-]+(?:` +
    IMAGE_EXTENSIONS.map((ext) => ext.replace('.', String.raw`\.`)).join('|') +
    '))',
  'giu'
);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ImageMentionContextOptions {
  /** The user's message as typed (already includes any `@path` mention). */
  message: string;
  workspaceDir: string | undefined;
}

/**
 * Context block naming the image files the message references, or undefined when
 * it references none. Paths are workspace-relative with `/` separators so they
 * match what the model must pass back to `read_image`.
 */
export function formatImageMentionContext(options: ImageMentionContextOptions): string | undefined {
  const { message, workspaceDir } = options;
  if (!workspaceDir || !message.includes('@')) return undefined;
  const seen = new Set<string>();
  const found: { relPath: string; bytes: number; tooLarge: boolean }[] = [];
  for (const match of message.matchAll(MENTION_PATTERN)) {
    const relPath = match[1]?.replace(/^\.\//, '').replace(/\\/g, '/');
    if (!relPath || seen.has(relPath)) continue;
    seen.add(relPath);
    const absolute = path.resolve(workspaceDir, relPath);
    const relative = path.relative(workspaceDir, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    found.push({ relPath, bytes: stat.size, tooLarge: stat.size > MAX_ATTACHMENT_BYTES });
  }
  if (found.length === 0) return undefined;
  const lines = found.map((item) => {
    const size = formatSize(item.bytes);
    return item.tooLarge
      ? `- ${item.relPath} (${size} — above the 3 MB read_image limit; downscale or crop it first)`
      : `- ${item.relPath} (${size})`;
  });
  return [
    '<attachments>',
    "The user's message references these image files in the workspace:",
    ...lines,
    'Open each one with read_image before answering: the reference is a path, not the image content itself.',
    'Paths are relative to the workspace root.',
    '</attachments>',
  ].join('\n');
}

/** One image ready to attach to the provider request (base64, as ChatOptions wants). */
export interface ImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
  filename: string;
}

export interface LoadedImageMentions {
  /** Ready-to-send image blocks; empty when no mention is attachable. */
  attachments: ImageAttachment[];
  /** Context block to inject for this turn. */
  context: string | undefined;
}

/**
 * B01 closing slice: attach the referenced images to the request instead of only
 * describing them. `ChatOptions.attachments` already carries image blocks into
 * the user message, so a pasted screenshot becomes visible on the first turn --
 * the same end state as Cursor/Claude Code -- with no extra tool round.
 *
 * Falls back to the read_image instruction when nothing can be attached: the
 * model is text-only (`supportsImages === false`), the file is not a real image
 * (magic bytes), or it is larger than read_image accepts.
 */
export function loadImageMentions(options: {
  message: string;
  workspaceDir: string | undefined;
  supportsImages: boolean;
}): LoadedImageMentions {
  const described = formatImageMentionContext({
    message: options.message,
    workspaceDir: options.workspaceDir,
  });
  if (!described || !options.workspaceDir) return { attachments: [], context: described };
  if (!options.supportsImages) return { attachments: [], context: described };
  const workspaceDir = options.workspaceDir;
  const attachments: ImageAttachment[] = [];
  for (const match of described.matchAll(/^- (\S+) \((\d+(?:\.\d+)? [KMG]?B)\)$/gmu)) {
    const relPath = match[1];
    if (!relPath) continue;
    const absolute = path.resolve(workspaceDir, relPath);
    try {
      const bytes = fs.readFileSync(absolute);
      if (bytes.length > MAX_ATTACHMENT_BYTES) continue;
      const detected = detectImageMimeType(bytes);
      if (!detected) continue;
      attachments.push({
        type: 'image',
        data: bytes.toString('base64'),
        mimeType: detected.mimeType,
        filename: relPath,
      });
    } catch {
      continue;
    }
  }
  if (attachments.length === 0) return { attachments, context: described };
  const lines = attachments.map((item) => `- ${item.filename} (${item.mimeType})`);
  return {
    attachments,
    context: [
      '<attachments>',
      "The user's message includes these images, attached below as image content:",
      ...lines,
      'Look at them directly. Their paths are workspace-relative if you need to re-read the file.',
      '</attachments>',
    ].join('\n'),
  };
}
