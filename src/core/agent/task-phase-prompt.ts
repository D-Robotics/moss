/**
 * Task/goal phase prompts belong to `moss task` and `/goal`, not to a plain
 * question. A block starts at a `[task-phase:` line and runs until the next
 * markdown heading (another dynamic layer) or the end of the text.
 */
export function omitTaskPhasePrompts(text: string): string {
  if (!text.includes('[task-phase:')) return text;
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (/^\[task-phase:/.test(line.trim())) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^#{1,3} /.test(line)) {
        skipping = false;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
