/**
 * Application viewport over an already-projected transcript.
 *
 * Two anchors keep the reader's place:
 *
 *   - `anchor` (preferred): the visual line that was at the top of the window,
 *     identified by `(rowId, lineIndex)`. Re-projection (a row folding, a width
 *     change, a streaming answer committing into a row) does not move it, so the
 *     window stays on the same text.
 *   - `offsetFromBottom` + `total` (fallback): used when the anchor line is no
 *     longer in the projection. Lines appended since the offset was set still do
 *     not drag the window along.
 *
 * `pinned` follows the bottom. Scrolling up unpins; typing does not change the
 * offset.
 */

import type { TuiLine } from './text.js';

export interface ViewportLine {
  rowId: number;
  /** Offset of this visual line within its source row. */
  lineIndex: number;
  text: string;
  /** The styled projection of this line (colour, bold, inline runs). */
  line?: TuiLine;
}

export interface ViewportAnchor {
  rowId: number;
  lineIndex: number;
}

export interface ViewportState {
  /** How many visual lines above the bottom the window starts. 0 = pinned. */
  offsetFromBottom: number;
  pinned: boolean;
  /** Line count when `offsetFromBottom` was last set (fallback compensation). */
  total?: number;
  /** Top visual line of the window while unpinned (preferred over the offset). */
  anchor?: ViewportAnchor;
}

/** Offset from the bottom after accounting for lines appended since it was set. */
export function effectiveOffset(state: ViewportState, total: number): number {
  if (state.pinned || state.offsetFromBottom <= 0) return 0;
  const grown = state.total === undefined ? 0 : Math.max(0, total - state.total);
  return state.offsetFromBottom + grown;
}

export function createViewport(): ViewportState {
  return { offsetFromBottom: 0, pinned: true };
}

export interface ViewportWindow {
  lines: ViewportLine[];
  start: number;
  pinned: boolean;
  /** Lines that exist below the window (unread while unpinned). */
  unread: number;
}

function anchorIndex(lines: readonly ViewportLine[], anchor: ViewportAnchor): number {
  return lines.findIndex(
    (line) => line.rowId === anchor.rowId && line.lineIndex === anchor.lineIndex
  );
}

export function viewportWindow(
  lines: readonly ViewportLine[],
  state: ViewportState,
  viewportRows: number
): ViewportWindow {
  const height = Math.max(1, viewportRows);
  const total = lines.length;
  if (state.pinned || (state.offsetFromBottom <= 0 && !state.anchor)) {
    const start = Math.max(0, total - height);
    return {
      lines: lines.slice(start),
      start,
      pinned: true,
      unread: 0,
    };
  }
  const maxOffset = Math.max(0, total - height);
  if (state.anchor) {
    const index = anchorIndex(lines, state.anchor);
    if (index >= 0) {
      const start = Math.min(index, maxOffset);
      const end = Math.min(total, start + height);
      return { lines: lines.slice(start, end), start, pinned: false, unread: total - end };
    }
  }
  const offset = Math.min(effectiveOffset(state, total), maxOffset);
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - height);
  return {
    lines: lines.slice(start, end),
    start,
    pinned: false,
    unread: offset,
  };
}

/** Accepts a line count (no anchor) or the projected lines (anchor is recorded). */
export type ProjectedLines = number | readonly ViewportLine[];

function countOf(lines: ProjectedLines): number {
  return typeof lines === 'number' ? lines : lines.length;
}

export function scrollViewport(
  state: ViewportState,
  lines: ProjectedLines,
  delta: number,
  viewportRows: number
): ViewportState {
  const height = Math.max(1, viewportRows);
  const total = countOf(lines);
  const maxOffset = Math.max(0, total - height);
  if (delta >= 0 && state.pinned) return state;
  const current =
    typeof lines === 'number'
      ? effectiveOffset(state, total)
      : viewportWindow(lines, state, height).unread;
  const next = Math.max(0, Math.min(maxOffset, current - delta));
  if (next === 0) return { offsetFromBottom: 0, pinned: true, total };
  const moved: ViewportState = { offsetFromBottom: next, pinned: false, total };
  if (typeof lines === 'number') return moved;
  const top = lines[viewportWindow(lines, moved, height).start];
  return top ? { ...moved, anchor: { rowId: top.rowId, lineIndex: top.lineIndex } } : moved;
}

