/**
 * Syntax highlighting — ported from Pi's `utils/syntax-highlight.ts` (v0.80.3).
 *
 * Uses `highlight.js` to tokenize code, then maps the token scopes to ANSI
 * colors via a theme. moss previously rendered ALL code blocks as `ui.dim`
 * (uniformly dimmed) — no syntax coloring. This is the single biggest UX gap
 * for a coding agent: code blocks in LLM output now have proper syntax colors
 * (keywords, strings, comments, numbers, functions, etc.).
 *
 * `picocolors` auto-detects NO_COLOR / non-TTY and disables colors — safe for
 * CI / piped output.
 */
import hljs from 'highlight.js';
import pc from 'picocolors';

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
  language?: string;
  ignoreIllegals?: boolean;
  languageSubset?: string[];
  theme?: HighlightTheme;
}

const SPAN_CLOSE = '</span>';
const HIGHLIGHT_CLASS_PREFIX = 'hljs-';

// ── Theme: hljs scope → ANSI formatter ─────────────────────────────────────
const DEFAULT_THEME: HighlightTheme = {
  keyword: pc.magenta,
  'keyword.type': pc.magenta,
  'keyword.operator': pc.magenta,
  built_in: pc.cyan,
  literal: pc.cyan,
  number: pc.green,
  string: pc.green,
  'string.regexp': pc.green,
  comment: pc.gray,
  function: pc.yellow,
  'function.title': pc.yellow,
  title: pc.yellow,
  class: pc.yellow,
  'class.title': pc.yellow,
  attr: pc.yellow,
  variable: pc.blue,
  'variable.language': pc.blue,
  property: pc.blue,
  params: pc.cyan,
  meta: pc.gray,
  operator: pc.gray,
  punctuation: pc.gray,
  doctag: pc.gray,
  default: (s) => s,
};

function getScopeFromSpanTag(tag: string): string | undefined {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const classValue = match?.[1] ?? match?.[2];
  if (!classValue) return undefined;
  for (const className of classValue.split(/\s+/)) {
    if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
      return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
    }
  }
  return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
  const exact = theme[scope];
  if (exact) return exact;
  const dotIndex = scope.indexOf('.');
  if (dotIndex !== -1) {
    const prefix = theme[scope.slice(0, dotIndex)];
    if (prefix) return prefix;
  }
  const dashIndex = scope.indexOf('-');
  if (dashIndex !== -1) {
    const prefix = theme[scope.slice(0, dashIndex)];
    if (prefix) return prefix;
  }
  return undefined;
}

function getActiveFormatter(
  scopes: Array<string | undefined>,
  theme: HighlightTheme,
): HighlightFormatter | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope) continue;
    const formatter = getScopeFormatter(scope, theme);
    if (formatter) return formatter;
  }
  return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
  if (!html.startsWith('<span', index)) return false;
  const nextChar = html[index + '<span'.length];
  return nextChar === '>' || nextChar === ' ' || nextChar === '\t' || nextChar === '\n' || nextChar === '\r';
}

// Minimal HTML entity decoder (port of Pi's decodeHtmlEntityAt).
const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};
function decodeHtmlEntityAt(html: string, index: number): { text: string; length: number } | null {
  const semi = html.indexOf(';', index);
  if (semi === -1 || semi - index > 10) return null;
  const body = html.slice(index + 1, semi); // after '&'
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try { return { text: String.fromCodePoint(code), length: semi - index + 1 }; } catch { return null; }
    }
    return null;
  }
  const decoded = HTML_ENTITIES[body];
  if (decoded !== undefined) return { text: decoded, length: semi - index + 1 };
  return null;
}

function renderHighlightedHtml(html: string, theme: HighlightTheme): string {
  let output = '';
  let textBuffer = '';
  const scopes: Array<string | undefined> = [];

  const flushText = () => {
    if (!textBuffer) return;
    const formatter = getActiveFormatter(scopes, theme);
    output += formatter ? formatter(textBuffer) : textBuffer;
    textBuffer = '';
  };

  let index = 0;
  while (index < html.length) {
    if (isSpanOpenTagStart(html, index)) {
      const tagEndIndex = html.indexOf('>', index + 5);
      if (tagEndIndex !== -1) {
        flushText();
        const tag = html.slice(index, tagEndIndex + 1);
        scopes.push(getScopeFromSpanTag(tag));
        index = tagEndIndex + 1;
        continue;
      }
    }
    if (html.startsWith(SPAN_CLOSE, index)) {
      flushText();
      if (scopes.length > 0) scopes.pop();
      index += SPAN_CLOSE.length;
      continue;
    }
    if (html[index] === '&') {
      const decoded = decodeHtmlEntityAt(html, index);
      if (decoded) {
        textBuffer += decoded.text;
        index += decoded.length;
        continue;
      }
    }
    textBuffer += html[index];
    index++;
  }
  flushText();
  return output;
}

/**
 * Highlight code with syntax colors. Returns ANSI-colored string.
 * If `language` is specified, uses that; otherwise auto-detects.
 */
export function highlight(code: string, options: HighlightOptions = {}): string {
  const theme = options.theme ?? DEFAULT_THEME;
  // Validate language exists before highlighting — hljs.highlight throws on
  // unknown languages. Fall back to auto-detect if the language is not found.
  const lang = options.language && hljs.getLanguage(options.language)
    ? options.language
    : undefined;
  const html = lang
    ? hljs.highlight(code, { language: lang, ignoreIllegals: options.ignoreIllegals }).value
    : hljs.highlightAuto(code, options.languageSubset).value;
  // highlightAuto can return empty HTML when no language matches — fall back
  // to the original code rather than rendering an empty string.
  if (!lang && !html) return code;
  return renderHighlightedHtml(html, theme);
}

/** Check if a language is supported by highlight.js. */
export function supportsLanguage(name: string): boolean {
  return hljs.getLanguage(name) !== undefined;
}
