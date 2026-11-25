/**
 * Transcript search (Ctrl+F): find a query in the projected lines and mark
 * each hit on its line. Pure text work, so the verify stage can pin it without
 * a terminal. The shell owns the state (which hit the reader is on).
 *
 * Offsets are UTF-16 positions in a line's VISIBLE text. An escape sequence
 * (an OSC 8 hyperlink) is skipped by the search and kept as it is by the
 * highlight, so a hit never lands inside one. A hit sits on one visual line: a
 * phrase that wraps onto the next line does not match.
 */
import { tui } from './copy.js';
import { clip, graphemes, line, type TuiLine, type TuiLineRun } from './text.js';
import { TONE } from './theme.js';

/** The Ctrl+F bar while it is open. `current` indexes the hits of the frame. */
export interface TranscriptSearch {
  query: string;
  current: number;
  /**
   * A resumed search shows its query selected, as a search box does: typing
   * replaces it, Backspace clears it, Enter steps from where it was.
   */
  selected?: boolean;
}

export interface SearchMatch {
  /** Index of the visual line in the projection. */
  line: number;
  /** Offset of the hit's first character in that line's visible text. */
  start: number;
  /** Offset after the hit's last character. */
  end: number;
}

const ESC = '\x1b';

interface Piece {
  text: string;
  visible: boolean;
}

/** End (exclusive) of the escape sequence that starts at `start`. */
function sequenceEnd(text: string, start: number): number {
  const kind = text[start + 1];
  // OSC ends at BEL, or at the two-character string terminator `ESC \`.
  if (kind === ']') {
    const bel = text.indexOf('\x07', start + 2);
    const terminator = text.indexOf(`${ESC}\\`, start + 2);
    if (bel >= 0 && (terminator < 0 || bel < terminator)) return bel + 1;
    return terminator < 0 ? text.length : terminator + 2;
  }
  // CSI ends at its final byte (0x40 to 0x7E).
  if (kind === '[') {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
      index += 1;
    }
    return text.length;
  }
  // ESC followed by one character (`ESC c`, a stray ESC at the end, …).
  return Math.min(text.length, start + 2);
}

function* pieces(text: string): Generator<Piece> {
  let index = 0;
  while (index < text.length) {
    if (text[index] === ESC) {
      const end = sequenceEnd(text, index);
      yield { text: text.slice(index, end), visible: false };
      index = end;
    } else {
      const next = text.indexOf(ESC, index);
      const end = next < 0 ? text.length : next;
      yield { text: text.slice(index, end), visible: true };
      index = end;
    }
  }
}

/**
 * `text` without control characters. A query is painted on one row, so a
 * paste must not carry escapes or newlines into it.
 */
export function searchText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** What a terminal shows for `text`: the escape sequences removed. */
export function visibleText(text: string): string {
  if (!text.includes(ESC)) return text;
  let out = '';
  for (const piece of pieces(text)) {
    if (piece.visible) out += piece.text;
  }
  return out;
}

// Lowercasing a whole string moves every offset after it as soon as one
// character maps to several (`İ`). Fold code unit by code unit and leave the
// characters that would grow alone, so an offset found in the folded text is
// the same offset in the original.
const FOLDED_UNIT = new Map<number, number>();

function foldUnit(unit: number): number {
  let folded = FOLDED_UNIT.get(unit);
  if (folded === undefined) {
    const lower = String.fromCharCode(unit).toLowerCase();
    folded = lower.length === 1 ? lower.charCodeAt(0) : unit;
    FOLDED_UNIT.set(unit, folded);
  }
  return folded;
}

function fold(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 8192) {
    const units: number[] = [];
    for (let at = index; at < Math.min(text.length, index + 8192); at += 1) {
      units.push(foldUnit(text.charCodeAt(at)));
    }
    out += String.fromCharCode(...units);
  }
  return out;
}

// The transcript does not change between keystrokes, so each line is folded
// once per search, not once per character typed.
const FOLDED_LINE = new Map<string, string>();
const FOLDED_LINE_LIMIT = 20000;

function foldedLine(text: string): string {
  let folded = FOLDED_LINE.get(text);
  if (folded === undefined) {
    folded = fold(text);
    if (FOLDED_LINE.size >= FOLDED_LINE_LIMIT) FOLDED_LINE.clear();
    FOLDED_LINE.set(text, folded);
  }
  return folded;
}

/**
 * Every hit of `query` in `texts`, line by line and left to right. Literal and
 * case-insensitive; a run of whitespace in the query stands for one space.
 */
export function findMatches(texts: readonly string[], query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const needle = fold(query.replace(/\s+/g, ' ').trim());
  if (!needle) return matches;
  for (let index = 0; index < texts.length; index += 1) {
    const haystack = foldedLine(texts[index] ?? '');
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      matches.push({ line: index, start: at, end: at + needle.length });
      at = haystack.indexOf(needle, at + needle.length);
    }
  }
  return matches;
}

type SearchMark = Pick<TuiLineRun, 'inverse' | 'bold' | 'underline'>;

/** Other hits keep their colour and are underlined; the one the reader is on is inverted. */
const HIT: SearchMark = { underline: true };
const CURRENT: SearchMark = { inverse: true, bold: true };

function sameStyle(a: TuiLineRun, b: TuiLineRun): boolean {
  return (
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse
  );
}

/**
 * `source` with the hit `[from, to)` of its visible text marked. The line
 * must not carry marks of an earlier call: they would not be removed.
 */
export function highlightMatch(
  source: TuiLine,
  from: number,
  to: number,
  current: boolean
): TuiLine {
  const base: TuiLineRun[] = source.runs?.length
    ? source.runs
    : [
        {
          text: source.text,
          color: source.color,
          bold: source.bold,
          italic: source.italic,
          underline: source.underline,
        },
      ];
  const runs: TuiLineRun[] = [];
  let visible = 0;
  const emit = (run: TuiLineRun): void => {
    if (!run.text) return;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, run)) {
      last.text += run.text;
    } else {
      runs.push(run);
    }
  };
  for (const style of base) {
    for (const piece of pieces(style.text)) {
      if (!piece.visible) {
        emit({ ...style, text: piece.text });
        continue;
      }
      for (const cluster of graphemes(piece.text)) {
        const start = visible;
        visible += cluster.text.length;
        const marked = start >= from && visible <= to;
        emit({
          ...style,
          text: cluster.text,
          ...(marked ? (current ? CURRENT : HIT) : {}),
        });
      }
    }
  }
  return { ...source, runs };
}

/** The bar above the composer: the query, then where the reader is and what the keys do. */
export function renderTranscriptSearch(
  query: string,
  position: number,
  count: number,
  width: number,
  selected = false
): TuiLine[] {
  const state =
    count === 0
      ? query
        ? tui('no match')
        : tui('type to search')
      : tui('{n} of {count}', { n: position + 1, count });
  // A resumed query is selected: say so, in place of the clear key, so every
  // variant of this row fits the classic 80 columns.
  const keys = selected
    ? tui('Enter ↓ next · ↑ previous · type to replace · Esc close')
    : tui('Enter ↓ next · ↑ previous · Esc close · Ctrl+U clear');
  const prompt = line(clip(`⌕ ${query}`, width), { color: TONE.accent, bold: true });
  return [
    // A selected query is shown inverted, like selected text everywhere.
    selected
      ? { ...prompt, runs: [{ text: '⌕ ' }, { text: prompt.text.slice(2), inverse: true }] }
      : prompt,
    line(clip(`  ${state} · ${keys}`, width), {
      dim: true,
    }),
  ];
}
