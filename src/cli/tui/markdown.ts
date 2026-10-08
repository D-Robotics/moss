/**
 * Markdown → `TuiLine[]` projection for the CLI shell.
 *
 * The reference CLI (Claude Code, `docs/cli-parity/claude-code-surface.md` §10)
 * renders answers as markdown: the `#` markers disappear, `**bold**` / `*italic*`
 * lose their markers, fenced code is shown as a block, bullet markers are kept.
 * moss keeps the same reading experience inside its own grammar:
 *
 *   - a fenced code block gets a dim frame carrying the language tag, and its
 *     body is NEVER re-wrapped — a folded code line means something different,
 *     so an over-wide line is clipped (with `…`) instead;
 *   - headings are bold with the `#` markers removed;
 *   - `- ` / `1. ` markers are preserved and nested levels are indented;
 *   - inline `` `code` ``, `**bold**` and `*italic*` lose their markers.
 *
 * ONE STYLE PER ROW: the shell renders one `TuiLine` as one ink `<Text>`, so
 * inline emphasis is projected onto the row that contains it — a row with any
 * bold span is bold, a purely-code row gets the code colour, and italics are
 * carried on the line as `italic` for the shell to map to ink's `<Text italic>`.
 * (`_snake_case_` is deliberately NOT treated as emphasis: tool names and paths
 * are full of underscores.)
 *
 * Pure projection: no ink imports, measured in terminal cells via `text.ts`.
 */
import { clip, displayWidth, graphemes, line, padEndTo, type TuiLine } from './text.js';
import type { TuiLineRun } from './text.js';
import { highlightCodeLine, normalizeCodeLang } from './code-style.js';

/**
 * One styled run inside a rendered line. A terminal row can carry several
 * emphasis styles at once (ink renders nested `<Text>` nodes), and the reference
 * styles SPANS, not rows — ``use `x` now`` keeps the code cyan while the prose
 * stays plain (adversarial acceptance D-12). `runs` is therefore the source of
 * truth; `MarkdownLine.text` is the flat text those runs concatenate to.
 *
 * The shape is `text.ts`'s `TuiLineRun`, aliased rather than redeclared so the
 * projection and the renderer can never drift apart.
 */
export type MarkdownRun = TuiLineRun;

export interface MarkdownLine extends TuiLine {
  /**
   * Inline runs in reading order. When present,
   * `runs.map((run) => run.text).join('') === line.text`; the row-level style
   * fields are only a fallback for consumers that ignore runs, and are set only
   * when EVERY run shares that attribute (so a mixed line is not painted whole).
   */
  runs?: MarkdownRun[];
}

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface MarkdownOptions {
  /** Cells of left indent added to every emitted line (default 0). */
  indent?: number;
}

/**
 * Render a partial response without reflowing an open markdown block. Completed
 * blocks use the full renderer; the still-open tail stays plain and stable until
 * a blank line, closing fence, or end-of-response makes its structure certain.
 */
/**
 * Closed markdown prefix of a streaming buffer, plus the still-open tail.
 * A blank line or a closed fence ends a block. The separator blank line is
 * not part of either side.
 */
export function stableMarkdownPrefix(text: string): { stable: string; rest: string } {
  const source = text.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  let fence = false;
  let stableEnd = 0;
  let blockStart = 0;
  let sawContent = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const isFence = FENCE.test(raw);
    if (isFence) {
      fence = !fence;
      sawContent = true;
      if (!fence) {
        stableEnd = index + 1;
        blockStart = stableEnd;
        sawContent = false;
      }
      continue;
    }
    if (!fence && raw.trim() === '' && sawContent) {
      stableEnd = index;
      blockStart = index + 1;
      sawContent = false;
    } else if (raw.trim() !== '') {
      sawContent = true;
    }
  }

  return {
    stable: lines.slice(0, stableEnd).join('\n'),
    rest: lines.slice(blockStart).join('\n'),
  };
}

export function renderStreamingMarkdown(text: string, width: number): MarkdownLine[] {
  const { stable: stableText, rest: openText } = stableMarkdownPrefix(text);
  const committed = stableText ? renderMarkdown(stableText, width) : [];
  if (!openText.trim()) return committed;
  const openLines = openText
    .split('\n')
    .flatMap((lineText) =>
      lineText ? wrapRuns(parseInlineMarkdown(lineText), Math.max(1, width)) : [[]]
    )
    .map((runs) => markdownLine(runs));
  return [...committed, ...openLines];
}

