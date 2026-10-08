/**
 * Frame budget shared by the inline and fullscreen renderers.
 *
 * Inline: the dynamic region (everything ink redraws) stays within `rows - 1`
 * so ink never clears the screen to replay history.
 * Fullscreen: the transcript viewport is `rows - chrome - composer`, and is
 * never given fewer than 3 rows; chrome is trimmed by the same priority.
 */
import type { TuiLine } from './text.js';

export type FrameSectionId = 'dialog' | 'overlay' | 'status-notes' | 'todo' | 'queue' | 'live';

export interface FrameSection {
  id: FrameSectionId;
  lines: TuiLine[];
  /** Rows kept even when the terminal is short (question line, spinner). */
  min: number;
  /** Lower is kept first. */
  priority: number;
  trim: 'head' | 'tail';
}

export interface FrameRequest {
  rows: number;
  mode: 'inline' | 'fullscreen';
  composerLines: number;
  /** Rows that are always painted (status rule, hint rule). */
  fixedChrome: number;
  sections: FrameSection[];
}

export interface FrameLayout {
  sections: Array<{ id: FrameSectionId; lines: TuiLine[] }>;
  composerLines: number;
  viewportRows: number;
  dynamicRows: number;
}

const SECTION_PRIORITY: Record<FrameSectionId, number> = {
  dialog: 0,
  overlay: 1,
  'status-notes': 2,
  todo: 3,
  queue: 4,
  live: 5,
};

export function sectionPriority(id: FrameSectionId): number {
  return SECTION_PRIORITY[id];
}

function takeLines(section: FrameSection, count: number): TuiLine[] {
  if (count <= 0) return [];
  if (count >= section.lines.length) return section.lines;
  return section.trim === 'head'
    ? section.lines.slice(section.lines.length - count)
    : section.lines.slice(0, count);
}

export function allocateFrame(request: FrameRequest): FrameLayout {
  const rows = Math.max(1, request.rows);
  const composerLines = Math.max(1, request.composerLines);
  const fixed = Math.max(0, request.fixedChrome);
  const sections = [...request.sections].sort((a, b) => a.priority - b.priority);
  const variableBudget =
    request.mode === 'fullscreen'
      ? Math.max(0, rows - fixed - composerLines - 3)
      : Math.max(0, rows - 1 - fixed - composerLines);

  const granted = new Map<FrameSectionId, number>();
  let used = 0;
  for (const section of sections) {
    const min = Math.min(section.lines.length, Math.max(0, section.min));
    const room = Math.max(0, variableBudget - used);
    const give = Math.min(min, room);
    granted.set(section.id, give);
    used += give;
  }
  for (const section of sections) {
    const have = granted.get(section.id) ?? 0;
    const room = Math.max(0, variableBudget - used);
    const extra = Math.min(room, section.lines.length - have);
    granted.set(section.id, have + extra);
    used += extra;
  }

  const laid = sections.map((section) => ({
    id: section.id,
    lines: takeLines(section, granted.get(section.id) ?? 0),
  }));
  const chromeRows = laid.reduce((sum, section) => sum + section.lines.length, 0) + fixed;
  const viewportRows =
    request.mode === 'fullscreen' ? Math.max(3, rows - chromeRows - composerLines) : 0;
  const dynamicRows = request.mode === 'fullscreen' ? rows : chromeRows + composerLines;
  return { sections: laid, composerLines, viewportRows, dynamicRows };
}
