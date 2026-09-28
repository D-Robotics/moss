import stringWidth from 'string-width';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { highlight } from '../utils/syntax-highlight.js';
import {
  ANSI_RE,
  CONTROL_CHAR_RE,
  COPY_SENSITIVE_TOKEN_RE,
  sanitizeRenderableText,
  sanitizeTextForTerminal,
} from './terminal-text.js';

export const DEFAULT_MARKDOWN_TABLE_WIDTH = 96;
export const MIN_MARKDOWN_TABLE_WIDTH = 40;
export const MAX_MARKDOWN_TABLE_WIDTH = 160;
export const MARKDOWN_TABLE_CELL = '\u001F';
export const MARKDOWN_TABLE_ROW = '\u001E';

let markdownRendererConfigured = false;
let activeMarkdownRenderWidth: number | undefined;

export function resolveMarkdownTableWidth(): number {
  const rawWidth =
    activeMarkdownRenderWidth ?? process.stdout.columns ?? DEFAULT_MARKDOWN_TABLE_WIDTH;
  // Transcript lines are indented by Ink and still need one spare column to
  // avoid the terminal's automatic wrap at the right edge. Rendering against
  // the full TTY width made table dividers spill onto a second line at 80 cols.
  const width = Number.isFinite(rawWidth) ? Math.floor(rawWidth) - 3 : DEFAULT_MARKDOWN_TABLE_WIDTH;
  return Math.max(MIN_MARKDOWN_TABLE_WIDTH, Math.min(MAX_MARKDOWN_TABLE_WIDTH, width));
}

export function markdownTableCellText(content: unknown, context: unknown): string {
  if (content && typeof content === 'object') {
    const maybeTokens = (content as { tokens?: unknown[] }).tokens;
    const parser = (context as { parser?: { parseInline?: (tokens: unknown[]) => string } }).parser;
    if (Array.isArray(maybeTokens) && typeof parser?.parseInline === 'function') {
      return parser.parseInline(maybeTokens);
    }
    if ('text' in content) {
      const raw = String((content as { text?: unknown }).text ?? '');
      // Decode basic HTML entities that marked inserts during parsing
      return raw
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
    }
  }
  return String(content ?? '');
}

export function markdownTableTokenRows(content: unknown, context: unknown): string {
  if (!Array.isArray(content)) return '';
  const rows = Array.isArray(content[0]) ? content : [content];
  return rows
    .map((row) => {
      if (!Array.isArray(row)) return '';
      const cells = row.map(
        (cell) => `${markdownTableCellText(cell, context)}${MARKDOWN_TABLE_CELL}`
      );
      return `${MARKDOWN_TABLE_ROW}${cells.join('')}${MARKDOWN_TABLE_ROW}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function renderMarkdownTableFromRendererArgs(args: unknown[], context: unknown): string {
  const [first, second] = args;
  if (args.length === 1 && first && typeof first === 'object') {
    const token = first as { header?: unknown; rows?: unknown };
    if ('header' in token || 'rows' in token) {
      return renderTerminalFriendlyMarkdownTable(
        markdownTableTokenRows(token.header, context),
        markdownTableTokenRows(token.rows, context)
      );
    }
  }
  return renderTerminalFriendlyMarkdownTable(String(first ?? ''), String(second ?? ''));
}

export function cleanMarkdownTableCell(cell: string): string {
  const withoutAnsi = cell.includes('\x1B') ? cell.replace(ANSI_RE, '') : cell;
  const withoutControls = CONTROL_CHAR_RE.test(withoutAnsi)
    ? withoutAnsi.replace(CONTROL_CHAR_RE, '').trim()
    : withoutAnsi.trim();
  // Decode HTML entities that marked inserts during parsing
  return withoutControls
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function splitMarkdownTableRows(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const unwrapped = line.split(MARKDOWN_TABLE_ROW).join('');
      const cells = unwrapped.split(MARKDOWN_TABLE_CELL);
      if (cells[cells.length - 1] === '') cells.pop();
      return cells.map(cleanMarkdownTableCell);
    })
    .filter((row) => row.length > 0);
}

export function splitWideWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of Array.from(word)) {
    const next = `${current}${char}`;
    if (current && stringWidth(next) > width) {
      parts.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function wrapMarkdownTableCell(value: string, width: number): string[] {
  const text = value.replace(/、\s*/g, '、 ').replace(/\s+/g, ' ').trim();
  if (!text) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    const pieceWidth = COPY_SENSITIVE_TOKEN_RE.test(word) ? width : Math.min(width, 32);
    const pieces = stringWidth(word) > pieceWidth ? splitWideWord(word, pieceWidth) : [word];
    for (const piece of pieces) {
      if (!current) {
        current = piece;
      } else if (stringWidth(`${current} ${piece}`) <= width) {
        current = `${current} ${piece}`;
      } else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export function padMarkdownTableCell(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`;
}

export function markdownTableColumnWidths(rows: string[][], tableWidth: number): number[] {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const separatorWidth = Math.max(0, columnCount - 1) * 3;
  const available = Math.max(columnCount * 3, tableWidth - separatorWidth);
  const fairWidth = Math.max(3, Math.floor(available / columnCount));
  const desired = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...rows.map((row) => stringWidth(row[index] ?? '')))
  );
  const widths = desired.map((width) => Math.min(width, fairWidth));
  let remaining = available - widths.reduce((sum, width) => sum + width, 0);

  while (remaining > 0) {
    let bestIndex = -1;
    let bestDeficit = 0;
    for (let index = 0; index < desired.length; index += 1) {
      const deficit = desired[index] - widths[index];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    widths[bestIndex] += 1;
    remaining -= 1;
  }

  return widths;
}

export function renderMarkdownTableRows(rows: string[][], widths: number[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const wrapped = widths.map((width, index) => wrapMarkdownTableCell(row[index] ?? '', width));
    const rowHeight = Math.max(1, ...wrapped.map((cell) => cell.length));
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex += 1) {
      lines.push(
        widths
          .map((width, columnIndex) =>
            padMarkdownTableCell(wrapped[columnIndex][lineIndex] ?? '', width)
          )
          .join(' | ')
          .trimEnd()
      );
    }
  }
  return lines;
}