type RunStyle = Omit<MarkdownRun, 'text'>;
/** Row-level style fields (everything `TuiLine` carries except the text). */
type RowStyle = Omit<MarkdownLine, 'text' | 'runs'>;

/** ``` / ~~~ fence with an optional language tag. */
const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

/** Split one line of prose into styled spans (markers removed). */
export function parseInlineMarkdown(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > index) spans.push({ text: text.slice(index, start) });
    const token = match[0];
    if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('**')) spans.push({ text: token.slice(2, -2), bold: true });
    else spans.push({ text: token.slice(1, -1), italic: true });
    index = start + token.length;
  }
  if (index < text.length) spans.push({ text: text.slice(index) });
  return spans.filter((span) => span.text !== '');
}

function styleOf(span: InlineSpan): RunStyle {
  return {
    ...(span.bold ? { bold: true } : {}),
    ...(span.italic ? { italic: true } : {}),
    ...(span.code ? { color: 'cyan' as const } : {}),
  };
}

function sameStyle(left: RunStyle, right: RunStyle): boolean {
  return left.color === right.color && left.bold === right.bold && left.italic === right.italic;
}

function pushRun(runs: MarkdownRun[], text: string, style: RunStyle): void {
  if (text === '') return;
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, style)) {
    last.text += text;
    return;
  }
  runs.push({ text, ...style });
}

function runsText(runs: MarkdownRun[]): string {
  return runs.map((run) => run.text).join('');
}

/** Row-level fallback style: only what EVERY run shares. */
function uniformStyle(runs: MarkdownRun[]): RunStyle {
  const styled = runs.filter((run) => run.text.trim() !== '');
  if (styled.length === 0) return {};
  return {
    ...(styled.every((run) => run.bold) ? { bold: true } : {}),
    ...(styled.every((run) => run.italic) ? { italic: true } : {}),
    ...(styled.every((run) => run.color === 'cyan') ? { color: 'cyan' as const } : {}),
  };
}

function markdownLine(runs: MarkdownRun[], extra: RowStyle = {}): MarkdownLine {
  return { text: runsText(runs), runs, ...uniformStyle(runs), ...extra };
}

interface StyledWord {
  text: string;
  clusters: Array<{ text: string; style: RunStyle }>;
}

/** Whitespace-separated words, each cluster keeping the style of its span. */
function wordsOf(spans: InlineSpan[]): StyledWord[] {
  const words: StyledWord[] = [];
  let current: StyledWord | undefined;
  for (const span of spans) {
    const style = styleOf(span);
    for (const cluster of graphemes(span.text)) {
      if (/^\s+$/.test(cluster.text)) {
        current = undefined;
        continue;
      }
      if (!current) {
        current = { text: '', clusters: [] };
        words.push(current);
      }
      current.text += cluster.text;
      current.clusters.push({ text: cluster.text, style });
    }
  }
  return words;
}

/**
 * Cell-exact greedy wrap that KEEPS inline styles, with a floor of ONE cell.
 *
 * `text.ts`'s `wrap` keeps a 4-cell minimum, which is right for prose but wrong
 * for the small budgets markdown hands it: for a 5-cell pane a `+ ` bullet gets
 * `width - prefix = 3` cells of budget, `wrap` silently returns 4-cell chunks,
 * and the row comes out 6 cells wide (width-audit D-3 class). Clusters come from
 * `text.ts`'s `Intl.Segmenter`, so a VS16/ZWJ cluster is counted as the terminal
 * draws it and is never split. The line TEXT this produces is identical to a
 * plain cell wrap of the same spans — only the styling is carried along.
 */
