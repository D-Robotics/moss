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
