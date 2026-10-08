/**
 * Route a parsed SGR mouse event onto the fullscreen layout.
 * Coordinates are 1-based, matching the terminal's reporting.
 */
export interface MouseHit {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

export interface MouseLayout {
  /** First composer row, 0-based within the ink frame. */
  composerTop: number;
  composerLines: number;
  viewportRows: number;
  /** 0-based row of the jump-to-bottom affordance, when it is on screen. */
  jumpRow?: number;
  /** 0-based column of the scroll bar, when the transcript overflows the viewport. */
  scrollbarCol?: number;
}

export type MouseAction =
  | { type: 'scroll'; delta: number }
  | { type: 'pin' }
  | { type: 'caret'; visibleRow: number; cell: number }
  | { type: 'select'; phase: 'start' | 'move' | 'end'; x: number; y: number }
  | { type: 'scrollbar'; phase: 'start' | 'move' | 'end'; y: number }
  | { type: 'hover'; x: number; y: number }
  | { type: 'ignore' };

/** Motion with no button held (any-event tracking, mode 1003). */
export function isHoverMotion(hit: MouseHit): boolean {
  return (hit.button & 32) !== 0 && (hit.button & 3) === 3 && (hit.button & 64) === 0;
}

export function routeMouse(hit: MouseHit, layout: MouseLayout): MouseAction {
  const row = hit.y - 1;
  const cell = hit.x - 1;
  const wheel = hit.button & 64;
  if (isHoverMotion(hit)) return { type: 'hover', x: cell, y: row };
  if (wheel) {
    // Press and release both arrive for one notch on some terminals.
    if (hit.release) return { type: 'ignore' };
    const up = (hit.button & 1) === 0;
    return { type: 'scroll', delta: up ? -3 : 3 };
  }
  if (layout.jumpRow !== undefined && row === layout.jumpRow && !hit.release) {
    return { type: 'pin' };
  }
  if (
    layout.composerLines > 0 &&
    row >= layout.composerTop &&
    row < layout.composerTop + layout.composerLines
  ) {
    if (hit.release) return { type: 'ignore' };
    return { type: 'caret', visibleRow: row - layout.composerTop, cell };
  }
  if (row >= 0 && row < layout.viewportRows) {
    if (layout.scrollbarCol !== undefined && cell === layout.scrollbarCol) {
      // Press on the bar jumps the thumb there; holding and dragging follows.
      if (hit.release) return { type: 'scrollbar', phase: 'end', y: row };
      if ((hit.button & 32) !== 0) return { type: 'scrollbar', phase: 'move', y: row };
      return { type: 'scrollbar', phase: 'start', y: row };
    }
    if (hit.release) return { type: 'select', phase: 'end', x: cell, y: row };
    if ((hit.button & 32) !== 0) return { type: 'select', phase: 'move', x: cell, y: row };
    return { type: 'select', phase: 'start', x: cell, y: row };
  }
  return { type: 'ignore' };
}

/** Collapsed tool output and hidden thinking advertise themselves with ctrl+o. */
export function isExpandAffordance(text: string): boolean {
  return text.includes('ctrl+o');
}