function wrapRuns(spans: InlineSpan[], width: number): MarkdownRun[][] {
  const max = Math.max(1, Math.trunc(width));
  const out: MarkdownRun[][] = [];
  let current: MarkdownRun[] = [];
  const flush = () => {
    if (current.length > 0) out.push(current);
    current = [];
  };
  for (const word of wordsOf(spans)) {
    const candidate = current.length > 0 ? `${runsText(current)} ${word.text}` : word.text;
    if (displayWidth(candidate) <= max) {
      if (current.length > 0) {
        // A space between two words of the same span stays INSIDE that span's
        // run (`` `npm run build` `` is one cyan run, not three plus gaps).
        const last = current[current.length - 1];
        const next = word.clusters[0]?.style ?? {};
        pushRun(current, ' ', last && sameStyle(last, next) ? next : {});
      }
      for (const cluster of word.clusters) pushRun(current, cluster.text, cluster.style);
      continue;
    }
    flush();
    if (displayWidth(word.text) <= max) {
      for (const cluster of word.clusters) pushRun(current, cluster.text, cluster.style);
      continue;
    }
    let chunk: MarkdownRun[] = [];
    for (const cluster of word.clusters) {
      if (chunk.length > 0 && displayWidth(`${runsText(chunk)}${cluster.text}`) > max) {
        out.push(chunk);
        chunk = [];
      }
      pushRun(chunk, cluster.text, cluster.style);
    }
    current = chunk;
  }
  flush();
  return out;
}

/**
 * Render markdown to shell lines. `width` is the pane body width: every emitted
 * line is clipped to it, so a rendered row can never push the terminal into
 * hard-wrap — including at degenerate 4–5 cell widths.
 */
export function renderMarkdown(
  text: string,
  width: number,
  options: MarkdownOptions = {}
): MarkdownLine[] {
  const indent = Math.max(0, Math.trunc(options.indent ?? 0));
  const body = Math.max(1, width - indent);
  const out: MarkdownLine[] = [];
  const source = text.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const spans = parseInlineMarkdown(paragraph.join(' ').trim());
    for (const runs of wrapRuns(spans, body)) out.push(markdownLine(runs));
    paragraph = [];
  };

  let index = 0;
  while (index < source.length) {
    const raw = source[index] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = FENCE.exec(raw);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      // An UNTERMINATED fence (a streaming answer cut mid-block) still closes
      // its frame, so the rest of the answer is not swallowed as code forever.
      while (index < source.length && !FENCE.test(source[index] ?? '')) {
        code.push(source[index] ?? '');
        index += 1;
      }
      if (index < source.length) index += 1; // consume the closing fence
      pushCodeBlock(out, fence[2] ?? '', code, body);
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading) {
      flushParagraph();
      const spans = parseInlineMarkdown((heading[2] ?? '').trim());
      // A10.75: headings read bold + italic + underlined, like the reference.
      for (const runs of wrapRuns(spans, body))
        out.push(markdownLine(runs, { bold: true, italic: true, underline: true }));
      index += 1;
      continue;
    }

    const bullet = BULLET.exec(raw);
    if (bullet) {
      flushParagraph();
      pushBullet(out, bullet, body);
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(raw)) {
      flushParagraph();
      out.push({ text: '─'.repeat(body), dim: true });
      index += 1;
      continue;
    }

    const quote = BLOCKQUOTE.exec(raw);
    if (quote) {
      flushParagraph();
      const spans = parseInlineMarkdown((quote[1] ?? '').trim());
      for (const runs of wrapRuns(spans, Math.max(1, body - 2))) {
        out.push(markdownLine([{ text: '│ ' }, ...runs], { dim: true }));
      }
      index += 1;
      continue;
    }

    if (isTableStart(source, index)) {
      flushParagraph();
      index = pushTable(out, source, index, body);
      continue;
    }

    // Ordinary prose: consecutive lines are one paragraph (markdown soft-wrap).
    paragraph.push(trimmed);
    index += 1;
  }
  flushParagraph();

  // The guarantee, not a hope: every line is clipped to the pane. The indent
  // pass used to be the only clip, so the un-indented bullet/quote paths could
  // exceed a 4–5 cell pane.
  const pad = indent > 0 ? ' '.repeat(indent) : '';
  const limit = Math.max(1, Math.trunc(width));
  return out.map((entry) => {
    const text = `${pad}${entry.text}`;
    const clipped = clip(text, limit);
    if (clipped === text) {
      // Runs survive untouched only while the line is intact: a clipped line
      // falls back to its row style, because `runs` must concatenate to `text`.
      return entry.runs && pad
        ? { ...entry, text, runs: [{ text: pad }, ...entry.runs] }
        : { ...entry, text };
    }
    return { ...entry, text: clipped, runs: undefined };
  });
}

