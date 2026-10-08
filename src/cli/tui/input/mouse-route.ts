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
}

export type MouseAction =
  | { type: 'scroll'; delta: number }
  | { type: 'pin' }
  | { type: 'caret'; visibleRow: number; cell: number }
  | { type: 'select'; phase: 'start' | 'move' | 'end'; x: number; y: number }
  | { type: 'ignore' };

export function routeMouse(hit: MouseHit, layout: MouseLayout): MouseAction {
  const row = hit.y - 1;
  const cell = hit.x - 1;
  const wheel = hit.button & 64;
  if (wheel) {
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
    if (hit.release) return { type: 'select', phase: 'end', x: cell, y: row };
    if ((hit.button & 32) !== 0) return { type: 'select', phase: 'move', x: cell, y: row };
    return { type: 'select', phase: 'start', x: cell, y: row };
  }
  return { type: 'ignore' };
}
