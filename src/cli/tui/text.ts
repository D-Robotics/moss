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
 * An OSC 8 hyperlink is clipped on its visible label and closed again: the
 * target URL stays whole, and the cut marker sits outside the link.
 */
export function clip(text: string, width: number): string {
  const budget = Math.max(1, Math.floor(width));
  if (displayWidth(text) <= budget) return text;
  if (budget === 1) return '…';
  if (text.includes('\x1b]8;;')) return clipOsc8(text, budget);
  return clipPlain(text, budget);
}

function clipPlain(text: string, budget: number): string {
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

const CJK_GRAPHEME =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u;

/** A CJK character (or fullwidth punctuation) is its own wrap point. */
export function isCjkGrapheme(text: string): boolean {
  return CJK_GRAPHEME.test(text);
}

/** URLs stay on one line so a terminal can still select and open them. */
export function isUrlToken(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text);
}

/**
 * OSC 8 hyperlink. The visible label is what the terminal draws; the target
 * stays the full URL, so a clipped label is still clickable.
 */
export function osc8(url: string, label: string): string {
  const target = url.replace(/[\u0000-\u001F\u007F]/g, '');
  return `\x1b]8;;${target}\x1b\\${label}\x1b]8;;\x1b\\`;
}

interface OscPiece {
  /** Set when this piece is a hyperlink. The visible label is `visible`. */
  url?: string;
  visible: string;
}

/** Index just after an OSC terminator (ST or BEL), or undefined when it is missing. */
function oscTerminator(text: string, from: number): { uriEnd: number; next: number } | undefined {
  const st = text.indexOf('\x1b\\', from);
  const bel = text.indexOf('\x07', from);
  if (st < 0 && bel < 0) return undefined;
  if (bel >= 0 && (st < 0 || bel < st)) return { uriEnd: bel, next: bel + 1 };
  return { uriEnd: st, next: st + 2 };
}

/**
 * Split well-formed OSC 8 links from the surrounding text. A sequence with no
 * terminator stays plain, so a broken link is still clipped as graphemes.
 */
function splitOsc8(text: string): OscPiece[] {
  const pieces: OscPiece[] = [];
  const marker = '\x1b]8;;';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf(marker, index);
    if (open < 0) {
      pieces.push({ visible: text.slice(index) });
      break;
    }
    if (open > index) pieces.push({ visible: text.slice(index, open) });
    const header = oscTerminator(text, open + marker.length);
    if (!header) {
      pieces.push({ visible: text.slice(open) });
      break;
    }
    const url = text.slice(open + marker.length, header.uriEnd);
    if (url.length === 0) {
      index = header.next;
      continue;
    }
    const close = text.indexOf(marker, header.next);
    if (close < 0) {
      pieces.push({ url, visible: text.slice(header.next) });
      break;
    }
    const closeHeader = oscTerminator(text, close + marker.length);
    if (!closeHeader) {
      pieces.push({ url, visible: text.slice(header.next) });
      break;
    }
    const closeUrl = text.slice(close + marker.length, closeHeader.uriEnd);
    if (closeUrl.length > 0) {
      pieces.push({ url, visible: text.slice(header.next, close) });
      index = close;
      continue;
    }
    pieces.push({ url, visible: text.slice(header.next, close) });
    index = closeHeader.next;
  }
  return pieces;
}

/** Clip visible cells, then re-emit each kept link closed, with `…` outside it. */
function clipOsc8(text: string, budget: number): string {
  let keptVisible = '';
  const kept: OscPiece[] = [];
  for (const piece of splitOsc8(text)) {
    let taken = '';
    let stopped = false;
    for (const cluster of graphemes(piece.visible)) {
      if (displayWidth(keptVisible + taken + cluster.text) > budget - 1) {
        stopped = true;
        break;
      }
      taken += cluster.text;
    }
    if (taken.length > 0) {
      kept.push(piece.url !== undefined ? { url: piece.url, visible: taken } : { visible: taken });
      keptVisible += taken;
    }
    if (stopped || taken.length < piece.visible.length) break;
  }
  const body = kept
    .map((piece) => (piece.url !== undefined ? osc8(piece.url, piece.visible) : piece.visible))
    .join('');
  return `${body}…`;
}

