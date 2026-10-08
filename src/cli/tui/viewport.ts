/**
 * Application viewport over an already-projected transcript.
 *
 * `pinned` follows the bottom. Scrolling up unpins; typing does not change
 * the offset. Resize keeps the row that was at the top of the window visible.
 */

export interface ViewportLine {
  rowId: number;
  /** Offset of this visual line within its source row. */
  lineIndex: number;
  text: string;
}

export interface ViewportState {
  /** How many visual lines above the bottom the window starts. 0 = pinned. */
  offsetFromBottom: number;
  pinned: boolean;
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

export function viewportWindow(
  lines: readonly ViewportLine[],
  state: ViewportState,
  viewportRows: number
): ViewportWindow {
  const height = Math.max(1, viewportRows);
  const total = lines.length;
  if (state.pinned || state.offsetFromBottom <= 0) {
    const start = Math.max(0, total - height);
    return {
      lines: lines.slice(start),
      start,
      pinned: true,
      unread: 0,
    };
  }
  const maxOffset = Math.max(0, total - height);
  const offset = Math.min(state.offsetFromBottom, maxOffset);
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - height);
  return {
    lines: lines.slice(start, end),
    start,
    pinned: false,
    unread: offset,
  };
}

export function scrollViewport(
  state: ViewportState,
  lines: number,
  delta: number,
  viewportRows: number
): ViewportState {
  const height = Math.max(1, viewportRows);
  const maxOffset = Math.max(0, lines - height);
  if (delta >= 0 && state.pinned) return state;
  const current = state.pinned ? 0 : state.offsetFromBottom;
  const next = Math.max(0, Math.min(maxOffset, current - delta));
  return { offsetFromBottom: next, pinned: next === 0 };
}

export function pinViewport(): ViewportState {
  return { offsetFromBottom: 0, pinned: true };
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
  const index = lines.findIndex(
    (line) => line.rowId === previousTop.rowId && line.lineIndex === previousTop.lineIndex
  );
  if (index < 0) return pinViewport();
  const bottom = Math.min(lines.length, index + height);
  const offset = Math.max(0, lines.length - bottom);
  return { offsetFromBottom: offset, pinned: offset === 0 };
}
