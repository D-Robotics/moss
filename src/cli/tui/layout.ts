/**
 * Mission Control layout engine — pure geometry for the three breakpoints.
 * wide (≥120): navigator | canvas | context, each an ink Box with a border;
 * medium (≥90): canvas | context (navigator collapses into the header chips);
 * narrow (<90 — the most common real terminal width): a single full-width
 * panel, context/detail reachable via Tab view switching. Widths are Box
 * widths (border included); projections receive width-2 content columns.
 */

export type LayoutMode = 'wide' | 'medium' | 'narrow';

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
  const mode: LayoutMode = columns >= 120 ? 'wide' : columns >= 90 ? 'medium' : 'narrow';
  // Header 1 + notice ≤2 + live tail ≤2 + status 1 + input 1 = up to 7 rows
  // around the main panel; keep the panel usable on short terminals.
  const bodyHeight = Math.max(6, rows - 8);
  const contentHeight = bodyHeight - 2;
  if (mode === 'wide') {
    const navigatorWidth = 26;
    const contextWidth = 40;
    const canvasWidth = columns - navigatorWidth - contextWidth - 2;
    return {
      mode,
      columns,
      rows,
      bodyHeight,
      contentHeight,
      navigatorWidth,
      contextWidth,
      canvasWidth: Math.max(24, canvasWidth),
      showNavigator: true,
      showContext: true,
    };
  }
  if (mode === 'medium') {
    const contextWidth = 32;
    return {
      mode,
      columns,
      rows,
      bodyHeight,
      contentHeight,
      navigatorWidth: 0,
      contextWidth,
      canvasWidth: Math.max(24, columns - contextWidth - 1),
      showNavigator: false,
      showContext: true,
    };
  }
  return {
    mode,
    columns,
    rows,
    bodyHeight,
    contentHeight,
    navigatorWidth: 0,
    contextWidth: 0,
    canvasWidth: columns,
    showNavigator: false,
    showContext: false,
  };
}
