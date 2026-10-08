/**
 * Lightweight syntax highlighting for the transcript's fenced code blocks
 * (A10.77). One shared, dependency-free tokenizer: strings, comments,
 * keywords and numbers get a colour; everything else stays plain. It is
 * deliberately NOT a parser — mis-coloring an exotic construct is fine, the
 * text itself never changes.
 *
 * Diff rows keep the sign colour on the row and use this tokenizer for the
 * code body (keywords, comments, strings).
 */
import type { TuiLineRun } from './text.js';

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  ts: new Set(
    'const let var function return if else for while class extends new this typeof instanceof import export from as async await try catch finally throw interface type enum implements public private protected static readonly switch case break continue default do in of void null undefined true false yield delete super'.split(
      ' '
    )
  ),
  js: new Set(
    'const let var function return if else for while class extends new this typeof instanceof import export from as async await try catch finally throw switch case break continue default do in of void null undefined true false yield delete'.split(
      ' '
    )
  ),
  json: new Set(['true', 'false', 'null']),
  py: new Set(
    'def class return if elif else for while import from as with try except finally raise lambda None True False and or not in is pass break continue global nonlocal yield assert async await del'.split(
      ' '
    )
  ),
  sh: new Set(
    'if then else elif fi for do done while case esac function return export local set unset echo cd exit source alias in'.split(
      ' '
    )
  ),
  cpp: new Set(
    'if else for while return class struct enum namespace using template typename const auto new delete public private protected virtual override static void int bool char float double true false nullptr try catch throw include define'.split(
      ' '
    )
  ),
};

/** `​```typescript` / `​```JSX` fold onto the known set ('ts' here) or ''. */
export function normalizeCodeLang(raw: string): string {
  const lang = raw.trim().toLowerCase();
  if (['ts', 'typescript', 'tsx', 'mts', 'cts'].includes(lang)) return 'ts';
  if (['js', 'javascript', 'jsx', 'mjs', 'cjs'].includes(lang)) return 'js';
  if (lang === 'json') return 'json';
  if (['py', 'python'].includes(lang)) return 'py';
  if (['sh', 'bash', 'zsh', 'shell', 'console'].includes(lang)) return 'sh';
  if (['c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hh'].includes(lang)) return 'cpp';
  return '';
}

const COLOR = {
  string: 'green',
  comment: 'gray',
  keyword: 'magenta',
  number: 'yellow',
} as const;

function tokenRegex(hashComment: boolean, preprocessor = false): RegExp {
  // One alternation walked left to right; un-matched spans stay plain.
  const parts = [
    preprocessor ? '#\\s*\\w+' : '',
    hashComment ? '#[^\\n]*' : '//[^\\n]*',
    '"""[\\s\\S]*?"""',
    "'''[\\s\\S]*?'''",
    '"(?:[^"\\\\]|\\\\.)*"',
    "'(?:[^'\\\\]|\\\\.)*'",
    '`(?:[^`\\\\]|\\\\.)*`',
    '\\b\\d[\\d_]*(?:\\.\\d+)?\\b',
    '[A-Za-z_$][\\w$]*',
  ].filter((part) => part.length > 0);
  return new RegExp(parts.join('|'), 'g');
}

/** Color one code line. Returns undefined when nothing matched (plain text). */
export function highlightCodeLine(line: string, lang: string): TuiLineRun[] | undefined {
  if (!KEYWORDS[lang]) return undefined;
  const hashComment = lang === 'py' || lang === 'sh';
  const re = tokenRegex(hashComment, lang === 'cpp');
  const runs: TuiLineRun[] = [];
  let last = 0;
  for (const match of line.matchAll(re)) {
    const text = match[0];
    const start = match.index ?? 0;
    if (start < last) continue;
    let color: TuiLineRun['color'] | undefined;
    if ((hashComment && text.startsWith('#')) || text.startsWith('//')) {
      color = COLOR.comment;
    } else if (text.startsWith('#')) {
      color = 'cyan';
    } else if (/^["'`]/.test(text)) {
      color = COLOR.string;
    } else if (/^\d/.test(text)) {
      color = COLOR.number;
    } else if (KEYWORDS[lang]!.has(text)) {
      color = COLOR.keyword;
    }
    if (color === undefined) continue;
    if (start > last) runs.push({ text: line.slice(last, start) });
    runs.push({ text, color });
    last = start + text.length;
  }
  if (runs.length === 0) return undefined;
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs;
}
