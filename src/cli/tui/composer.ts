/**
 * Composer editor — a real multi-line editor for the CLI input line.
 *
 * The reference CLIs are editors first: the caret moves anywhere, text soft-wraps
 * at the terminal edge, Ctrl+J / Shift+Enter insert a newline, and a long goal
 * stays readable and editable instead of being clipped to a single row.
 *
 * Pure model + pure projection (no ink imports) so specs drive both directly.
 * All widths are terminal CELLS (see text.ts) so CJK/emoji stay correct.
 */
import { displayWidth, graphemes, nextGraphemeIndex, prevGraphemeIndex } from './text.js';

export interface ComposerState {
  value: string;
  /** Caret offset in UTF-16 code units (safe for slice/insert operations). */
  caret: number;
}

export type ComposerMotion =
  | 'left'
  | 'right'
  | 'word-left'
  | 'word-right'
  | 'line-start'
  | 'line-end'
  /** Visual row movement over the soft-wrapped frame. */
  | 'up'
  | 'down';

export type ComposerDeleteUnit =
  | 'backward'
  | 'forward'
  | 'word-backward'
  | 'line-start'
  | 'line-end';

export function createComposer(value = ''): ComposerState {
  return { value, caret: value.length };
}

export function composerSetValue(value: string, caret?: number): ComposerState {
  const bounded = Math.max(0, Math.min(caret ?? value.length, value.length));
  const previous = prevGraphemeIndex(value, bounded);
  const normalized =
    bounded > 0 && bounded < value.length && nextGraphemeIndex(value, previous) !== bounded
      ? previous
      : bounded;
  return { value, caret: normalized };
}

/**
 * Caret steps are GRAPHEME steps: they never land inside a variation sequence
 * (`❤` + U+FE0F) or a ZWJ family, which would put the caret in a column the
 * terminal never draws and drift `caretAt`'s cell column away from the text.
 */
function prevIndex(value: string, index: number): number {
  return prevGraphemeIndex(value, index);
}

function nextIndex(value: string, index: number): number {
  return nextGraphemeIndex(value, index);
}

const WORD_RE = /[\p{L}\p{N}_]/u;
const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_RE.test(char);

export function composerInsert(state: ComposerState, text: string): ComposerState {
  return {
    value: `${state.value.slice(0, state.caret)}${text}${state.value.slice(state.caret)}`,
    caret: state.caret + text.length,
  };
}

export function composerNewline(state: ComposerState): ComposerState {
  return composerInsert(state, '\n');
}

/** Offsets of the logical line containing the caret (explicit \n boundaries). */
export function logicalBounds(value: string, caret: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const nextBreak = value.indexOf('\n', caret);
  return { start, end: nextBreak === -1 ? value.length : nextBreak };
}

export function composerDelete(state: ComposerState, unit: ComposerDeleteUnit): ComposerState {
  const { value, caret } = state;
  if (unit === 'backward') {
    const from = prevIndex(value, caret);
    if (from === caret) return state;
    return { value: value.slice(0, from) + value.slice(caret), caret: from };
  }
  if (unit === 'forward') {
    const to = nextIndex(value, caret);
    if (to === caret) return state;
    return { value: value.slice(0, caret) + value.slice(to), caret };
  }
  if (unit === 'word-backward') {
    const moved = composerMove(state, 'word-left');
    if (moved.caret === caret) return state;
    return { value: value.slice(0, moved.caret) + value.slice(caret), caret: moved.caret };
  }
  if (unit === 'line-start') {
    const { start } = logicalBounds(value, caret);
    if (start === caret) return state;
    return { value: value.slice(0, start) + value.slice(caret), caret: start };
  }
  const { end } = logicalBounds(value, caret);
  if (end === caret) return state;
  return { value: value.slice(0, caret) + value.slice(end), caret };
}

/**
 * Kill-ring delete (readline semantics): like `composerDelete` for the killing
 * units, but also returns the removed text so the shell can offer Ctrl+Y
 * (yank) afterwards, exactly like the reference CLI's "Ctrl+Y to paste
 * deleted text" hint.
 */