export function shouldStackMarkdownTable(rows: string[][], tableWidth: number): boolean {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  if (columnCount < 3) return false;
  const separatorWidth = Math.max(0, columnCount - 1) * 3;
  const fairWidth = Math.floor((tableWidth - separatorWidth) / columnCount);
  const hasVerboseCell = rows.some((row) =>
    row.some((cell) => stringWidth(cell) > fairWidth * 1.5)
  );
  return fairWidth < 18 || (tableWidth <= 90 && hasVerboseCell);
}

export function renderStackedMarkdownTable(header: string[], rows: string[][]): string {
  return (
    rows
      .map((row, rowIndex) => {
        const title = row[0]?.trim() || `Row ${rowIndex + 1}`;
        const fields = header
          .slice(1)
          .map(
            (label, columnIndex) =>
              `   ${label || `Column ${columnIndex + 2}`}： ${row[columnIndex + 1] ?? ''}`
          );
        return [`${rowIndex + 1}. ${title}`, ...fields].join('\n');
      })
      .join('\n\n') + '\n\n'
  );
}

export function renderTerminalFriendlyMarkdownTable(headerText: string, bodyText: string): string {
  const headerRows = splitMarkdownTableRows(headerText);
  const bodyRows = splitMarkdownTableRows(bodyText);
  const rows = [...headerRows, ...bodyRows];
  if (rows.length === 0) return '';

  const tableWidth = resolveMarkdownTableWidth();
  if (
    headerRows.length === 1 &&
    bodyRows.length > 0 &&
    shouldStackMarkdownTable(rows, tableWidth)
  ) {
    return renderStackedMarkdownTable(headerRows[0], bodyRows);
  }
  const widths = markdownTableColumnWidths(rows, tableWidth);
  const separator = widths.map((width) => '─'.repeat(width)).join('─┼─');
  return (
    [
      ...renderMarkdownTableRows(headerRows, widths),
      separator,
      ...renderMarkdownTableRows(bodyRows, widths),
    ].join('\n') + '\n\n'
  );
}