export function pinViewport(): ViewportState {
  return { offsetFromBottom: 0, pinned: true };
}

/**
 * Up/Down on an empty composer. Scroll when the transcript actually moves;
 * otherwise the key still recalls prompt history (the top of the transcript,
 * a short transcript, or Down while already pinned to the bottom).
 */
export function moveTranscript(
  state: ViewportState,
  lines: ProjectedLines,
  viewportRows: number,
  direction: 'up' | 'down'
): { action: 'scroll'; state: ViewportState } | { action: 'recall' } {
  const next = scrollViewport(state, lines, direction === 'up' ? -1 : 1, viewportRows);
  const total = countOf(lines);
  const currentOffset = state.pinned ? 0 : effectiveOffset(state, total);
  if (next.offsetFromBottom === currentOffset && next.pinned === state.pinned) {
    return { action: 'recall' };
  }
  return { action: 'scroll', state: next };
}

/**
 * Scrollbar pointer: `y` is the row inside the viewport (0 = top). Places the
 * window so the thumb is under the pointer. The scroll bar is a projection of
 * the same offset, so the result is always a valid state.
 */
export function viewportAtRatio(
  lines: readonly ViewportLine[],
  viewportRows: number,
  y: number
): ViewportState {
  const height = Math.max(1, viewportRows);
  const total = lines.length;
  const maxOffset = Math.max(0, total - height);
  if (maxOffset === 0) return pinViewport();
  const ratio = Math.min(1, Math.max(0, y / Math.max(1, height - 1)));
  const start = Math.round(ratio * maxOffset);
  const offset = total - Math.min(total, start + height);
  if (offset <= 0) return pinViewport();
  const state: ViewportState = { offsetFromBottom: offset, pinned: false, total };
  const top = lines[start];
  return top ? { ...state, anchor: { rowId: top.rowId, lineIndex: top.lineIndex } } : state;
}

/**
 * Thumb geometry for a track `track` rows tall (default: the viewport), with the
 * thumb size proportional to the visible share of the transcript. `null` = no bar.
 */
export function scrollThumb(
  total: number,
  viewportRows: number,
  start: number,
  track = viewportRows
): { top: number; size: number } | null {
  const height = Math.max(1, viewportRows);
  if (total <= height) return null;
  const rail = Math.max(1, track);
  const size = Math.min(rail, Math.max(1, Math.round((height * rail) / total)));
  const travel = rail - size;
  const maxStart = total - height;
  const top = maxStart === 0 ? 0 : Math.round((Math.min(start, maxStart) / maxStart) * travel);
  return { top, size };
}

/**
 * After a width change, keep the visual line that was at the top of the
 * window on screen. `previousTop` is that line's identity.
 */
export function rebaseViewport(
  lines: readonly ViewportLine[],
  previousTop: { rowId: number; lineIndex: number } | undefined,
  viewportRows: number,
  wasPinned: boolean
): ViewportState {
  if (wasPinned || !previousTop) return pinViewport();
  const height = Math.max(1, viewportRows);
  const index = anchorIndex(lines, previousTop);
  if (index < 0) return pinViewport();
  const bottom = Math.min(lines.length, index + height);
  const offset = Math.max(0, lines.length - bottom);
  if (offset === 0) return pinViewport();
  return {
    offsetFromBottom: offset,
    pinned: false,
    total: lines.length,
    anchor: { rowId: previousTop.rowId, lineIndex: previousTop.lineIndex },
  };
}
