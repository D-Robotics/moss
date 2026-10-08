/**
 * Per-row projection cache for the fullscreen viewport (plan v3 P1).
 *
 * Every streamed token re-renders the frame, and the viewport projects the whole
 * transcript into visual lines. Transcript rows are immutable records (appending
 * creates a new object), so a row's projection only changes with its width, the
 * verbose/expanded state, or whether it is attached to the row above. Caching by
 * row identity turns a frame into a lookup for every settled row.
 */
import type { TuiLine } from './text.js';
import { renderTranscriptRow } from './transcript.js';
import type { TranscriptRow } from './render-bridge.js';

export interface ProjectionCache {
  /** `detail` is the row's expanded state (verbose or ctrl+o'd), as the app passes it. */
  render(
    row: TranscriptRow,
    width: number,
    detail: boolean,
    previous: TranscriptRow | undefined
  ): TuiLine[];
  readonly stats: { hits: number; misses: number };
  clear(): void;
}

function attachedTo(row: TranscriptRow, previous: TranscriptRow | undefined): boolean {
  return row.kind === 'result' && (previous?.kind === 'tool' || previous?.kind === 'result');
}

export function createProjectionCache(): ProjectionCache {
  let rows = new WeakMap<TranscriptRow, Map<string, TuiLine[]>>();
  const stats = { hits: 0, misses: 0 };
  return {
    stats,
    clear(): void {
      rows = new WeakMap();
      stats.hits = 0;
      stats.misses = 0;
    },
    render(row, width, detail, previous): TuiLine[] {
      const key = `${width}|${detail ? 1 : 0}|${attachedTo(row, previous) ? 1 : 0}`;
      let entries = rows.get(row);
      if (!entries) {
        entries = new Map();
        rows.set(row, entries);
      }
      const cached = entries.get(key);
      if (cached) {
        stats.hits += 1;
        return cached;
      }
      stats.misses += 1;
      const fresh = renderTranscriptRow(row, width, detail, previous);
      entries.set(key, fresh);
      return fresh;
    },
  };
}
