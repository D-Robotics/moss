import type { TuiStore, TranscriptRow } from './render-bridge.js';
import { visibleRows } from './render-bridge.js';

export interface TranscriptViewOptions {
  height?: number;
}

/** Pure projection of the visible transcript lines (for specs + rendering). */
export function transcriptLines(
  store: TuiStore,
  scrollOffset: number,
  options: TranscriptViewOptions = {}
): string[] {
  const height = options.height ?? 10;
  const rows: TranscriptRow[] = visibleRows(store, height, scrollOffset);
  const lines: string[] = [];
  for (const row of rows) {
    const prefix =
      row.kind === 'user' ? '› ' : row.kind === 'system' ? '  ' : row.kind === 'error' ? '! ' : '';
    for (const line of row.text.split('\n')) {
      lines.push(`${prefix}${line}`);
    }
  }
  return lines;
}