export function ensureMarkdownRenderer(): void {
  if (markdownRendererConfigured) return;
  marked.setOptions({ mangle: false, headerIds: false } as Parameters<typeof marked.setOptions>[0]);
  // marked-terminal's runtime extension shape is valid for marked.use(), but
  // its current .d.ts does not model the MarkedExtension intersection.
  // Tone down the default colors so the outer theme drives accent — code/quote
  // become dim, headings keep bold so they remain scannable.
  // Use direct ANSI cyan for codespan (inline `code`) — ui.cyan uses picocolors
  // which gates on stdout.isTTY, but Ink intercepts stdout so it's always false.
  const { env: _pe } = process;
  const _ansiEnabled =
    !_pe.NO_COLOR &&
    (!!_pe.FORCE_COLOR ||
      !!_pe.COLORTERM ||
      Boolean((process.stdout as NodeJS.WriteStream).isTTY) ||
      Boolean((process.stderr as NodeJS.WriteStream).isTTY));
  const _cyanAnsi = _ansiEnabled ? (s: string) => `\x1b[36m${s}\x1b[39m` : (s: string) => s;
  // dim gray for blockquotes — also uses direct ANSI so it works in Ink TUI
  const _dimAnsi = _ansiEnabled ? (s: string) => `\x1b[2m${s}\x1b[22m` : (s: string) => s;

  const terminalMarkdown = markedTerminal({
    reflowText: false,
    // `code` option here is only used as a FALLBACK by marked-terminal when
    // cli-highlight throws — it is NOT the primary code renderer. We override
    // terminalRenderer.code below with our own highlight.js implementation.
    blockquote: _dimAnsi,
    codespan: _cyanAnsi,
    // Override paragraph to identity — avoids chalk.reset() wrap which emits
    // \x1b[0m...\x1b[0m and clears the parent Ink <Text color={theme.text}>.
    // NOTE: marked-terminal's paragraph function still calls parseInline(tokens)
    // BEFORE this transform, so HTML entities (&#39; etc.) are decoded correctly.
    paragraph: (s: string) => s,
  }) as unknown as Parameters<typeof marked.use>[0] & {
    renderer: Record<string, (this: unknown, ...args: unknown[]) => string>;
  };
  const terminalRenderer = terminalMarkdown.renderer as Record<
    string,
    (this: unknown, ...args: unknown[]) => string
  >;

  // Override code block renderer to use our highlight.js implementation.
  // marked-terminal's internal `Renderer.prototype.code` delegates to
  // cli-highlight which does its own chalk-based TTY detection — bypassing
  // our ANSI color setup. By replacing the renderer method here we ensure
  // highlight() (with direct ANSI codes, not picocolors) is always used.
  terminalRenderer.code = function code(token: unknown): string {
    // marked v3+ passes a token object: { raw, text, lang }
    // Older versions pass (text, lang, escaped) as separate args.
    let codeText: string;
    let lang: string | undefined;
    if (token && typeof token === 'object' && 'text' in (token as object)) {
      const t = token as { text: string; lang?: string };
      codeText = t.text;
      lang = t.lang || undefined;
    } else {
      codeText = String(token);
    }
    try {
      const highlighted = highlight(codeText, { language: lang });
      // Add a left border bar (┃) to visually separate the code block from
      // surrounding prose — a lightweight version of CC's code block styling.
      const border = '\x1b[90m┃\x1b[39m '; // dim gray bar
      const lines = highlighted.split('\n');
      return lines.map((l) => `${border}${l}`).join('\n') + '\n\n';
    } catch {
      const border = '\x1b[90m┃\x1b[39m ';
      return (
        codeText
          .split('\n')
          .map((l) => `${border}${l}`)
          .join('\n') + '\n\n'
      );
    }
  };

  // Headings inherit the terminal foreground color. Hard-coding bright white
  // (`ANSI 97`) makes headings nearly invisible on light terminals; weight and
  // spacing provide the hierarchy without assuming a background color.
  terminalRenderer.heading = function heading(token: unknown): string {
    let text = '';
    if (token && typeof token === 'object') {
      const t = token as { text?: string };
      text = t.text ?? '';
    } else {
      text = String(token);
    }
    const formatted = `\x1b[1m${text}\x1b[22m`;
    return `\n${formatted}\n\n`;
  };

  // Override hr to render as a short dim separator instead of marked-terminal's
  // default full-width chalk.gray(new Array(cols).join('-')) which fills the
  // entire terminal width with dashes and is visually overwhelming.
  terminalRenderer.hr = function hr(): string {
    return `\n\x1b[2m${'─'.repeat(32)}\x1b[22m\n\n`;
  };

  // NOTE: Do NOT override paragraph. marked-terminal's default paragraph
  // renderer uses chalk.reset() which wraps text in \x1b[0m...\x1b[0m and
  // also decodes HTML entities (&#39; → ', &amp; → &, etc.) that marked
  // produces during parsing. Without the chalk wrapper, entities like &#39;
  // appear literally in the output, breaking apostrophes and quotes.

  // Lists use marked-terminal's native rendering ("* item", numbered ordered
  // lists, correct nesting). Do NOT try to swap the bullet glyph: a `listitem`
  // OPTION is a style hook applied INSIDE the default "* " prefix (the old
  // double-bullet bug, "*   • item"), and rewriting at the list/listitem
  // renderer level breaks ordered numbering or nested-list line structure
  // because outer lists re-process inner lists' already-rendered text.
  terminalRenderer.tablecell = function tablecell(content: unknown) {
    return `${markdownTableCellText(content, this)}${MARKDOWN_TABLE_CELL}`;
  };
  terminalRenderer.tablerow = function tablerow(content: unknown) {
    const text = markdownTableCellText(content, this);
    return `${MARKDOWN_TABLE_ROW}${text}${MARKDOWN_TABLE_ROW}\n`;
  };
  terminalRenderer.table = function table(...args: unknown[]) {
    return renderMarkdownTableFromRendererArgs(args, this);
  };
  marked.use(terminalMarkdown);
  markdownRendererConfigured = true;
}