export function composerKill(
  state: ComposerState,
  unit: 'word-backward' | 'line-start' | 'line-end'
): { next: ComposerState; killed: string } {
  const { value, caret } = state;
  if (unit === 'line-start') {
    const { start } = logicalBounds(value, caret);
    return {
      next:
        start === caret
          ? state
          : { value: value.slice(0, start) + value.slice(caret), caret: start },
      killed: value.slice(start, caret),
    };
  }
  if (unit === 'line-end') {
    const { end } = logicalBounds(value, caret);
    return {
      next: end === caret ? state : { value: value.slice(0, caret) + value.slice(end), caret },
      killed: value.slice(caret, end),
    };
  }
  const moved = composerMove(state, 'word-left');
  return {
    next:
      moved.caret === caret
        ? state
        : { value: value.slice(0, moved.caret) + value.slice(caret), caret: moved.caret },
    killed: value.slice(moved.caret, caret),
  };
}

// ─── soft wrap ────────────────────────────────────────────────────────────

export interface WrapSpan {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Exact wrap: whitespace is preserved (the user typed it), the break prefers a
 * space when one is available, and a space-free run is hard-split by cells.
 * Widths come from whole grapheme clusters, so a VS16/ZWJ cluster is billed at
 * the cells the terminal actually paints it with.
 */
export function wrapSpans(text: string, width: number): WrapSpan[] {
  const max = Math.max(1, width);
  if (text.length === 0) return [{ start: 0, end: 0 }];
  const spans: WrapSpan[] = [];
  let start = 0;
  let cells = 0;
  let lastSpace = -1;
  for (const cluster of graphemes(text)) {
    if (cells + cluster.cells > max) {
      const breakAt = lastSpace > start ? lastSpace + 1 : cluster.start;
      spans.push({ start, end: breakAt });
      start = breakAt;
      cells = displayWidth(text.slice(start, cluster.start));
      lastSpace = -1;
      // The space we broke at can be too far back: the row that starts there is
      // already full before this cluster (a narrow run + a wide cluster). Cut at
      // the cluster instead of emitting a row one cluster past the budget.
      if (start < cluster.start && cells + cluster.cells > max) {
        spans.push({ start, end: cluster.start });
        start = cluster.start;
        cells = 0;
      }
    }
    if (cluster.text === ' ') lastSpace = cluster.start;
    cells += cluster.cells;
  }
  spans.push({ start, end: text.length });
  return spans;
}

/** Visual rows of the value, as absolute [start, end) offsets. */
export function composerRows(state: ComposerState, width: number): WrapSpan[] {
  const rows: WrapSpan[] = [];
  let offset = 0;
  for (const logical of state.value.split('\n')) {
    for (const span of wrapSpans(logical, width)) {
      rows.push({ start: offset + span.start, end: offset + span.end });
    }
    offset += logical.length + 1; // + the newline itself
  }
  return rows;
}

/** (row, column-in-cells) of the caret for a given width. */
export function caretAt(
  state: ComposerState,
  width: number,
  rows: WrapSpan[] = composerRows(state, width)
): { row: number; column: number } {
  for (let row = 0; row < rows.length; row += 1) {
    const span = rows[row]!;
    if (state.caret <= span.end) {
      const column = displayWidth(state.value.slice(span.start, state.caret));
      const nextStartsHere = rows[row + 1]?.start === span.end;
      // A caret that has reached the row's cell budget belongs to the next row.
      // The old test only compared RAW offsets (`caret === span.end`), so a
      // zero-width trailing cluster (a tab after a full row) left the caret on a
      // row with no cell left — the caret cell was then inserted past the width.
      if ((state.caret === span.end || column >= width) && nextStartsHere) continue;
      return { row, column };
    }
  }
  const last = rows[rows.length - 1]!;
  return {
    row: rows.length - 1,
    column: displayWidth(state.value.slice(last.start, state.caret)),
  };
}

function offsetAt(state: ComposerState, row: WrapSpan, column: number): number {
  const text = state.value.slice(row.start, row.end);
  let cells = 0;
  for (const cluster of graphemes(text)) {
    if (cells + cluster.cells > column) return row.start + cluster.start;
    cells += cluster.cells;
  }
  return row.end;
}

/**
 * Map a click on a visible composer row to a caret offset.
 * `visibleRow` is 0-based inside the window `renderComposerEditor` shows.
 * `cell` is the terminal column of the click, including the prompt prefix.
 */
export function composerCaretFromClick(
  state: ComposerState,
  options: ComposerViewOptions,
  visibleRow: number,
  cell: number
): ComposerState {
  if (state.value.length === 0) return { value: state.value, caret: 0 };
  const width = Math.max(1, options.width);
  const maxRows = Math.max(1, options.maxRows);
  const firstPrefix = options.firstPrefix ?? '';
  const restPrefix = options.restPrefix ?? firstPrefix;
  const prefixWidth = Math.max(displayWidth(firstPrefix), displayWidth(restPrefix));
  const rowWidth = Math.max(1, width - prefixWidth);
  const rows = composerRows(state, rowWidth);
  const position = caretAt(state, rowWidth, rows);
  const caretNeedsRow = position.column >= rowWidth && position.row === rows.length - 1;
  const displayRows = caretNeedsRow
    ? [...rows, { start: state.value.length, end: state.value.length }]
    : rows;
  const caretIndex = caretNeedsRow ? displayRows.length - 1 : position.row;
  const start = Math.max(0, Math.min(caretIndex - maxRows + 1, displayRows.length - maxRows));
  const span = displayRows[start + visibleRow];
  if (!span) return state;
  const prefixCells = visibleRow === 0 ? displayWidth(firstPrefix) : displayWidth(restPrefix);
  return { value: state.value, caret: offsetAt(state, span, Math.max(0, cell - prefixCells)) };
}

export function composerMove(
  state: ComposerState,
  motion: ComposerMotion,
  width = 80
): ComposerState {
  const { value, caret } = state;
  switch (motion) {
    case 'left':
      return { value, caret: prevIndex(value, caret) };
    case 'right':
      return { value, caret: nextIndex(value, caret) };
    case 'word-left': {
      let index = caret;
      while (index > 0 && !isWordChar(value[index - 1])) index -= 1;
      while (index > 0 && isWordChar(value[index - 1])) index -= 1;
      return { value, caret: index };
    }
    case 'word-right': {
      let index = caret;
      while (index < value.length && !isWordChar(value[index])) index += 1;
      while (index < value.length && isWordChar(value[index])) index += 1;
      return { value, caret: index };
    }
    case 'line-start':
      return { value, caret: logicalBounds(value, caret).start };
    case 'line-end':
      return { value, caret: logicalBounds(value, caret).end };
    case 'up':
    case 'down': {
      const rows = composerRows(state, width);
      const { row, column } = caretAt(state, width, rows);
      const target = motion === 'up' ? row - 1 : row + 1;
      if (target < 0) return { value, caret: 0 };
      if (target >= rows.length) return { value, caret: value.length };
      return { value, caret: offsetAt(state, rows[target]!, column) };
    }
    default:
      return state;
  }
}

// ─── projection ───────────────────────────────────────────────────────────

/** Rows the composer may occupy before it starts windowing. */
export const COMPOSER_MAX_ROWS = 6;

export interface ComposerRun {
  text: string;
}

export interface ComposerView {
  /** One entry per visible row; each row is a list of styled runs. */
  lines: ComposerRun[][];
  /** True when the (empty) placeholder is being shown. */
  placeholder: boolean;
  /** Visible row that holds the caret (0-based). */
  caretRow: number;
  /**
   * Hardware-cursor column in terminal cells, including the prompt prefix.
   * The shell places the real cursor here; the projection never inserts a
   * fake caret cell.
   */
  caretCol: number;
}

export interface ComposerViewOptions {
  width: number;
  maxRows: number;
  placeholder?: string;
  /** Prefix for the first row, e.g. `❯ ` (counts against the wrap width). */
  firstPrefix?: string;
  /** Prefix for continuation rows, e.g. `  `. Defaults to `firstPrefix`. */
  restPrefix?: string;
  /** Mark the first visible row with `… ` when rows above it are hidden. */
  markElision?: boolean;
}

/**
 * Render the composer: soft-wrapped rows, windowed so the caret row is always
 * visible. The caret is NOT drawn — `caretRow`/`caretCol` are the hardware
 * cursor, including at the end of a full row, where the caret needs its own
 * (empty) row so the terminal has a cell to park it in.
 */
export function renderComposerEditor(
  state: ComposerState,
  options: ComposerViewOptions
): ComposerView {
  const width = Math.max(1, options.width);
  const maxRows = Math.max(1, options.maxRows);
  if (state.value.length === 0 && options.placeholder) {
    const prefix = options.firstPrefix ?? '';
    return {
      placeholder: true,
      caretRow: 0,
      caretCol: displayWidth(prefix),
      lines: [[{ text: clipCells(`${prefix}${options.placeholder}`, width) }]],
    };
  }
  const firstPrefix = options.firstPrefix ?? '';
  const restPrefix = options.restPrefix ?? firstPrefix;
  const prefixWidth = Math.max(displayWidth(firstPrefix), displayWidth(restPrefix));
  // The content budget is exact: prefix + rowWidth must never exceed `width`, so
  // the floor is 1, not 4 — a 4- or 5-cell pane used to emit a 6-cell row.
  const rowWidth = Math.max(1, width - prefixWidth);
  const rows = composerRows(state, rowWidth);
  const position = caretAt(state, rowWidth, rows);
  // A caret at the end of a completely full row has no cell of its own: give it
  // a synthetic row so it is never clipped away.
  const caretNeedsRow = position.column >= rowWidth && position.row === rows.length - 1;
  const displayRows = caretNeedsRow
    ? [...rows, { start: state.value.length, end: state.value.length }]
    : rows;
  const caretIndex = caretNeedsRow ? displayRows.length - 1 : position.row;
  const start = Math.max(0, Math.min(caretIndex - maxRows + 1, displayRows.length - maxRows));
  const visible = displayRows.slice(start, start + maxRows);
  const caretRow = caretIndex - start;
  // An elided head drops the gutter on purpose: `… ` is the signal that the
  // message start has scrolled out of the window.
  const withPrefix = (runs: ComposerRun[], index: number, elided = false): ComposerRun[] => {
    const prefix = elided ? '' : index === 0 ? firstPrefix : restPrefix;
    return prefix ? [{ text: prefix }, ...runs] : runs;
  };

  const lines = visible.map((row, index) => {
    const text = state.value.slice(row.start, row.end);
    const elided = options.markElision === true && start > 0 && index === 0;
    return withPrefix([{ text: elided ? clipCells(`… ${text}`, width) : text }], index, elided);
  });
  const caretSpan = visible[caretRow];
  const elidedCaret = options.markElision === true && start > 0 && caretRow === 0;
  const prefixForCaret = elidedCaret ? '… ' : caretRow === 0 ? firstPrefix : restPrefix;
  const beforeCaret = caretSpan
    ? state.value.slice(caretSpan.start, Math.min(state.caret, caretSpan.end))
    : '';
  const caretCol = displayWidth(prefixForCaret) + displayWidth(beforeCaret);
  return { placeholder: false, lines, caretRow, caretCol };
}

/** Take at most `cells` cells from the head of a string, without a marker. */
export function takeCells(text: string, cells: number): string {
  // A zero-width cluster (a tab) must NOT survive a zero-cell budget: returning
  // it is what let a caret row reach one cell past its budget.
  if (cells <= 0) return '';
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    if (used + cluster.cells > cells) break;
    out += cluster.text;
    used += cluster.cells;
  }
  return out;
}

/** Clip a plain string to a cell budget (keeps the head, marks the cut). */
export function clipCells(text: string, width: number): string {
  const budget = Math.max(1, width);
  if (displayWidth(text) <= budget) return text;
  // Even the cut marker has to fit: at a 1-cell budget the marker is the row.
  if (budget === 1) return '…';
  let out = '';
  for (const cluster of graphemes(text)) {
    if (displayWidth(out + cluster.text) > budget - 1) break;
    out += cluster.text;
  }
  return `${out}…`;
}