/**
 * A URL that fits is plain text. One that is wider than the line becomes an
 * OSC 8 link whose visible label is clipped, so the row stays one terminal row.
 */
export function fitUrl(url: string, width: number): string {
  const max = Math.max(1, Math.floor(width));
  if (displayWidth(url) <= max) return url;
  return osc8(url, clip(url, max));
}

interface WrapUnit {
  text: string;
  /** Insert a space before this unit when the line already has text. */
  spaced: boolean;
  /** Do not split, even when the unit is wider than the line. */
  solid: boolean;
}

function wrapUnits(text: string): WrapUnit[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  const clusters = graphemes(flat);
  const units: WrapUnit[] = [];
  let index = 0;
  let pendingSpace = false;
  while (index < clusters.length) {
    const cluster = clusters[index];
    if (!cluster) break;
    if (cluster.text === ' ') {
      pendingSpace = units.length > 0;
      index += 1;
      continue;
    }
    const rest = clusters
      .slice(index)
      .map((item) => item.text)
      .join('');
    const url = /^https?:\/\/\S+/i.exec(rest);
    if (url) {
      units.push({ text: url[0], spaced: pendingSpace, solid: true });
      pendingSpace = false;
      let left = url[0].length;
      while (left > 0 && index < clusters.length) {
        left -= clusters[index]?.text.length ?? 0;
        index += 1;
      }
      continue;
    }
    if (isCjkGrapheme(cluster.text)) {
      units.push({ text: cluster.text, spaced: pendingSpace, solid: false });
      pendingSpace = false;
      index += 1;
      continue;
    }
    let chunk = '';
    while (index < clusters.length) {
      const next = clusters[index];
      if (!next || next.text === ' ') break;
      const ahead = clusters
        .slice(index)
        .map((item) => item.text)
        .join('');
      if (/^https?:\/\//i.test(ahead) || isCjkGrapheme(next.text)) break;
      chunk += next.text;
      index += 1;
    }
    units.push({ text: chunk, spaced: pendingSpace, solid: false });
    pendingSpace = false;
  }
  return units;
}

/**
 * Greedy wrap measured in cells. CJK breaks per character so a line fills
 * before the next word. URLs are never hard-split: one wider than the line
 * becomes an OSC 8 link whose visible label is clipped, so the row stays one
 * terminal row. A non-URL token wider than the line (a base64 blob) is
 * hard-split by cell width.
 */
export function wrap(text: string, width: number, indent = 0): string[] {
  const max = Math.max(4, width - indent);
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current) out.push(pad + current);
    current = '';
  };
  for (const unit of wrapUnits(text)) {
    const gap = unit.spaced && current ? ' ' : '';
    const candidate = `${current}${gap}${unit.text}`;
    if (displayWidth(candidate) <= max) {
      current = candidate;
      continue;
    }
    if (unit.solid) {
      flush();
      current = fitUrl(unit.text, max);
      continue;
    }
    if (!current && displayWidth(unit.text) > max) {
      let chunk = '';
      for (const cluster of iterateGraphemes(unit.text)) {
        if (chunk && displayWidth(chunk + cluster.text) > max) {
          out.push(pad + chunk);
          chunk = '';
        }
        chunk += cluster.text;
      }
      current = chunk;
      continue;
    }
    flush();
    if (displayWidth(unit.text) <= max) {
      current = unit.text;
      continue;
    }
    let chunk = '';
    for (const cluster of iterateGraphemes(unit.text)) {
      if (chunk && displayWidth(chunk + cluster.text) > max) {
        out.push(pad + chunk);
        chunk = '';
      }
      chunk += cluster.text;
    }
    current = chunk;
  }
  flush();
  return out;
}

/** Full-width horizontal rule. */
export function rule(width: number, char = '─'): string {
  return char.repeat(Math.max(1, width));
}

export { displayWidth };
