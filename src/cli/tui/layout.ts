/**
 * Mission Control layout engine — pure geometry. IDE-style two-pane shell at
 * every width: task navigator (left) + execution canvas (right); a third
 * context pane joins at wide (≥120). Widths are ink Box widths (border
 * included); projections receive width-2 content columns.
 */

export type LayoutMode = 'wide' | 'standard';

export interface MissionLayout {
  mode: LayoutMode;
  columns: number;
  rows: number;
  /** Main panel Box height (border rows included). */
  bodyHeight: number;
  /** Lines available inside a panel (bodyHeight - 2 border rows). */
  contentHeight: number;
  navigatorWidth: number;
  contextWidth: number;
  canvasWidth: number;
  showNavigator: boolean;
  showContext: boolean;
}

export const MIN_COLUMNS = 40;

export function computeLayout(columns: number, rows: number): MissionLayout {
  // Status bar + live tail ≤2 + notice ≤2 + composer hint + input = up to 7
  // rows around the main panels (the key reference now lives in the `?`
  // overlay, so it costs no permanent row); keep the panels usable when short.
  const bodyHeight = Math.max(6, rows - 7);
  const contentHeight = bodyHeight - 2;
  const mode: LayoutMode = columns >= 120 ? 'wide' : 'standard';
  if (mode === 'wide') {
    const navigatorWidth = 24;
    const contextWidth = 38;
    const canvasWidth = Math.max(24, columns - navigatorWidth - contextWidth - 2);
    return {
      mode,
      columns,
      rows,
      bodyHeight,
      contentHeight,
      navigatorWidth,
      contextWidth,
      canvasWidth,
      showNavigator: true,
      showContext: true,
    };
  }
  // Standard (the common 80-col terminal): two panes, navigator + canvas.
  const navigatorWidth = columns >= 70 ? 22 : 16;
  return {
    mode,
    columns,
    rows,
    bodyHeight,
    contentHeight,
    navigatorWidth,
    contextWidth: 0,
    canvasWidth: Math.max(18, columns - navigatorWidth - 1),
    showNavigator: true,
    showContext: false,
  };
}
