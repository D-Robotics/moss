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

export function formatAttachmentChip(ref: AttachmentRef): string {
  return `[${ref.label}] ${ref.kind}`;
}
