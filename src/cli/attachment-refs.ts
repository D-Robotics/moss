import type { PreparedPromptAttachment, PromptAttachmentBlock } from './attachments.js';
import type { AttachmentRef } from './transcript-types.js';

export function extractAttachmentRefs(text: string): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  const re = /\[((?:Image|File) #(\d+))\]/g;
  for (const match of text.matchAll(re)) {
    const label = match[1] || '';
    if (seen.has(label)) continue;
    seen.add(label);
    refs.push({
      index: Number(match[2]),
      kind: label.startsWith('Image') ? 'image' : 'file',
      label,
    });
  }
  return refs;
}

export function attachmentRefIndexes(text: string): Set<number> {
  return new Set(extractAttachmentRefs(text).map((ref) => ref.index));
}

export function removeAttachmentRefsFromInput(value: string): string {
  return value
    .replace(/\s*\[(?:Image|File)(?: #\d*)?\]?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}

export function inputWithAttachmentRefs(
  value: string,
  attachments: PreparedPromptAttachment[]
): string {
  const refs = attachments
    .map((item) => `[${item.kind === 'image' ? 'Image' : 'File'} #${item.index}]`)
    .join(' ');
  if (!refs) return value;
  const trimmed = value.trimEnd();
  return `${trimmed ? `${trimmed} ` : ''}${refs} `;
}

export function blockCountForAttachment(item: PreparedPromptAttachment): number {
  return item.kind === 'image' ? 2 : 1;
}

export function selectReferencedPromptAttachments(
  text: string,
  attachments: PreparedPromptAttachment[],
  blocks: PromptAttachmentBlock[]
): { attachments: PreparedPromptAttachment[]; blocks: PromptAttachmentBlock[] } {
  const keep = attachmentRefIndexes(text);
  if (keep.size === 0) return { attachments: [], blocks: [] };
  const nextAttachments: PreparedPromptAttachment[] = [];
  const nextBlocks: PromptAttachmentBlock[] = [];
  let blockOffset = 0;
  for (const item of attachments) {
    const blockCount = blockCountForAttachment(item);
    const itemBlocks = blocks.slice(blockOffset, blockOffset + blockCount);
    blockOffset += blockCount;
    if (!keep.has(item.index)) continue;
    nextAttachments.push(item);
    nextBlocks.push(...itemBlocks);
  }
  return { attachments: nextAttachments, blocks: nextBlocks };
}

export function formatAttachmentChip(ref: AttachmentRef): string {
  return `[${ref.label}] ${ref.kind}`;
}