/** Dim frame + language tag; the body keeps its own line breaks. */
function pushCodeBlock(out: MarkdownLine[], lang: string, code: string[], width: number): void {
  const head = `┌${lang ? ` ${lang} ` : ' '}`;
  out.push({
    text: clip(`${head}${'─'.repeat(Math.max(0, width - displayWidth(head)))}`, width),
    dim: true,
  });
  // Fenced bodies get the shared tokenizer's colours (A10.77); runs are only
  // kept on lines that fit — a clipped line drops them (runs must concatenate
  // back to the line's text).
  const styledLang = normalizeCodeLang(lang);
  for (const raw of code) {
    const body = raw.replace(/\t/g, '  ');
    const text = clip(`│ ${body}`, width);
    const runs =
      text === `│ ${body}` && styledLang ? highlightCodeLine(body, styledLang) : undefined;
    out.push(runs ? { text, runs: [{ text: '│ ' }, ...runs] } : { text });
  }
  out.push({ text: clip(`└${'─'.repeat(Math.max(0, width - 1))}`, width), dim: true });
}

function pushBullet(out: MarkdownLine[], bullet: RegExpExecArray, width: number): void {
  const lead = bullet[1] ?? '';
  const marker = bullet[2] ?? '-';
  const text = bullet[3] ?? '';
  // Two cells per nesting level: deep lists degrade to a readable indent
  // instead of running off the right edge.
  const depth = Math.min(4, Math.floor(displayWidth(lead.replace(/\t/g, '  ')) / 2));
  const prefix = `${'  '.repeat(depth)}${marker} `;
  const spans = parseInlineMarkdown(text);
  const wrapped = wrapRuns(spans, Math.max(1, width - displayWidth(prefix)));
  wrapped.forEach((runs, lineIndex) => {
    // Continuations are spaces, not the marker: `- ` stays a first-line glyph.
    const head = lineIndex === 0 ? prefix : ' '.repeat(displayWidth(prefix));
    out.push(markdownLine([{ text: head }, ...runs]));
  });
}

function isTableStart(lines: string[], index: number): boolean {
  const row = lines[index];
  const separator = lines[index + 1];
  if (!row || !separator) return false;
  return TABLE_ROW.test(row) && TABLE_SEPARATOR.test(separator) && separator.includes('-');
}

function tableCells(raw: string): string[] {
  return raw
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Reference §10: a real box-drawing table with a centred header row. */
function pushTable(out: MarkdownLine[], lines: string[], start: number, width: number): number {
  const header = tableCells(lines[start] ?? '');
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && TABLE_ROW.test(lines[index] ?? '')) {
    rows.push(tableCells(lines[index] ?? ''));
    index += 1;
  }
  const columns = Math.max(1, header.length);
  // 1 border + 3 cells of padding per column must fit the pane. The floor is one
  // cell: a 4–5 cell pane cannot afford four, and every row is clipped anyway.
  const cap = Math.max(1, Math.floor((width - 1 - 3 * columns) / columns));
  const widths = header.map((cell, columnIndex) => {
    const cells = [cell, ...rows.map((row) => row[columnIndex] ?? '')];
    const needed = Math.max(1, ...cells.map((value) => displayWidth(value)));
    return Math.min(needed, cap);
  });

  const border = (left: string, mid: string, right: string): string =>
    clip(`${left}${widths.map((value) => '─'.repeat(value + 2)).join(mid)}${right}`, width);
  const rowLine = (cells: string[], centre: boolean): string =>
    clip(
      `│${widths
        .map((value, columnIndex) => {
          const raw = cells[columnIndex] ?? '';
          // Only clip when the cell really is wider: `clip` trades a 1-cell
          // budget for `…`, which would eat a column that actually fits.
          const cell = displayWidth(raw) > value ? clip(raw, value) : raw;
          const padded = centre
            ? `${padEndTo('', Math.floor((value - displayWidth(cell)) / 2))}${cell}`
            : cell;
          return ` ${padEndTo(padded, value)} `;
        })
        .join('│')}│`,
      width
    );

  out.push(line(border('┌', '┬', '┐'), { dim: true }));
  out.push(line(rowLine(header, true), { bold: true }));
  out.push(line(border('├', '┼', '┤'), { dim: true }));
  rows.forEach((cells, rowIndex) => {
    out.push(line(rowLine(cells, false)));
    if (rowIndex < rows.length - 1) out.push(line(border('├', '┼', '┤'), { dim: true }));
  });
  out.push(line(border('└', '┴', '┘'), { dim: true }));
  return index;
}