export function renderMarkdown(text: string, options: { width?: number } = {}): string {
  ensureMarkdownRenderer();
  const previousWidth = activeMarkdownRenderWidth;
  activeMarkdownRenderWidth = options.width;
  try {
    // Sanitize the INPUT markdown source (LLM text) to strip ANSI escape
    // injections. Use breakLongTokens: false to preserve markdown syntax —
    // breakLongTokens inserts spaces every 24 chars which corrupts long URLs
    // like [text](https://long-url) and long inline `code` spans.
    // The output is NOT sanitized so code block syntax colors survive.
    const sanitizedInput = sanitizeTextForTerminal(text, { breakLongTokens: false });
    return (marked.parse(sanitizedInput) as string).trimEnd();
  } finally {
    activeMarkdownRenderWidth = previousWidth;
  }
}

/**
 * Render markdown for streaming (in-progress) text.
 *
 * Strategy: split the text at code block boundaries. Complete code blocks
 * (opened AND closed with three-backtick fences) are syntax-highlighted via renderMarkdown.
 * The incomplete trailing portion (no closing fence) is shown as raw text so
 * the streaming cursor stays at the natural insertion point rather than
 * disappearing mid-fence.
 *
 * This makes code visible with colors as soon as a block is complete, instead
 * of waiting for the full message to finalize.
 */
export function renderStreamingMarkdown(text: string): string {
  // Split at complete fenced code blocks. A "complete" block has both an
  // opening ``` (optionally with a language) and a closing ```.
  // Strategy: find the last un-matched ``` and split there.
  const fenceRe = /^```/gm;
  let fenceCount = 0;
  let lastUnclosedFence = -1;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    fenceCount++;
    if (fenceCount % 2 === 1) {
      // Opening fence
      lastUnclosedFence = match.index;
    } else {
      // Closing fence — clear the marker
      lastUnclosedFence = -1;
    }
  }

  if (lastUnclosedFence === -1) {
    // All code blocks are complete — render the full text with markdown.
    try {
      return renderMarkdown(text);
    } catch {
      return sanitizeRenderableText(text);
    }
  }

  // There's an unclosed code block. Split: render everything before the
  // unclosed fence with full markdown, then show the tail as raw text.
  const completed = text.slice(0, lastUnclosedFence);
  const streaming = text.slice(lastUnclosedFence);

  const renderedPrefix = completed
    ? (() => {
        try {
          return renderMarkdown(completed);
        } catch {
          return sanitizeRenderableText(completed);
        }
      })()
    : '';

  // Show the streaming code block as dim raw text (no colors yet — block is
  // incomplete). Strip the fence marker for readability during streaming.
  const rawCode = sanitizeRenderableText(streaming);

  return renderedPrefix ? `${renderedPrefix}\n${rawCode}` : rawCode;
}
