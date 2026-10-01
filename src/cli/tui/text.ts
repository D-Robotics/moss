/**
 * Shared text primitives for the CLI shell. Everything is measured in terminal
 * CELLS (see terminal-text.ts): `String.length` counts UTF-16 code units, so a
 * CJK goal measured with it comes out half its real width and the line overflows
 * — which makes the terminal hard-wrap and re-flow the whole screen.
 */
import { displayWidth } from '../terminal-text.js';

export type TuiColor = 'red' | 'green' | 'yellow' | 'cyan' | 'magenta' | 'blue' | 'gray' | 'white';

/**
 * One inline run inside a line (D-12). `markdown.ts` projects emphasis and
 * inline code onto runs; a row that carries `runs` is rendered run-by-run so a
 * mixed prose line keeps its inline-code colour instead of being painted as one
 * uniform style.
 */
export interface TuiLineRun {
  text: string;
  color?: TuiColor;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface TuiLine {
  text: string;
  color?: TuiColor;
  bold?: boolean;
  dim?: boolean;
  /** Italic emphasis (markdown); the shell maps it to ink's `<Text italic>`. */
  italic?: boolean;
  /** Headings (A10.75): bold + italic + underlined, like the reference. */
  underline?: boolean;
  /**
   * Inline runs in reading order. Invariant:
   * `runs.map((run) => run.text).join('') === text`. When present the runs are
   * the source of truth for styling; the row fields are the uniform fallback.
   */
  runs?: TuiLineRun[];
}

export function line(text: string, props: Omit<TuiLine, 'text'> = {}): TuiLine {
  return { text, ...props };
}

/**
 * Grapheme-cluster segmentation, the SAME unit `string-width` measures.
 *
 * Summing `displayWidth` per CODE POINT is wrong for every cluster built from
 * more than one scalar: `❤` + U+FE0F sums to 1 cell while the terminal draws the
 * cluster `❤️` two cells wide (and a ZWJ family measured per code point counts 4+
 * where the terminal draws 2). Under-counting a composer row makes the terminal
 * hard-wrap and re-flow the whole frame, so every wrap/caret/clip computation in
 * this directory walks clusters, never code points.
 */
export interface Grapheme {
  text: string;
  /** UTF-16 offset of the cluster start (safe for slice/insert). */
  start: number;
  /** Exclusive UTF-16 offset. */
  end: number;
  cells: number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function* iterateGraphemes(text: string): Generator<Grapheme> {
  if (text.length === 0) return;
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    yield {
      text: segment,
      start: index,
      end: index + segment.length,
      cells: displayWidth(segment),
    };
  }
}

export function graphemes(text: string): Grapheme[] {
  return [...iterateGraphemes(text)];
}

/** Boundary after the cluster containing `index` (never splits a cluster). */
export function nextGraphemeIndex(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const at = Math.max(0, index);
  for (const cluster of iterateGraphemes(text)) {
    if (cluster.start <= at && at < cluster.end) return cluster.end;
    if (cluster.start > at) return cluster.start;
  }
  return text.length;
}

/** Boundary before the cluster containing `index` (never splits a cluster). */
export function prevGraphemeIndex(text: string, index: number): number {
  if (index <= 0) return 0;
  let previous = 0;
  for (const cluster of iterateGraphemes(text)) {
    if (cluster.end >= index) return cluster.start;
    previous = cluster.end;
  }
  return previous;
}

/**
 * Clip to a cell budget, cutting on GRAPHEME boundaries (N-2). The shared
 * `truncateTerminalText` walks CODE POINTS, so it could keep a lone `❤` and drop
 * its U+FE0F — the row stayed inside the width but the glyph changed shape.
 * Never exceeds `width` cells, and only ever ends with a whole cluster plus `…`.
 */
export function clip(text: string, width: number): string {
  const budget = Math.max(1, Math.floor(width));
  if (displayWidth(text) <= budget) return text;
  if (budget === 1) return '…';
  let out = '';
  for (const cluster of graphemes(text)) {
    // `+ 1` reserves the cell for the cut marker.
    if (displayWidth(out + cluster.text) > budget - 1) break;
    out += cluster.text;
  }
  return `${out}…`;
}

/** Right-pad `text` to `width` cells (column alignment for menus). */
export function padEndTo(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

export function padStartTo(text: string, width: number): string {
  return `${' '.repeat(Math.max(0, width - displayWidth(text)))}${text}`;
}

/**
 * Greedy word wrap measured in cells. A token wider than the line (CJK prose
 * has no spaces, base64 blobs have no break points) is hard-split by cell width
 * instead of being emitted as an over-wide line.
 */
export function wrap(text: string, width: number, indent = 0): string[] {
  const max = Math.max(4, width - indent);
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current) out.push(current);
    current = '';
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= max) {
      current = candidate;
      continue;
    }
    flush();
    if (displayWidth(word) <= max) {
      current = word;
      continue;
    }
    let chunk = '';
    for (const cluster of iterateGraphemes(word)) {
      if (chunk && displayWidth(chunk + cluster.text) > max) {
        out.push(chunk);
        chunk = '';
      }
      chunk += cluster.text;
    }
    current = chunk;
  }
  flush();
  return out.map((chunk) => ' '.repeat(indent) + chunk);
}

/** Full-width horizontal rule. */
export function rule(width: number, char = '─'): string {
  return char.repeat(Math.max(1, width));
}

export { displayWidth };
